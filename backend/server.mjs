#!/usr/bin/env node
/**
 * GODOT ACP Backend — zentrale Steuerungsebene, unabhängig von Godot.
 *
 * Verantwortlichkeiten (eine Ebene über dem Godot-Addon):
 *  - Target-State: Die Wahrheit "läuft Godot?" lebt HIER. Godot meldet sich
 *    als TCP-Client an (MCP-Protokoll). Ist es weg, weiß das Backend es.
 *  - Command-Bus: Jede Aktion ist ein Command { id, origin: human|system|agent,
 *    type, payload, state }. Der Agent läuft als MCP-Client GEGEN DEN PROXY —
 *    das Backend kann jeden Call pausieren, blockieren oder annotieren.
 *    Einfluss ohne Agent-Chat = Systemzustand ändern, nicht reden.
 *  - Session-State: agent.session (goal/state/current action/user controls).
 *  - Live-Events über SSE (/api/events), Historie als JSONL (user-data/).
 *
 * Start: node server.mjs  (ENV: ACP_BACKEND_PORT=8787, ACP_GODOT_PORT=9090)
 * Layout: Godot MCP :9090 ← Backend(:8787 proxy :9099) ← Agent / Dashboard
 */

import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BACKEND_PORT = Number(process.env.ACP_BACKEND_PORT || 8787);
const GODOT_PORT = Number(process.env.ACP_GODOT_PORT || 9090);
const PROXY_PORT = Number(process.env.ACP_PROXY_PORT || 9099);
const DATA_DIR = process.env.ACP_DATA_DIR || path.join(os.homedir(), ".godot-acp");
const WEB_DIST = path.join(__dirname, "web", "dist");

fs.mkdirSync(DATA_DIR, { recursive: true });
const EVENTS_LOG = path.join(DATA_DIR, "events.jsonl");
const COMMANDS_LOG = path.join(DATA_DIR, "commands.jsonl");

/* ────────────────────────── State (die zentrale Wahrheit) ───────────── */

const state = {
  startedAt: Date.now(),
  /** Target = die Godot-Instanz. LEBT HIER, nicht in Godot. */
  target: {
    connected: false,          // TCP-Verbindung zum Godot-MCP
    state: "OFFLINE",          // OFFLINE | CONNECTING | CONNECTED | DEGRADED | RECONNECTING
    lastSeenAt: null,
    lastError: null,
    host: "127.0.0.1",
    port: GODOT_PORT,
  },
  /** Agent-Session-State (mehr als Telemetrie: steuerbar). */
  agent: {
    connected: false,          // hat ein Agent-Client eine Proxy-Verbindung?
    session: {
      state: "IDLE",           // IDLE | RUNNING | PAUSE_REQUESTED | PAUSED | STOP_REQUESTED
      goal: "",
      currentAction: "",
      startedAt: null,
      controlsEnabled: true,   // Nutzer-Steuerung global an/aus (Aufsichtspflicht)
    },
  },
  /** Command-Bus. origin: human | system | agent */
  commands: [],
  /** Live-Feed (ring buffer, wird zusätzlich als JSONL persistiert). */
  events: [],
  blockedTools: new Set(),     // vom Nutzer blockierte Tools (z. B. runtime_eval)
  approvals: new Map(),        // pending approval: tool -> {resolve, requestedAt}
  stats: { callsOk: 0, callsBlocked: 0, callsDenied: 0, callsTotal: 0 },
};

const MAX_EVENTS = 500;
const MAX_COMMANDS = 200;

function pushEvent(kind, message, meta = {}) {
  const ev = { ts: Date.now(), kind, message, ...meta };
  state.events.push(ev);
  if (state.events.length > MAX_EVENTS) state.events.shift();
  try {
    fs.appendFileSync(EVENTS_LOG, JSON.stringify(ev) + "\n");
  } catch { /* Persistenz darf niemals den Betrieb blockieren */ }
  broadcast({ type: "event", event: ev });
  return ev;
}

function recordCommand(cmd) {
  state.commands.push(cmd);
  if (state.commands.length > MAX_COMMANDS) state.commands.shift();
  try {
    fs.appendFileSync(COMMANDS_LOG, JSON.stringify(cmd) + "\n");
  } catch { /* ignore */ }
  broadcast({ type: "command", command: cmd });
}

/* ───────────────────────────── Command-Bus ──────────────────────────── */

let commandSeq = 0;
function issueCommand(type, payload, origin) {
  const cmd = {
    id: `cmd_${Date.now()}_${++commandSeq}`,
    origin, type, payload,
    state: "completed",
    createdAt: Date.now(),
  };
  switch (type) {
    case "session.pause":
      state.agent.session.state = "PAUSED";
      break;
    case "session.resume":
      state.agent.session.state = "RUNNING";
      break;
    case "session.stop":
      state.agent.session.state = "STOP_REQUESTED";
      break;
    case "session.goal":
      state.agent.session.goal = String(payload.goal ?? "");
      if (state.agent.session.state === "IDLE" && state.agent.session.goal) {
        state.agent.session.state = "RUNNING";
        state.agent.session.startedAt = Date.now();
      }
      break;
    case "session.controls":
      state.agent.session.controlsEnabled = !!payload.enabled;
      break;
    case "tools.block":
      for (const t of payload.tools ?? []) state.blockedTools.add(String(t));
      break;
    case "tools.unblock":
      for (const t of payload.tools ?? []) state.blockedTools.delete(String(t));
      break;
    case "godot.reconnect":
      connectGodot();
      break;
    default:
      cmd.state = "rejected";
      cmd.error = `unbekannter Command-Typ: ${type}`;
  }
  recordCommand(cmd);
  pushEvent("command", `${origin}: ${type}`, { commandId: cmd.id, state: cmd.state });
  return cmd;
}

/* ────────────────────── MCP-Protokoll-Mini-Client ───────────────────── */

/** framed JSON-RPC lines an eine (Gast-)Verbindung. */
function writeMsg(socket, obj) {
  try {
    socket.write(JSON.stringify(obj) + "\n");
  } catch { /* ignore */ }
}

/** Einmalige RPC-Anfrage an Godot (z. B. tools/list für die Blocklisten-Auswahl). */
let rpcSeq = 0;
const pendingRpc = new Map();
function rpcGodot(method, params) {
  return new Promise((resolve, reject) => {
    if (!godotSocket || !state.target.connected) return reject(new Error("Godot nicht verbunden"));
    const id = `acp-rpc-${++rpcSeq}`;
    pendingRpc.set(id, resolve);
    writeMsg(godotSocket, { jsonrpc: "2.0", id, method, params: params ?? {} });
    setTimeout(() => {
      if (pendingRpc.has(id)) { pendingRpc.delete(id); reject(new Error("Timeout")); }
    }, 5000);
  });
}

/**
 * Godot-Connector: persistente Verbindung zum Godot-MCP (Target).
 * Liveness über periodische MCP-pings — der Backend kennt den Target-Zustand
 * auch dann, wenn Godot nichts mehr antwortet (Timeout => DEGRADED).
 */
let godotSocket = null;
let godotPingTimer = null;
let godotPingPending = false;

/** id -> { sock, tool? } — wartende Anfragen der Agent-Sockets. */
const pendingRequests = new Map();

function connectGodot() {
  if (godotSocket) { try { godotSocket.destroy(); } catch { /* ignore */ } }
  state.target.state = "CONNECTING";
  broadcastState();

  const sock = net.connect(state.target.port, state.target.host);
  godotSocket = sock;

  sock.on("connect", () => {
    state.target.connected = true;
    state.target.state = "CONNECTED";
    state.target.lastSeenAt = Date.now();
    state.target.lastError = null;
    pushEvent("target", "Godot-MCP verbunden", { host: state.target.host, port: state.target.port });
    if (!godotPingTimer) {
      godotPingTimer = setInterval(pingGodot, 5000);
    }
    broadcastState();
  });

  let buffer = "";
  sock.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      state.target.lastSeenAt = Date.now();
      try {
        const msg = JSON.parse(line);
        if (msg.id === "acp-ping") {
          godotPingPending = false;
          if (state.target.state === "DEGRADED") {
            state.target.state = "CONNECTED";
            broadcastState();
          }
          continue;
        }
        // Antwort auf eine Agent-Anfrage? Dann zurückrouten — der Agent
        // spricht mit dem Proxy und kennt Godot nicht direkt.
        const key = String(msg.id);
        if (pendingRpc.has(key)) {
          const resolve = pendingRpc.get(key);
          pendingRpc.delete(key);
          resolve(msg);
          continue;
        }
        if (pendingRequests.has(key)) {
          const pending = pendingRequests.get(key);
          pendingRequests.delete(key);
          writeMsg(pending.sock, msg);
          if (pending.tool) {
            state.agent.session.currentAction = "";
            pushEvent("agent_result", `${pending.tool}: ${msg.error ? "Fehler" : "ok"}`, {
              tool: pending.tool,
              ok: !msg.error,
            });
            broadcastState();
          }
        }
      } catch { /* kein JSON? egal — Leben zeichnet sich ab */ }
    }
  });

  sock.on("error", (err) => {
    state.target.lastError = String(err.message || err);
  });

  sock.on("close", () => {
    godotSocket = null;
    clearInterval(godotPingTimer);
    godotPingTimer = null;
    state.target.connected = false;
    state.target.state = "RECONNECTING";
    pushEvent("target", "Godot-MCP getrennt — Reconnect läuft", { lastError: state.target.lastError });
    broadcastState();
    setTimeout(connectGodot, 3000);
  });
}

function pingGodot() {
  if (!godotSocket || godotPingPending) return;
  godotPingPending = true;
  writeMsg(godotSocket, { jsonrpc: "2.0", id: "acp-ping", method: "ping", params: {} });
  setTimeout(() => {
    if (godotPingPending && state.target.connected) {
      state.target.state = "DEGRADED";
      godotPingPending = false;
      pushEvent("target", "Godot-MCP antwortet nicht (DEGRADED)");
      broadcastState();
    }
  }, 2500);
}

/* ───────────────────── Agent-Proxy (Control Plane) ──────────────────── */

/**
 * Der Agent verbindet sich auf PROXY_PORT und glaubt, er spreche mit dem
 * Godot-MCP. Tatsächlich entscheidet das Backend je Call:
 *   paused?        -> DENY mit Hinweis (Nutzer hat pausiert)
 *   blocked?       -> DENY (Nutzer hat dieses Tool blockiert)
 *   approval-pflichtig -> WAITING (bis der Nutzer im Dashboard freigibt)
 *   sonst          -> Durchleitung an Godot (falls verbunden)
 */
function handleAgentConnection(agentSock) {
  state.agent.connected = true;
  if (state.agent.session.state === "IDLE") {
    state.agent.session.state = "RUNNING";
    state.agent.session.startedAt = Date.now();
  }
  pushEvent("agent", "Agent-Session verbunden (Proxy)");
  broadcastState();

  let agentBuffer = "";

  agentSock.on("data", async (chunk) => {
    agentBuffer += chunk.toString("utf8");
    let idx;
    while ((idx = agentBuffer.indexOf("\n")) >= 0) {
      const line = agentBuffer.slice(0, idx).trim();
      agentBuffer = agentBuffer.slice(idx + 1);
      if (!line) continue;

      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      await handleAgentMessage(agentSock, msg);
    }
  });

  const cleanup = () => {
    state.agent.connected = false;
    state.agent.session.state = "IDLE";
    state.agent.session.currentAction = "";
    for (const [key, pending] of pendingRequests) {
      if (pending.sock === agentSock) pendingRequests.delete(key);
    }
    pushEvent("agent", "Agent-Session getrennt");
    broadcastState();
  };
  agentSock.on("close", cleanup);
  agentSock.on("error", cleanup);
}

async function handleAgentMessage(sock, msg) {
  const isCall = msg.method === "tools/call";
  const toolName = isCall ? String(msg.params?.name ?? "") : "";
  const hasId = msg.id !== undefined && msg.id !== null;

  if (isCall) {
    state.stats.callsTotal++;
    state.agent.session.currentAction = toolName;

    // 1) PAUSE als Systemzustand — kein Chat, keine Bitte.
    if (state.agent.session.state === "PAUSED" || state.agent.session.state === "PAUSE_REQUESTED") {
      state.stats.callsDenied++;
      writeMsg(sock, {
        jsonrpc: "2.0", id: msg.id,
        error: { code: -32003, message: "Session pausiert durch Nutzer (Dashboard). Agent darf weiter beobachten, aber nichts tun." },
      });
      pushEvent("intercept", `PAUSIERT: ${toolName} abgelehnt`, { tool: toolName });
      return;
    }

    // 2) Tool-Blockliste des Nutzers.
    if (state.blockedTools.has(toolName)) {
      state.stats.callsDenied++;
      writeMsg(sock, {
        jsonrpc: "2.0", id: msg.id,
        error: { code: -32003, message: `Tool ${toolName} ist vom Nutzer blockiert (Dashboard).` },
      });
      pushEvent("intercept", `BLOCKIERT: ${toolName}`, { tool: toolName });
      return;
    }

    // 3) Freigabepflichtige Tools (Gefahrenklasse) — Nutzer entscheidet.
    if (needsApproval(toolName)) {
      const ok = await requestApproval(toolName, msg.id);
      if (!ok) {
        state.stats.callsDenied++;
        writeMsg(sock, {
          jsonrpc: "2.0", id: msg.id,
          error: { code: -32003, message: `Nutzer hat ${toolName} nicht freigegeben.` },
        });
        pushEvent("intercept", `ABGELEHNT: ${toolName}`, { tool: toolName });
        return;
      }
      pushEvent("intercept", `FREIGEGEBEN: ${toolName}`, { tool: toolName });
    }

    state.stats.callsOk++;
  }

  // 4) Durchleitung an Godot.
  if (!godotSocket || !state.target.connected) {
    if (isCall) {
      writeMsg(sock, {
        jsonrpc: "2.0", id: msg.id,
        error: { code: -32000, message: "Godot nicht verbunden — Spiel starten (runtime :9090) und Dashboard prüfen." },
      });
    }
    return;
  }
  if (hasId) pendingRequests.set(String(msg.id), { sock, tool: isCall ? toolName : null });
  writeMsg(godotSocket, msg);
}

function needsApproval(tool) {
  const defaults = new Set([
    "runtime_autonomy_export", "runtime_autonomy_rollback_all",
    "runtime_eval", "game_state_restore", "runtime_e2e_run",
  ]);
  return state.blockedTools.has(`approval:${tool}`) || defaults.has(tool);
}

/** Pending-Approval: resolved durch REST /api/approvals (Dashboard-Button). */
function requestApproval(tool) {
  return new Promise((resolve) => {
    const req = { tool, requestedAt: Date.now(), resolve };
    state.approvals.set(tool, req);
    pushEvent("approval", `Freigabe angefragt: ${tool}`, { tool });
    broadcast({ type: "approval", tool, requestedAt: req.requestedAt });
    // Sicherheitsnetz: nach 60 s automatisch verweigern.
    setTimeout(() => {
      if (state.approvals.has(tool)) {
        state.approvals.delete(tool);
        resolve(false);
        broadcast({ type: "approvalResolved", tool, approved: false, timeout: true });
      }
    }, 60000);
  });
}

/* ────────────────────────── SSE + REST-API ──────────────────────────── */

const sseClients = new Set();

function broadcast(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
}

function broadcastState() {
  broadcast({ type: "state", ...snapshot() });
}

function snapshot() {
  return {
    target: { ...state.target },
    agent: {
      connected: state.agent.connected,
      session: { ...state.agent.session },
    },
    blockedTools: [...state.blockedTools],
    approvals: [...state.approvals.keys()],
    stats: { ...state.stats },
    uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
    ports: { backend: BACKEND_PORT, proxy: PROXY_PORT, godot: GODOT_PORT },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); }
    });
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj, null, 2));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${BACKEND_PORT}`);

  // ── SSE Live-Stream ──
  if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "state", ...snapshot() })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // ── REST: Status ──
  if (url.pathname === "/api/state" && req.method === "GET") {
    return sendJson(res, 200, snapshot());
  }

  // ── REST: Command einschleusen (human origin, Dashboard/Ink) ──
  if (url.pathname === "/api/commands" && req.method === "POST") {
    const body = await readBody(req);
    const cmd = issueCommand(String(body.type ?? ""), body.payload ?? {}, "human");
    broadcastState();
    return sendJson(res, cmd.state === "rejected" ? 400 : 200, cmd);
  }

  // ── REST: Tool-Liste (für die Blocklisten-Auswahl im Dashboard) ──
  if (url.pathname === "/api/tools" && req.method === "GET") {
    try {
      const reply = await rpcGodot("tools/list");
      const tools = (reply?.result?.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? "" }));
      return sendJson(res, 200, { tools });
    } catch (err) {
      return sendJson(res, 503, { error: String(err.message || err), tools: [] });
    }
  }

  // ── REST: Freigaben ──
  if (url.pathname === "/api/approvals" && req.method === "GET") {
    return sendJson(res, 200, { pending: [...state.approvals.keys()] });
  }
  if (url.pathname.startsWith("/api/approvals/") && req.method === "POST") {
    const tool = decodeURIComponent(url.pathname.split("/")[3]);
    const body = await readBody(req);
    const pending = state.approvals.get(tool);
    if (!pending) return sendJson(res, 404, { error: "keine offene Freigabe für " + tool });
    state.approvals.delete(tool);
    pending.resolve(!!body.approved);
    broadcast({ type: "approvalResolved", tool, approved: !!body.approved });
    return sendJson(res, 200, { ok: true, tool, approved: !!body.approved });
  }

  // ── REST: letzter Beweis (Evidence) ──
  if (url.pathname === "/api/evidence" && req.method === "GET") {
    // v1: Metadaten aus dem JSONL-Feed; Bildpfade liefert Godot-MCP.
    const recent = state.events.filter((e) => e.kind === "intercept" || e.kind === "command").slice(-20);
    return sendJson(res, 200, { recent, note: "Screenshot-Artefakte liegen bei Godot (user://mcp_context); Referenz folgt in v1.1" });
  }

  // ── Statisches Dashboard ──
  if (url.pathname === "/" || url.pathname.startsWith("/assets/")) {
    const filePath = url.pathname === "/" ? path.join(WEB_DIST, "index.html") : path.join(WEB_DIST, url.pathname.replace(/^\/+/, ""));
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<!doctype html><meta charset='utf-8'><title>GODOT ACP Backend</title><p>Dashboard noch nicht gebaut: <code>cd backend/web && npm install && npm run build</code></p><p><a href='/api/state'>/api/state</a></p>");
        return;
      }
      const ext = path.extname(filePath);
      const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      res.end(data);
    });
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

/* ────────────────────────────── Listener ────────────────────────────── */

server.listen(BACKEND_PORT, () => {
  console.log(`[godot-acp] Dashboard   : http://localhost:${BACKEND_PORT}`);
  console.log(`[godot-acp] REST/SSE    : /api/state, /api/events, /api/commands`);
  console.log(`[godot-acp] Agent-Proxy : tcp://${PROXY_PORT}  (Agent verbindet HIERHER statt zu Godot)`);
  console.log(`[godot-acp] Godot-MCP   : tcp://${state.target.host}:${GODOT_PORT} (Auto-Reconnect)`);
  pushEvent("system", `Backend gestartet auf :${BACKEND_PORT}`);
  connectGodot();
});

// Agent-Proxy-Listener
net.createServer(handleAgentConnection).listen(PROXY_PORT, () => {
  pushEvent("system", `Agent-Proxy lauscht auf :${PROXY_PORT}`);
});

/* ───────────────────────────── Ink-CLI (optional) ───────────────────── */

// CLI-Dashboard: node backend/cli/dashboard.mjs — verbraucht dieselbe REST-API.

process.on("SIGINT", () => {
  console.log("\n[godot-acp] Backend beendet.");
  process.exit(0);
});
