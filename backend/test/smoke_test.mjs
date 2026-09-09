#!/usr/bin/env node
/**
 * smoke_test.mjs — End-to-End-Beweis der Backend-Control-Plane.
 *
 * Startet fake_godot + Backend, verbindet einen simulierten Agent-Client und
 * beweist nacheinander:
 *   1. Durchleitung: tools/call -> Antwort von fake_godot landet beim Agent.
 *   2. PAUSE:        Dashboard-Command session.pause -> Agent-Call wird abgelehnt.
 *   3. BLOCKLISTE:   tools.block -> blockiertes Tool wird abgelehnt, andere laufen.
 *   4. APPROVAL:     freigabepflichtiges Tool wartet -> /api/approvals/... approved.
 *   5. ZIEL:         session.goal landet im Session-State (SSE/REST sichtbar).
 *
 * Start: node test/smoke_test.mjs
 * Exit 0 = alle Beweise erbracht.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GODOT_PORT = 9191;
const BACKEND_PORT = 8788;
const PROXY_PORT = 9199;

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name} ${detail}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(method, urlPath, body) {
  const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

/** Minimaler MCP-Client über den Proxy; onMessage für Antworten. */
function agentClient(onMessage) {
  const sock = net.connect(PROXY_PORT, "127.0.0.1");
  let buffer = "";
  sock.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) try { onMessage(JSON.parse(line)); } catch { /* ignore */ }
    }
  });
  return {
    send: (obj) => sock.write(JSON.stringify(obj) + "\n"),
    close: () => sock.destroy(),
  };
}

function waitFor(predicate, timeoutMs = 5000, label = "condition") {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      Promise.resolve()
        .then(predicate)
        .then((ok) => {
          if (ok) { clearInterval(t); resolve(); }
          else if (Date.now() - started > timeoutMs) { clearInterval(t); reject(new Error(`timeout: ${label}`)); }
        })
        .catch(() => {
          // Backend noch nicht erreichbar o.ä. — weiter pollen, bis Timeout.
          if (Date.now() - started > timeoutMs) { clearInterval(t); reject(new Error(`timeout: ${label}`)); }
        });
    }, 50);
  });
}

async function main() {
  const fakeGodot = spawn(process.execPath, [path.join(__dirname, "fake_godot.mjs"), String(GODOT_PORT)], { stdio: "pipe" });
  const backend = spawn(process.execPath, [path.join(__dirname, "..", "server.mjs")], {
    stdio: "pipe",
    env: { ...process.env, ACP_BACKEND_PORT: String(BACKEND_PORT), ACP_GODOT_PORT: String(GODOT_PORT), ACP_PROXY_PORT: String(PROXY_PORT) },
  });
  backend.stderr.on("data", (d) => process.stderr.write(`[backend] ${d}`));

  try {
    // Backend hochfahren lassen und Target-Verbindung abwarten.
    await waitFor(async () => (await rest("GET", "/api/state")).target.state === "CONNECTED", 8000, "Godot-Target CONNECTED");
    console.log("== Setup: Backend läuft, Godot-Target verbunden ==");

    // ── 1) Durchleitung ──
    {
      let reply = null;
      const agent = agentClient((m) => { if (m.id === 1) reply = m; });
      await sleep(200); // Proxy hat Session als RUNNING registriert
      agent.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "runtime_ux_scan", arguments: {} } });
      await waitFor(() => reply !== null, 5000, "Passthrough-Antwort");
      check("Durchleitung: Antwort von Godot erreicht den Agent", reply?.result?.content?.[0]?.text === "fake-ok:runtime_ux_scan");
      agent.close();
      await sleep(150); // Backend hat Session auf IDLE zurückgesetzt
    }

    // ── 2) PAUSE als Systemzustand ──
    {
      await rest("POST", "/api/commands", { type: "session.pause", payload: {} });
      let reply = null;
      const agent = agentClient((m) => { if (m.id === 2) reply = m; });
      await sleep(200);
      agent.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "runtime_ux_scan", arguments: {} } });
      await waitFor(() => reply !== null, 5000, "Pause-Ablehnung");
      check("PAUSE: Call wird abgelehnt (error -32003), Godot sieht nichts", reply?.error?.code === -32003, JSON.stringify(reply));
      await rest("POST", "/api/commands", { type: "session.resume", payload: {} });
      agent.close();
      await sleep(150);
    }

    // ── 3) Blockliste ──
    {
      await rest("POST", "/api/commands", { type: "tools.block", payload: { tools: ["runtime_eval"] } });
      let blocked = null, ok = null;
      const agent = agentClient((m) => { if (m.id === 3) blocked = m; if (m.id === 4) ok = m; });
      await sleep(200);
      agent.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "runtime_eval", arguments: {} } });
      agent.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "runtime_ux_scan", arguments: {} } });
      await waitFor(() => blocked !== null && ok !== null, 5000, "Blockliste-Ergebnisse");
      check("BLOCKLISTE: runtime_eval abgelehnt", blocked?.error?.code === -32003, JSON.stringify(blocked));
      check("BLOCKLISTE: anderes Tool läuft weiterhin", ok?.result?.content?.[0]?.text === "fake-ok:runtime_ux_scan");
      await rest("POST", "/api/commands", { type: "tools.unblock", payload: { tools: ["runtime_eval"] } });
      agent.close();
      await sleep(150);
    }

    // ── 4) Approval-Pflicht ──
    {
      let reply = null;
      const agent = agentClient((m) => { if (m.id === 5) reply = m; });
      await sleep(200);
      agent.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "runtime_autonomy_export", arguments: {} } });
      await waitFor(async () => (await rest("GET", "/api/approvals")).pending.includes("runtime_autonomy_export"), 5000, "Approval-Anfrage");
      check("APPROVAL: Anfrage im Backend sichtbar", true);
      await rest("POST", "/api/approvals/runtime_autonomy_export", { approved: true });
      await waitFor(() => reply !== null, 5000, "Approval-Durchleitung");
      check("APPROVAL: nach Freigabe läuft der Call durch", reply?.result?.content?.[0]?.text === "fake-ok:runtime_autonomy_export", JSON.stringify(reply));
      agent.close();
      await sleep(150);
    }

    // ── 5) Ziel setzen (Einfluss ohne Chat) ──
    {
      await rest("POST", "/api/commands", { type: "session.goal", payload: { goal: "Spiele das Hauptmenü durch und dokumentiere Bugs" } });
      const snap = await rest("GET", "/api/state");
      check("ZIEL: session.goal ist im zentralen State sichtbar", snap.agent.session.goal.includes("Hauptmenü"), snap.agent.session.goal);
    }

    console.log(failures === 0 ? "\nAlle Beweise erbracht." : `\n${failures} Beweis(e) fehlgeschlagen.`);
  } finally {
    backend.kill();
    fakeGodot.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
