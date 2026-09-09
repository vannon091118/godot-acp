#!/usr/bin/env node
/**
 * GODOT ACP Backend — DIE AUTORITÄT. Godot ACP ist nur noch Adapter.
 *
 * Architekturvertrag (User-Vorgabe, September 2026):
 *  - Target Registry / Target State      → hier, nicht in Godot, nicht im Connector.
 *  - Agent Registry / Agent State        → hier. Der Proxy meldet nur Leben.
 *  - Command Bus                         → echte Zustandsmaschine:
 *        CREATED → QUEUED → DISPATCHED → RUNNING → COMPLETED
 *        Nebenzustände: WAITING_APPROVAL, REJECTED, BLOCKED, CANCELLED, TIMEOUT, FAILED
 *    Jede Aktion — human, agent, system, qa — läuft über denselben Bus.
 *  - Event Stream → SSE (/api/events); React UND Ink abonnieren denselben Strom.
 *  - Persistence: append-only JSONL zuerst (events/commands/sessions);
 *    aktueller State ist daraus ableitbar (/api/replay-proof beweist es).
 *  - Der Godot-Connector besitzt NICHTS. Er meldet nur:
 *        godot.connected / godot.disconnected / godot.state_changed /
 *        godot.event / godot.command_result
 *    und das Backend entscheidet daraus den eigenen Zustand.
 *
 * Ports (ENV): ACP_BACKEND_PORT=8787 · ACP_GODOT_PORT=9090 · ACP_PROXY_PORT=9099
 * Daten (ENV): ACP_DATA_DIR=<repo>/backend/data
 */

import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLog, appendOnly, replay, readTail } from "./persistence/jsonl.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BACKEND_PORT = Number(process.env.ACP_BACKEND_PORT || 8787);
const GODOT_PORT = Number(process.env.ACP_GODOT_PORT || 9090);
const GODOT_HOST = process.env.ACP_GODOT_HOST || "127.0.0.1";
const PROXY_PORT = Number(process.env.ACP_PROXY_PORT || 9099);
const TARGET_ID = process.env.ACP_TARGET_ID || "godot-01";
const DATA_DIR = process.env.ACP_DATA_DIR || path.join(__dirname, "data");
const DASHBOARD_DIST = path.join(__dirname, "..", "dashboard", "dist");
const COMMAND_TIMEOUT_MS = Number(process.env.ACP_COMMAND_TIMEOUT_MS || 30000);
const APPROVAL_TIMEOUT_MS = Number(process.env.ACP_APPROVAL_TIMEOUT_MS || 60000);

const COMMAND_VERBS = new Set([
  "pause_agent", "resume_agent", "stop_agent", "set_goal",
  "target_reconnect", "backend_ping",
  "block_tools", "unblock_tools",
  "lock_controls", "unlock_controls",
]);

const logEvents = createLog(DATA_DIR, "events.jsonl");
const logCommands = createLog(DATA_DIR, "commands.jsonl");
const logSessions = createLog(DATA_DIR, "sessions.jsonl");

/* ══════════════════════ Registries (die zentrale Wahrheit) ══════════════ */

const now = () => Date.now();
let seq = 0;
const nextId = (prefix) => `${prefix}_${now()}_${++seq}`;

const state = {
  startedAt: now(),
  /** Target Registry — Verbindungsziel(e). */
  targets: new Map(),   // id -> {id, kind, state, host, port, lastSeenAt, lastError}
  /** Agent Registry — Agent-Sessions. */
  agents: new Map(),    // id -> {id, name, state, goal, currentAction, startedAt, lastSeenAt, targetId}
  /** Command Bus — ALLE Aktionen aller Origins. */
  commands: new Map(),  // id -> command
  /** Blockliste — echte Entitäten, keine UI-Dekoration. */
  blocks: new Map(),    // id -> {id, scope: tool|agent|target|command, value, reason, active, createdBy, createdAt}
  /** Offene Freigaben: commandId -> {tool, agentId, requestedAt}. */
  approvals: new Map(),
  /** Live-Feed (Ring). */
  events: [],
  stats: { completed: 0, blocked: 0, failed: 0, timeout: 0, rejected: 0, eventsSeen: 0 },
};

const MAX_EVENTS = 500;
const MAX_COMMANDS = 300;

// Targets: konfiguriertes Standardziel registrieren.
state.targets.set(TARGET_ID, {
  id: TARGET_ID, kind: "godot", state: "OFFLINE",
  host: GODOT_HOST, port: GODOT_PORT, lastSeenAt: null, lastError: null,
});

/* ───────────────────────── Events + SSE ─────────────────────────────── */

const sseClients = new Set();

function pushEvent(kind, message, meta = {}) {
  const ev = { ts: now(), kind, message, ...meta };
  state.events.push(ev);
  if (state.events.length > MAX_EVENTS) state.events.shift();
  state.stats.eventsSeen++;
  appendOnly(logEvents, ev);
  broadcast({ type: "event", event: ev });
  return ev;
}

function broadcast(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
}

function snapshot() {
  return {
    status: "ok",
    targets: [...state.targets.values()].map((t) => ({ ...t })),
    agents: [...state.agents.values()].map((a) => ({ ...a })),
    blocks: [...state.blocks.values()].filter((b) => b.active).map((b) => ({ ...b })),
    approvals: [...state.approvals.values()].map((a) => ({ ...a })),
    stats: { ...state.stats },
    uptimeSeconds: Math.floor((now() - state.startedAt) / 1000),
    ports: { backend: BACKEND_PORT, proxy: PROXY_PORT, godot: GODOT_PORT },
    authority: "backend",
  };
}

const broadcastState = () => broadcast({ type: "state", ...snapshot() });

/* ───────────────────────── Command-Bus (Zustandsmaschine) ───────────── */

const TERMINAL = new Set(["COMPLETED", "REJECTED", "BLOCKED", "CANCELLED", "TIMEOUT", "FAILED"]);

function createCommand({ origin, type, payload = {}, agentId = null, targetId = null, tool = null }) {
  if (!["human", "agent", "system", "qa"].includes(origin)) {
    throw new Error(`unzulässige origin: ${origin}`);
  }
  const cmd = {
    id: nextId("cmd"),
    origin, type, payload,
    agentId, targetId: targetId || (agentId ? state.agents.get(agentId)?.targetId : null) || TARGET_ID,
    tool,
    state: "CREATED",
    reason: null,
    transitions: [{ from: null, to: "CREATED", at: now() }],
    createdAt: now(),
    updatedAt: now(),
    replyTo: null, // Agent-Socket, wenn eine Antwort erwartet wird
  };
  state.commands.set(cmd.id, cmd);
  if (state.commands.size > MAX_COMMANDS) {
    for (const [id, c] of state.commands) {
      if (TERMINAL.has(c.state)) { state.commands.delete(id); break; }
    }
  }
  appendOnly(logCommands, { cmdId: cmd.id, origin, type, transition: "CREATED", at: now() });
  broadcast({ type: "command", command: publicCommand(cmd) });
  queueCommand(cmd);
  return cmd;
}

function transition(cmd, to, reason = null) {
  cmd.transitions.push({ from: cmd.state, to, at: now() });
  cmd.state = to;
  cmd.reason = reason;
  cmd.updatedAt = now();
  appendOnly(logCommands, { cmdId: cmd.id, origin: cmd.origin, type: cmd.type, transition: to, reason, at: now() });
  broadcast({ type: "command", command: publicCommand(cmd) });
  if (TERMINAL.has(to)) {
    if (to === "COMPLETED") state.stats.completed++;
    if (to === "BLOCKED") state.stats.blocked++;
    if (to === "FAILED") state.stats.failed++;
    if (to === "TIMEOUT") state.stats.timeout++;
    if (to === "REJECTED") state.stats.rejected++;
    settleAgentReply(cmd);
  }
}

/**
 * Endzustände außer COMPLETED werden dem Agent als JSON-RPC-Fehler mitgeteilt
 * (COMPLETED wird zentral in onTargetMessage geroutet — dort kommt das Ergebnis her).
 */
function settleAgentReply(cmd) {
  if (!cmd.replyTo || cmd.state === "COMPLETED") return;
  const code = cmd.state === "BLOCKED" ? -32003
    : cmd.state === "FAILED" ? -32000
    : cmd.state === "TIMEOUT" ? -32004
    : cmd.state === "REJECTED" ? -32602
    : -32005; // CANCELLED
  writeMsg(cmd.replyTo, {
    jsonrpc: "2.0", id: cmd.replyId ?? null,
    error: { code, message: `${cmd.tool ?? cmd.type}: ${cmd.state}${cmd.reason ? ` — ${cmd.reason}` : ""}` },
  });
}

function publicCommand(cmd) {
  return {
    id: cmd.id, origin: cmd.origin, type: cmd.type, state: cmd.state,
    reason: cmd.reason, agentId: cmd.agentId, targetId: cmd.targetId, tool: cmd.tool,
    createdAt: cmd.createdAt, updatedAt: cmd.updatedAt,
  };
}

function queueCommand(cmd) {
  transition(cmd, "QUEUED");
  // Dispatch asynchron — der Bus ist nie im Weg eines Sockets.
  setImmediate(() => dispatchCommand(cmd));
}

function dispatchCommand(cmd) {
  if (TERMINAL.has(cmd.state)) return;

  // Interne Verben zuerst — sie gehören zur Backend-Autorität.
  switch (cmd.type) {
    case "pause_agent":    return dispatchAgentControl(cmd, "PAUSED", "acp/pause_agent");
    case "resume_agent":   return dispatchAgentControl(cmd, "WORKING", "acp/resume_agent");
    case "stop_agent":     return dispatchAgentControl(cmd, "STOP_REQUESTED", "acp/stop_agent");
    case "set_goal":       return dispatchSetGoal(cmd);
    case "target_reconnect": {
      transition(cmd, "DISPATCHED");
      connector.connect();
      transition(cmd, "COMPLETED");
      return;
    }
    case "backend_ping": {
      transition(cmd, "DISPATCHED");
      transition(cmd, "COMPLETED", `uptime ${Math.floor((now() - state.startedAt) / 1000)}s`);
      return;
    }
    case "block_tools": {
      transition(cmd, "DISPATCHED");
      for (const tool of cmd.payload.tools ?? []) {
        const id = nextId("blk");
        state.blocks.set(id, {
          id, scope: "tool", value: String(tool),
          reason: String(cmd.payload.reason || `blockiert durch ${cmd.origin}`),
          active: true, createdBy: cmd.origin, createdAt: now(),
        });
        pushEvent("block", `Werkzeug blockiert: ${tool}`, { tool, origin: cmd.origin });
      }
      broadcastState();
      transition(cmd, "COMPLETED");
      return;
    }
    case "unblock_tools": {
      transition(cmd, "DISPATCHED");
      const wanted = new Set((cmd.payload.tools ?? []).map(String));
      for (const b of state.blocks.values()) {
        if (b.scope === "tool" && wanted.has(b.value)) b.active = false;
      }
      broadcastState();
      transition(cmd, "COMPLETED");
      return;
    }
    case "lock_controls": {
      transition(cmd, "DISPATCHED");
      const id = nextId("blk");
      state.blocks.set(id, {
        id, scope: "agent", value: cmd.agentId || "*",
        reason: "Steuerung verriegelt", active: true, createdBy: cmd.origin, createdAt: now(),
      });
      broadcastState();
      transition(cmd, "COMPLETED");
      return;
    }
    case "unlock_controls": {
      transition(cmd, "DISPATCHED");
      for (const b of state.blocks.values()) {
        if (b.scope === "agent" && b.value === (cmd.agentId || "*")) b.active = false;
      }
      broadcastState();
      transition(cmd, "COMPLETED");
      return;
    }
    default: break; // Agent-Tool-Call oder Unbekanntes — unten weiter.
  }

  if (!cmd.tool && cmd.origin === "agent") {
    // Vom Proxy als Tool-Call getaggt.
    cmd.tool = cmd.type;
  }
  if (cmd.tool) return dispatchToolCall(cmd);

  transition(cmd, "REJECTED", `unbekannter Command-Typ: ${cmd.type}`);
}

function dispatchAgentControl(cmd, agentState, notifyMethod) {
  transition(cmd, "DISPATCHED");
  const agent = cmd.agentId ? state.agents.get(cmd.agentId) : [...state.agents.values()].find((a) => a.state !== "IDLE");
  if (!agent) {
    transition(cmd, "FAILED", "kein Agent registriert");
    return;
  }
  setAgentState(agent, agentState === "WORKING" && agent.state === "IDLE" ? "IDLE" : agentState);
  connector.notifyTarget(cmd.targetId, notifyMethod, { agentId: agent.id });
  transition(cmd, "COMPLETED", `agent ${agent.id} → ${agentState}`);
  broadcastState();
}

function dispatchSetGoal(cmd) {
  transition(cmd, "DISPATCHED");
  const agent = cmd.agentId ? state.agents.get(cmd.agentId) : [...state.agents.values()].find((a) => a.state !== "IDLE");
  if (!agent) { transition(cmd, "FAILED", "kein Agent registriert"); return; }
  agent.goal = String(cmd.payload.goal ?? "");
  connector.notifyTarget(cmd.targetId, "acp/set_goal", { agentId: agent.id, goal: agent.goal });
  transition(cmd, "COMPLETED", `Ziel gesetzt: ${agent.goal.slice(0, 60)}`);
  broadcastState();
}

/** Tool-Calls (origin agent|human|qa) — hier greifen Pause, Blockliste, Approval. */
function dispatchToolCall(cmd) {
  const agent = cmd.agentId ? state.agents.get(cmd.agentId) : null;

  // 1) Agent-Zustand ist echte Wahheit — kein Theater.
  if (agent && (agent.state === "PAUSED" || agent.state === "PAUSE_REQUESTED")) {
    transition(cmd, "BLOCKED", "Agent pausiert (Nutzerentscheidung)");
    return;
  }
  if (agent && agent.state === "STOP_REQUESTED") {
    transition(cmd, "BLOCKED", "Agent wird beendet");
    return;
  }

  // 2) Blockliste — ebenfalls echte Entitäten.
  for (const b of state.blocks.values()) {
    if (!b.active) continue;
    if (b.scope === "tool" && b.value === cmd.tool) {
      transition(cmd, "BLOCKED", `Werkzeug blockiert: ${b.reason}`);
      return;
    }
    if (b.scope === "agent" && (b.value === "*" || b.value === cmd.agentId)) {
      transition(cmd, "BLOCKED", `Agent gesperrt: ${b.reason}`);
      return;
    }
  }

  // 3) Freigabepflichtige Werkzeuge.
  if (needsApproval(cmd.tool) && !cmd.payload?.__approved) {
    transition(cmd, "WAITING_APPROVAL", "Freigabe durch Nutzer erforderlich");
    state.approvals.set(cmd.id, { commandId: cmd.id, tool: cmd.tool, agentId: cmd.agentId, requestedAt: now() });
    pushEvent("approval", `Freigabe angefragt: ${cmd.tool}`, { commandId: cmd.id, tool: cmd.tool });
    broadcastState();
    setTimeout(() => {
      if (state.approvals.has(cmd.id)) {
        state.approvals.delete(cmd.id);
        transition(cmd, "TIMEOUT", "Freigabe nicht rechtzeitig erteilt (Timeout)");
      }
    }, APPROVAL_TIMEOUT_MS);
    return;
  }

  // 4) An das Ziel dispatchen.
  dispatchToTarget(cmd);
}

function needsApproval(tool) {
  return ["runtime_autonomy_export", "runtime_autonomy_rollback_all", "runtime_eval", "game_state_restore", "runtime_e2e_run"].includes(tool);
}

function dispatchToTarget(cmd) {
  const target = state.targets.get(cmd.targetId);
  transition(cmd, "DISPATCHED");
  if (!target || target.state !== "CONNECTED" || !connector.isOpen(cmd.targetId)) {
    transition(cmd, "FAILED", `Ziel ${cmd.targetId} nicht verbunden (state: ${target?.state ?? "unbekannt"})`);
    return;
  }
  transition(cmd, "RUNNING");
  const wireId = `acp-${cmd.id}`;
  connector.send(cmd.targetId, {
    jsonrpc: "2.0", id: wireId,
    method: "tools/call",
    params: { name: cmd.tool, arguments: stripInternal(cmd.payload) },
  });
  cmd.wireId = wireId;
  pendingByWire.set(wireId, cmd);
}

function stripInternal(payload) {
  const { __approved, ...rest } = payload ?? {};
  return rest;
}

/** Antwort des Ziels auf einen laufenden Command. */
function settleTargetResponse(wireId, msg) {
  const cmd = pendingByWire.get(wireId);
  if (!cmd) return;
  pendingByWire.delete(wireId);
  if (msg.error) transition(cmd, "FAILED", msg.error.message ?? "Zielfehler");
  else transition(cmd, "COMPLETED");
}

const pendingByWire = new Map();

/** Timeout-Sweeper: RUNNING-Commands, die nie antworten, sterben sauber. */
setInterval(() => {
  const t = now();
  for (const cmd of state.commands.values()) {
    if (cmd.state === "RUNNING" && t - cmd.updatedAt > COMMAND_TIMEOUT_MS) {
      if (cmd.wireId) pendingByWire.delete(cmd.wireId);
      transition(cmd, "TIMEOUT", `keine Antwort vom Ziel nach ${Math.round(COMMAND_TIMEOUT_MS / 1000)}s`);
      pushEvent("timeout", `${cmd.type} nach Timeout abgebrochen`, { commandId: cmd.id });
    }
  }
}, 1000).unref();

/* ───────────────────────── Agent Registry ───────────────────────────── */

function registerAgent(name) {
  const id = String(name || `agent-${state.agents.size + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40) || `agent-${state.agents.size + 1}`;
  let agent = state.agents.get(id);
  if (!agent) {
    agent = { id, name, state: "IDLE", goal: "", currentAction: "", startedAt: now(), lastSeenAt: now(), targetId: TARGET_ID };
    state.agents.set(id, agent);
    logAgentTransition(agent, null, "IDLE");
  } else {
    agent.lastSeenAt = now();
  }
  return agent;
}

function setAgentState(agent, to) {
  if (agent.state === to) return;
  const from = agent.state;
  agent.state = to;
  if (to === "WORKING" && !agent.startedAt) agent.startedAt = now();
  logAgentTransition(agent, from, to);
  pushEvent("agent", `Agent ${agent.id}: ${from} → ${to}`, { agentId: agent.id });
  broadcastState();
}

function logAgentTransition(agent, from, to) {
  appendOnly(logSessions, { ts: now(), agentId: agent.id, from, to });
}

/* ─────────────────────── Godot-Adapter (Connector) ──────────────────── */

/**
 * Der Connector besitzt KEINE Systemzustände. Er verwaltet nur Sockets und
 * Liveness und meldet alles an den Kern (die Registry-Funktionen oben).
 */
const connector = (() => {
  const sockets = new Map();     // targetId -> socket
  const pingPending = new Map(); // targetId -> bool
  let pingTimer = null;

  function isOpen(targetId) {
    return sockets.has(targetId);
  }

  function send(targetId, obj) {
    const sock = sockets.get(targetId);
    if (!sock) return false;
    try { sock.write(JSON.stringify(obj) + "\n"); return true; } catch { return false; }
  }

  function notifyTarget(targetId, method, params) {
    // Fire-and-forward: Ist das Ziel da, erfährt es den Systemzustand;
    // ist es weg, bleibt die Backend-Autorität trotzdem wahr.
    if (isOpen(targetId)) send(targetId, { jsonrpc: "2.0", method, params: params ?? {} });
  }

  function connect() {
    const target = state.targets.get(TARGET_ID);
    if (!target) return;
    if (sockets.has(TARGET_ID)) return;
    if (target.state === "OFFLINE" || target.state === "RECONNECTING") {
      target.state = "CONNECTING";
      broadcastState();
    }
    const sock = net.connect(target.port, target.host);
    let buffer = "";

    sock.on("connect", () => {
      sockets.set(TARGET_ID, sock);
      core.onTargetConnected(TARGET_ID);
    });
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        target.lastSeenAt = now();
        if (target.state === "DEGRADED") core.onTargetStateChanged(TARGET_ID, "CONNECTED", "Ping-Timeout behoben");
        try {
          const msg = JSON.parse(line);
          core.onTargetMessage(TARGET_ID, msg);
        } catch { /* kein JSON — Leben reicht */ }
      }
    });
    sock.on("error", (err) => { target.lastError = String(err.message || err); });
    sock.on("close", () => {
      if (sockets.get(TARGET_ID) === sock) sockets.delete(TARGET_ID);
      core.onTargetDisconnected(TARGET_ID, target.lastError);
      setTimeout(connect, 3000);
    });
  }

  function ping() {
    for (const [targetId] of sockets) {
      if (pingPending.get(targetId)) continue;
      pingPending.set(targetId, true);
      send(targetId, { jsonrpc: "2.0", id: "acp-ping", method: "ping", params: {} });
      setTimeout(() => {
        if (pingPending.get(targetId)) {
          pingPending.set(targetId, false);
          const target = state.targets.get(targetId);
          if (target?.state === "CONNECTED") core.onTargetStateChanged(targetId, "DEGRADED", "Ziel antwortet nicht (Ping-Timeout)");
        }
      }, 2500);
    }
  }

  function handlePong(targetId) {
    pingPending.set(targetId, false);
  }

  function start() {
    connect();
    pingTimer = setInterval(ping, 5000);
    pingTimer.unref();
  }

  return { connect, send, isOpen, notifyTarget, start, handlePong };
})();

/* ───────────────────── Kern: entscheidet aus Adapter-Meldungen ──────── */

const core = {
  onTargetConnected(targetId) {
    const target = state.targets.get(targetId);
    if (!target) return;
    const from = target.state;
    target.state = "CONNECTED";
    target.lastSeenAt = now();
    target.lastError = null;
    pushEvent("target", `godot.connected: ${targetId} (${target.host}:${target.port})`, { targetId, from });
    broadcastState();
  },

  onTargetDisconnected(targetId, lastError) {
    const target = state.targets.get(targetId);
    if (!target) return;
    target.state = "RECONNECTING";
    pushEvent("target", `godot.disconnected: ${targetId} — Reconnect läuft`, { targetId, lastError });
    broadcastState();
  },

  onTargetStateChanged(targetId, to, reason) {
    const target = state.targets.get(targetId);
    if (!target || target.state === to) return;
    const from = target.state;
    target.state = to;
    pushEvent("target", `godot.state_changed: ${targetId} ${from} → ${to}`, { targetId, reason });
    broadcastState();
  },

  onTargetMessage(targetId, msg) {
    // Ping-Management (Liveness, kein Fachzustand).
    if (msg.id === "acp-ping") { connector.handlePong(targetId); return; }

    // 1) Antwort auf einen laufenden Command?
    if (msg.id !== undefined && msg.id !== null && typeof msg.id === "string" && msg.id.startsWith("acp-")) {
      const cmd = pendingByWire.get(msg.id);
      if (cmd) {
        settleTargetResponse(msg.id, msg);
        pushEvent("command_result", `${cmd.type}: ${msg.error ? "Fehler" : "ok"}`, {
          commandId: cmd.id, tool: cmd.tool, ok: !msg.error,
        });
        // Antwort zum Agent-Socket routen (der Agent kennt das Ziel nicht).
        if (cmd.replyTo) {
          const reply = msg.error
            ? { jsonrpc: "2.0", id: cmd.replyId, error: msg.error }
            : { jsonrpc: "2.0", id: cmd.replyId, result: msg.result };
          try { cmd.replyTo.write(JSON.stringify(reply) + "\n"); } catch { /* Socket weg */ }
        }
        broadcastState();
        return;
      }
    }

    // 2) Notification/Event vom Ziel — godot.event u. Verwandtes.
    if (msg.method) {
      state.targets.get(targetId).lastSeenAt = now();
      const params = msg.params ?? {};
      const label = params.event ? `${msg.method}: ${params.event}` : msg.method;
      const detail = params.detail ? ` — ${params.detail}` : "";
      pushEvent("target", `godot.event — ${label}${detail}`, { targetId, method: msg.method, params });
      broadcastState();
      return;
    }

    // 3) Alles andere (Requests ohne Bus-Bezug) wird als Event notiert.
    pushEvent("target", `godot.event — (unklassifizierte Nachricht)`, { targetId });
  },
};

/* ─────────────────────── Agent-Proxy (MCP-Fassade) ──────────────────── */

let agentConnSeq = 0;

function handleAgentConnection(sock) {
  const connId = `conn-${++agentConnSeq}`;
  let agent = null;
  let buffer = "";

  sock.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handleAgentMessage(sock, msg).catch(() => {});
    }
  });

  const cleanup = () => {
    if (agent) {
      setAgentState(agent, "IDLE");
      agent.currentAction = "";
      pushEvent("agent", `Agent-Session getrennt: ${agent.id} (${connId})`, { agentId: agent.id });
      broadcastState();
    }
  };
  sock.on("close", cleanup);
  sock.on("error", cleanup);

  async function handleAgentMessage(sock, msg) {
    const method = msg.method ?? "";

    // initialize: Registrierung + Protokollantwort VOM BACKEND (Fassade).
    if (method === "initialize") {
      const name = msg.params?.clientInfo?.name;
      agent = registerAgent(name);
      setAgentState(agent, "WORKING");
      pushEvent("agent", `Agent-Session verbunden: ${agent.id} (${connId})`, { agentId: agent.id });
      broadcastState();
      writeMsg(sock, {
        jsonrpc: "2.0", id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "godot-acp-backend", version: "0.2.0" },
        },
      });
      return;
    }

    if (!agent) return; // Vor initialize: keine Session, kein Service.

    // Notifications (keine id): nur weiterleiten/ignorieren.
    if (msg.id === undefined || msg.id === null) return;

    if (method === "tools/list") {
      const target = state.targets.get(agent.targetId);
      if (target?.state === "CONNECTED" && connector.isOpen(agent.targetId)) {
        connector.send(agent.targetId, { ...msg, id: `probe-${msg.id}` });
        proxyReplies.set(`probe-${msg.id}`, msg.id);
      } else {
        writeMsg(sock, { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Ziel nicht verbunden — Spiel starten." } });
      }
      return;
    }

    if (method === "tools/call") {
      const tool = String(msg.params?.name ?? "");
      const cmd = createCommand({
        origin: "agent",
        type: tool,
        payload: msg.params?.arguments ?? {},
        agentId: agent.id,
        tool,
      });
      // Reply-Verdrahtung: Die endgültige Antwort landet bei DIESEM Socket.
      // (queueCommand dispatcht erst im nächsten Tick — Zuordnung ist sicher.)
      cmd.replyTo = sock;
      cmd.replyId = msg.id;
      agent.currentAction = tool;
      agent.lastSeenAt = now();
      broadcastState();
      return;
    }

    // Alles andere: unbekannt, aber höflich.
    writeMsg(sock, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Methode ${method} wird vom Backend-Proxy nicht unterstützt.` } });
  }
}

const proxyReplies = new Map(); // probe-<wireId> -> originale Agent-msg.id
function writeMsg(sock, obj) {
  try { sock.write(JSON.stringify(obj) + "\n"); } catch { /* ignore */ }
}

/* ─────────────────────── Boot: Replay aus JSONL ─────────────────────── */

function restoreFromLogs() {
  // Sessions: Agent-Zustände ableitbar machen (PAUSED überlebt Neustart).
  const restoredAgents = replay(
    logSessions,
    (acc, rec) => {
      if (!rec.agentId) return acc;
      acc[rec.agentId] = rec.to === "IDLE" ? "IDLE" : (rec.to ?? acc[rec.agentId] ?? "IDLE");
      return acc;
    },
    {},
  );
  for (const [agentId, agentState] of Object.entries(restoredAgents)) {
    if (agentState === "IDLE") continue;
    if (!state.agents.has(agentId)) {
      const agent = { id: agentId, name: agentId, state: agentState, goal: "", currentAction: "", startedAt: now(), lastSeenAt: null, targetId: TARGET_ID };
      state.agents.set(agentId, agent);
    }
  }

  // Commands: Historie + Statistik aus dem Log ableiten (Beweis: State ist ablesbar).
  const derived = replay(
    logCommands,
    (acc, rec) => {
      acc.total++;
      acc.byState[rec.transition] = (acc.byState[rec.transition] ?? 0) + 1;
      acc.last = rec;
      return acc;
    },
    { total: 0, byState: {}, last: null },
  );
  return derived;
}

const replayProof = { derived: null };
replayProof.derived = restoreFromLogs();

/* ───────────────────────────── HTTP-API ─────────────────────────────── */

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj, null, 2));
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

/** Wähle den Agenten: explizite id > einziger Nicht-Idle > einziger überhaupt. */
function pickAgent(id) {
  if (id && state.agents.has(id)) return state.agents.get(id);
  const active = [...state.agents.values()].filter((a) => a.state !== "IDLE");
  if (active.length === 1) return active[0];
  const all = [...state.agents.values()];
  if (all.length === 1) return all[0];
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${BACKEND_PORT}`);
  const p = url.pathname;

  // ── SSE Live-Stream (React UND Ink abonnieren denselben Strom) ──
  if (p === "/api/events" && req.method === "GET") {
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

  if (p === "/api/status" && req.method === "GET") return sendJson(res, 200, snapshot());

  if (p === "/api/targets" && req.method === "GET") {
    return sendJson(res, 200, { targets: [...state.targets.values()].map((t) => ({ ...t })) });
  }

  if (p === "/api/agents" && req.method === "GET") {
    return sendJson(res, 200, { agents: [...state.agents.values()].map((a) => ({ ...a })) });
  }

  // ── Command einschleusen (origin: human/qa/system; default human) ──
  if (p === "/api/commands" && req.method === "POST") {
    const body = await readBody(req);
    const origin = ["human", "qa", "system"].includes(body.origin) ? body.origin : "human";
    const type = String(body.type ?? "");
    const payload = body.payload ?? {};
    if (!COMMAND_VERBS.has(type) && !payload.tool) {
      return sendJson(res, 400, { error: `unbekannter Command-Typ: ${type}` });
    }
    const cmd = createCommand({
      origin, type, payload,
      agentId: body.agentId ?? null,
      tool: payload.tool ?? (COMMAND_VERBS.has(type) ? null : type),
    });
    if (!COMMAND_VERBS.has(type) && payload.tool) {
      // Tool-Call via REST: Antwort landet im Command-Ergebnis, nicht in einem Socket.
      cmd.rest = true;
      delete cmd.replyTo;
    }
    broadcastState();
    return sendJson(res, cmd.state === "REJECTED" ? 400 : 202, publicCommand(cmd));
  }

  // ── Agent-Steuerung ──
  const agentMatch = p.match(/^\/api\/agents\/([^/]+)\/(pause|resume|stop|goal)$/);
  if (agentMatch && req.method === "POST") {
    const agentId = decodeURIComponent(agentMatch[1]);
    const action = agentMatch[2];
    const agent = pickAgent(agentId);
    if (!agent) return sendJson(res, 404, { error: `kein Agent ${agentId} registriert` });
    const body = await readBody(req);
    const type = action === "pause" ? "pause_agent" : action === "resume" ? "resume_agent" : action === "stop" ? "stop_agent" : "set_goal";
    const cmd = createCommand({ origin: "human", type, payload: { goal: body.goal }, agentId: agent.id });
    broadcastState();
    return sendJson(res, 202, publicCommand(cmd));
  }

  // ── Blockliste (echte Entitäten) ──
  if (p === "/api/blocks" && req.method === "GET") {
    return sendJson(res, 200, { blocks: [...state.blocks.values()].map((b) => ({ ...b })) });
  }
  if (p === "/api/blocks" && req.method === "POST") {
    const body = await readBody(req);
    if (body.scope === "tool" && Array.isArray(body.tools)) {
      const cmd = createCommand({ origin: "human", type: "block_tools", payload: { tools: body.tools, reason: body.reason } });
      return sendJson(res, 202, { ok: true, commandId: cmd.id });
    }
    const id = nextId("blk");
    state.blocks.set(id, {
      id,
      scope: ["tool", "agent", "target", "command"].includes(body.scope) ? body.scope : "tool",
      value: String(body.value ?? ""),
      reason: String(body.reason || `blockiert durch ${body.createdBy || "human"}`),
      active: true, createdBy: body.createdBy || "human", createdAt: now(),
    });
    pushEvent("block", `Block aktiv: ${body.scope}=${body.value}`, { scope: body.scope, value: body.value });
    broadcastState();
    return sendJson(res, 201, { ...state.blocks.get(id) });
  }
  const blockMatch = p.match(/^\/api\/blocks\/([^/]+)\/(deactivate)$/);
  if (blockMatch && req.method === "POST") {
    const b = state.blocks.get(decodeURIComponent(blockMatch[1]));
    if (!b) return sendJson(res, 404, { error: "Block nicht gefunden" });
    b.active = false;
    pushEvent("block", `Block aufgehoben: ${b.scope}=${b.value}`, { scope: b.scope, value: b.value });
    broadcastState();
    return sendJson(res, 200, { ...b });
  }

  // ── Freigaben (nach Command-ID) ──
  if (p === "/api/approvals" && req.method === "GET") {
    return sendJson(res, 200, { pending: [...state.approvals.values()] });
  }
  const approvalMatch = p.match(/^\/api\/approvals\/([^/]+)$/);
  if (approvalMatch && req.method === "POST") {
    const commandId = decodeURIComponent(approvalMatch[1]);
    const pending = state.approvals.get(commandId);
    if (!pending) return sendJson(res, 404, { error: `keine offene Freigabe für ${commandId}` });
    const body = await readBody(req);
    state.approvals.delete(commandId);
    const cmd = state.commands.get(commandId);
    if (!cmd) return sendJson(res, 410, { error: "Command nicht mehr vorhanden" });
    if (body.approved) {
      cmd.payload.__approved = true;
      pushEvent("approval", `Freigabe erteilt: ${cmd.tool}`, { commandId });
      queueCommand(cmd);
    } else {
      transition(cmd, "BLOCKED", "Nutzer hat die Freigabe verweigert");
      pushEvent("approval", `Freigabe verweigert: ${cmd.tool}`, { commandId });
    }
    broadcastState();
    return sendJson(res, 200, { ok: true, commandId, approved: !!body.approved });
  }

  // ── Beweis: State ist aus dem Log ableitbar ──
  if (p === "/api/replay-proof" && req.method === "GET") {
    const derived = replay(
      logCommands,
      (acc, rec) => {
        acc.total++;
        acc.byState[rec.transition] = (acc.byState[rec.transition] ?? 0) + 1;
        return acc;
      },
      { total: 0, byState: {} },
    );
    const sessions = readTail(logSessions, 20);
    return sendJson(res, 200, {
      commandsDerivedFromLog: derived,
      sessionsTail: sessions,
      note: "aktueller State ist aus append-only JSONL ableitbar — keine status.json-Konkurrenz",
    });
  }

  // ── Letzte Beweise/Evidence ──
  if (p === "/api/evidence" && req.method === "GET") {
    const recent = state.events.filter((e) => ["target", "command_result", "approval", "block", "timeout"].includes(e.kind)).slice(-30);
    return sendJson(res, 200, { recent, note: "Bild-Artefakte liegen beim Ziel (user://mcp_context); Anzeige geplant (ROADMAP v1.1)" });
  }

  // ── Statisches Dashboard ──
  if (p === "/" || p.startsWith("/assets/")) {
    const filePath = p === "/" ? path.join(DASHBOARD_DIST, "index.html") : path.join(DASHBOARD_DIST, p.replace(/^\/+/, ""));
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<!doctype html><meta charset='utf-8'><title>GODOT ACP Backend</title><p>Dashboard noch nicht gebaut: <code>cd dashboard && npm install && npm run build</code></p><p><a href='/api/status'>/api/status</a></p>");
        return;
      }
      const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(filePath)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      res.end(data);
    });
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

/* ────────────────────────────── Listener ────────────────────────────── */

server.listen(BACKEND_PORT, () => {
  console.log(`[godot-acp] Autorität    : http://localhost:${BACKEND_PORT}  (/api/status, /api/events)`);
  console.log(`[godot-acp] Agent-Proxy : tcp://${PROXY_PORT}  (Agent verbindet HIERHER)`);
  console.log(`[godot-acp] Godot-Ziel  : tcp://${GODOT_HOST}:${GODOT_PORT} als ${TARGET_ID} (Adapter, Auto-Reconnect)`);
  console.log(`[godot-acp] Persistenz  : ${DATA_DIR} (append-only JSONL)`);
  pushEvent("system", `Backend gestartet auf :${BACKEND_PORT} (Autorität)`);
  broadcastState();
  connector.start();
});

net.createServer(handleAgentConnection).listen(PROXY_PORT, () => {
  pushEvent("system", `Agent-Proxy lauscht auf :${PROXY_PORT}`);
});

process.on("SIGINT", () => {
  console.log("\n[godot-acp] Backend beendet.");
  process.exit(0);
});
