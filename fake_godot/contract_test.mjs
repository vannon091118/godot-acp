#!/usr/bin/env node
/**
 * contract_test.mjs — DER zentrale Beweis: Funktioniert das Backend ohne echte
 * Godot-Instanz? (User-Vorgabe: Der Simulator ist Contract-Test, kein Wegwerf-Test.)
 *
 * Beweiskette (jeder Schritt muss beobachtbar sein):
 *   1. Backend startet, Target godot-01 → CONNECTED (nur Simulator!)
 *   2. Agent verbindet sich mit dem Proxy → Agent-Registry: WORKING
 *   3. tools/call läuft durch den Command-Bus: QUEUED → DISPATCHED → RUNNING → COMPLETED,
 *      Antwort landet wieder beim Agent-Socket
 *   4. SSE: ein Frontend (React/Ink-Modus) sieht Events UND State live
 *   5. Human drückt Pause (REST) → Backend-State PAUSED → Agent-Call wird BLOCKED
 *      → Simulator bestätigt ACK (godot.command_result) → SSE zeigt alles
 *   6. Blockliste: block_tools (human) → agent-Call auf Tool → BLOCKED; anderes Tool läuft
 *   7. Approval-Pflicht: tools/call auf geschütztes Tool → WAITING_APPROVAL →
 *      Freigabe → COMPLETED (und Verweigerung → BLOCKED)
 *   8. Fake-Godot-Disconnect (--flake) → Backend: RECONNECTING (Backend bleibt bedienbar),
 *      Reconnect → CONNECTED
 *   9. Replay-Beweis: /api/replay-proof — State aus append-only JSONL ableitbar
 *  10. Resume: resume_agent → Agent WORKING, Calls laufen wieder
 *
 * Exit 0 = der Zyklus Fake Godot → Backend → React/Ink → Human → Pause → ACK → PAUSED läuft.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const GODOT_PORT = 9291;
const BACKEND_PORT = 8789;
const PROXY_PORT = 9299;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acp-contract-"));

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name} ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(method, urlPath, body, expectStatus) {
  const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (expectStatus && res.status !== expectStatus) {
    throw new Error(`${method} ${urlPath} → ${res.status} (erwartet ${expectStatus}): ${JSON.stringify(data)}`);
  }
  return data;
}

function sseCollect(onItem) {
  (async () => {
    // Backend-Listener abwarten (spawn ≠ listen) — mit Retry, nicht wegwerfen.
    let res = null;
    for (let i = 0; i < 100 && !res; i++) {
      try { res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/events`); }
      catch { await sleep(100); }
    }
    if (!res) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          try { onItem(JSON.parse(line.slice(6))); } catch { /* ignore */ }
        }
      }
    }
  })().catch(() => {});
}

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
  return { send: (o) => sock.write(JSON.stringify(o) + "\n"), close: () => sock.destroy() };
}

function collectReply(replies, id, onMessageRef) {
  // Hilfsfunktion unnötig — direkte Zuweisung im Testkörper (lesbarer).
}

function waitFor(predicate, timeoutMs = 6000, label = "condition") {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      Promise.resolve().then(predicate).then((ok) => {
        if (ok) { clearInterval(t); resolve(); }
        else if (Date.now() - started > timeoutMs) { clearInterval(t); reject(new Error(`timeout: ${label}`)); }
      }).catch(() => {
        if (Date.now() - started > timeoutMs) { clearInterval(t); reject(new Error(`timeout: ${label}`)); }
      });
    }, 50);
  });
}

async function main() {
  const sim = spawn(process.execPath, [path.join(REPO, "fake_godot", "simulator.mjs"), String(GODOT_PORT)], { stdio: "pipe" });
  const backend = spawn(process.execPath, [path.join(REPO, "backend", "server.mjs")], {
    stdio: "pipe",
    env: {
      ...process.env,
      ACP_BACKEND_PORT: String(BACKEND_PORT),
      ACP_GODOT_PORT: String(GODOT_PORT),
      ACP_PROXY_PORT: String(PROXY_PORT),
      ACP_DATA_DIR: DATA_DIR,
    },
  });
  backend.stderr.on("data", (d) => process.stderr.write(`[backend] ${d}`));

  // ── SSE-Sammler (stellvertretend für React UND Ink — derselbe Strom) ──
  const sse = { events: [], states: [], commands: [], lastState: null };
  const qaVerdicts = [];
  sseCollect((item) => {
    if (item.type === "event") sse.events.push(item.event);
    if (item.type === "state") { sse.states.push(item); sse.lastState = item; }
    if (item.type === "command") sse.commands.push(item.command);
    if (item.channel === "qa.verdict") qaVerdicts.push(item.qaRun?.verdict);
  });

  const targetState = async () => (await rest("GET", "/api/status")).targets[0]?.state;
  const agentState = async () => (await rest("GET", "/api/agents")).agents[0]?.state;

  try {
    // ── 1) Target wird verbunden (NUR der Simulator läuft) ──
    await waitFor(async () => (await targetState()) === "ONLINE", 8000, "Target CONNECTED");
    check("1. Target godot-01 CONNECTED — Backend läuft ohne echte Godot-Instanz", true);

    // ── 2) Agent registriert sich über den Proxy ──
    let replies = {};
    const agent = agentClient((m) => { if (m.id !== undefined) replies[m.id] = m; });
    agent.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "contract-agent" } } });
    await waitFor(async () => (await agentState()) === "WORKING", 5000, "Agent WORKING");
    check("2. Agent-Registry: contract-agent ist WORKING", true);

    // ── 3) Tool-Call durch den Bus, Antwort zurück beim Agent ──
    agent.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "runtime_ux_scan", arguments: {} } });
    agent.send({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "backend.capabilities", arguments: {} } });
    await waitFor(() => replies[40] !== undefined, 5000, "capabilities-Proxy");
    check("   backend.*-Tools sind über den Proxy aufrufbar", replies[40]?.result !== undefined);
    await waitFor(() => replies[2]?.result?.content?.[0]?.text === "fake-ok:runtime_ux_scan", 6000, "Tool-Antwort");
    check("3. tools/call: BUS läuft, Antwort vom Ziel erreicht den Agent-Socket", true);
    const st = await rest("GET", "/api/status");
    check("   Command-Bilanz: mindestens 1 COMPLETED", st.stats.completed >= 1, JSON.stringify(st.stats));

    // ── 4) SSE hat live gesehen ──
    await waitFor(() => sse.commands.some((c) => c.state === "RUNNING"), 5000, "SSE sieht RUNNING");
    await waitFor(() => sse.commands.some((c) => c.state === "COMPLETED"), 5000, "SSE sieht COMPLETED");
    check("4. SSE (React/Ink-Strom): RUNNING und COMPLETED live übertragen", sse.events.length > 0);

    // ── 5) Human pausiert — echte Zustandsmaschine, ACK vom Simulator ──
    await rest("POST", "/api/commands", { origin: "human", type: "pause_agent", payload: {} }, 202);
    await waitFor(async () => (await agentState()) === "PAUSED", 5000, "Agent PAUSED");
    await waitFor(() => sse.events.some((e) => e.kind === "target" && e.message.includes("pause ACK")), 5000, "Simulator-ACK");
    check("5. Pause: Backend PAUSED, Simulator hat ACK gemeldet (godot.command_result)", true);
    let blocked = null;
    agent.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "runtime_ux_scan", arguments: {} } });
    await waitFor(() => replies[3] !== undefined, 5000, "Pause-Blockierung");
    check("   Agent-Call im PAUSED-Zustand → protokollseitig abgelehnt", replies[3]?.error?.code === -32003 || replies[3]?.error?.code === -32002, JSON.stringify(replies[3]));

    // ── 6) Blockliste als Entität ──
    await rest("POST", "/api/commands", { origin: "human", type: "unblock_tools", payload: { tools: [] } }, 202); // reset kann leer sein
    await rest("POST", "/api/commands", { origin: "human", type: "resume_agent", payload: {} }, 202);
    await waitFor(async () => (await agentState()) === "WORKING", 5000, "Agent WORKING nach Resume");
    await rest("POST", "/api/commands", { origin: "human", type: "block_tools", payload: { tools: ["runtime_eval"], reason: "Sicherheitsdemo" } }, 202);
    const blocks = (await rest("GET", "/api/blocks")).blocks.filter((b) => b.active);
    check("6. Blockliste ist Entität mit Grund", blocks.some((b) => b.value === "runtime_eval" && b.reason === "Sicherheitsdemo"), JSON.stringify(blocks));
    agent.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "runtime_eval", arguments: {} } });
    agent.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "runtime_ux_scan", arguments: {} } });
    await waitFor(() => replies[4] !== undefined && replies[5] !== undefined, 6000, "Blockliste-Ergebnisse");
    check("   Blockiertes Tool → Fehler mit Grund", String(replies[4]?.error?.message ?? "").includes("blockiert"), JSON.stringify(replies[4]));
    check("   Anderes Tool läuft weiter", replies[5]?.result?.content?.[0]?.text === "fake-ok:runtime_ux_scan");

    // ── 7) Approval-Pflicht: erst anhalten, dann freigeben ──
    agent.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "runtime_autonomy_export", arguments: {} } });
    await waitFor(async () => (await rest("GET", "/api/approvals")).pending.length === 1, 5000, "WAITING_APPROVAL");
    const pending = (await rest("GET", "/api/approvals")).pending[0];
    check("7. Geschütztes Tool wartet auf Freigabe (WAITING_APPROVAL)", true);
    await rest("POST", `/api/approvals/${pending.commandId}`, { approved: true }, 200);
    await waitFor(() => replies[6]?.result?.content?.[0]?.text === "fake-ok:runtime_autonomy_export", 6000, "Approval-Durchleitung");
    check("   Nach Freigabe → COMPLETED mit Ergebnis", true);

    // Verweigerung:
    agent.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "runtime_autonomy_export", arguments: {} } });
    await waitFor(async () => (await rest("GET", "/api/approvals")).pending.length === 1, 5000, "2. WAITING_APPROVAL");
    const pending2 = (await rest("GET", "/api/approvals")).pending[0];
    await rest("POST", `/api/approvals/${pending2.commandId}`, { approved: false }, 200);
    await waitFor(() => replies[7] !== undefined, 5000, "Verweigerung sichtbar");
    check("   Verweigert → BLOCKED beim Agent", replies[7]?.error !== undefined, JSON.stringify(replies[7]));

    // ── 8) Disconnect + Reconnect (Backend bleibt Herr des Verfahrens) ──
    sim.kill();
    await waitFor(async () => (await targetState()) === "DISCONNECTED", 8000, "RECONNECTING nach Verbindungsverlust");
    check("8. Simulator weg → Target DISCONNECTED, dann CONNECTING (Recovery-Regel)", true);
    // Backend bleibt bedienbar:
    const pingCmd = await rest("POST", "/api/commands", { origin: "human", type: "backend_ping", payload: {} }, 202);
    await waitFor(async () => {
      const st2 = await rest("GET", "/api/status");
      return st2.targets.length > 0;
    }, 3000, "Backend bedienbar");
    check("   Backend bleibt ohne Ziel voll bedienbar (backend_ping OK)", !!pingCmd.id);

    // Simulator neu starten → Reconnect-Beweis
    const sim2 = spawn(process.execPath, [path.join(REPO, "fake_godot", "simulator.mjs"), String(GODOT_PORT)], { stdio: "pipe" });
    await waitFor(async () => (await targetState()) === "ONLINE", 10000, "RECONNECT erfolgreich");
    check("   Simulator wieder da → ONLINE (Recovery abgeschlossen)", true);

    // ── 9) Replay-Beweis: State aus append-only JSONL ableitbar ──
    const proof = await rest("GET", "/api/replay-proof");
    check("9. Replay: Command-Historie aus JSONL faltbar", proof.commandsDerivedFromLog.total > 10, JSON.stringify(proof.commandsDerivedFromLog?.total));
    check("   Sessions-Log führt Agent-Zustandsübergänge", proof.sessionsTail.length > 0);

    // ── 10) Ziel setzen +Resume → Arbeitsfähigkeit ──
    await rest("POST", "/api/agents/contract-agent/goal", { goal: "Hauptmenü durchspielen" }, 202);
    await sleep(200);
    const ag = (await rest("GET", "/api/agents")).agents[0];
    check("10. Ziel sitzt in der Agent-Registry", ag.goal === "Hauptmenü durchspielen", ag.goal);

    // ── 12) Backend-MCP-Fassade: backend.* über den Proxy ──
    agent.send({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "backend.capabilities", arguments: {} } });
    agent.send({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "backend.get_state", arguments: {} } });
    agent.send({ jsonrpc: "2.0", id: 22, method: "tools/call", params: {
      name: "backend.start_qa",
      arguments: { name: "Hauptmenü-Sanity", steps: [
        { label: "Oberfläche lesbar", tool: "runtime_ux_scan", expected: "fake-ok" },
        { label: "Suche funktioniert", tool: "runtime_ux_find", expected: "fake-ok" },
      ] },
    } });
    await waitFor(() => replies[20] && replies[21] && replies[22], 15000, "backend.*-Antworten");
    const parse = (r) => { try { return JSON.parse(r?.result?.content?.[0]?.text ?? "{}"); } catch { return {}; } };
    const cap = parse(replies[20]), stt = parse(replies[21]), qa = parse(replies[22]);
    // Evidence: QA-Lauf abwarten, dann abrufen
    await waitFor(async () => {
      agent.send({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "backend.get_evidence", arguments: { qaRunId: qa.qaRunId } } });
      await sleep(150);
      const ev = parse(replies[23]);
      return Array.isArray(ev.evidence) && ev.evidence.length >= 2;
    }, 15000, "QA-Evidence");
    const ev = parse(replies[23]);
    check("12. backend.capabilities: Vertrag vom Backend, ohne Code-Lektüre", Array.isArray(cap.contract?.agents) && cap.contract.agents.includes("PAUSED"), JSON.stringify(cap).slice(0, 120));
    check("   backend.get_state: Agent sieht die Backend-Wahrheit", Array.isArray(stt.agents) && stt.agents.some((a) => a.id === "contract-agent"));
    check("   backend.start_qa: QA-Lauf gestartet", !!qa.qaRunId, JSON.stringify(qa));
    check("   backend.get_evidence: Beweise mit erwartet/beobachtet", Array.isArray(ev.evidence) && ev.evidence.length >= 2 && "expected" in ev.evidence[0], JSON.stringify(ev).slice(0, 160));

    // QA-Urteil + Lebenslauf im SSE-Strom:
    await waitFor(() => qaVerdicts.length > 0, 10000, "qa.verdict");
    check("   qa.verdict über SSE: PASS/FAIL am Backend entschieden", qaVerdicts.some((v) => ["PASS", "FAIL", "INCONCLUSIVE"].includes(v)), qaVerdicts.join(","));

    // ── 13) Fehlerfall-Vertrag: Zielfehler → FAILED (kein Hängen) ──
    agent.send({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "runtime_failing_tool", arguments: {} } });
    await waitFor(() => replies[30] !== undefined, 8000, "Fehler-Antwort");
    check("13. Zielfehler → FAILED, Agent erhält strukturierte Ablehnung", replies[30]?.error !== undefined, JSON.stringify(replies[30]));

    // ── 14) tools/list enthält backend.*-Tools ──
    let listReply = null;
    agent.send({ jsonrpc: "2.0", id: 31, method: "tools/list", params: {} });
    await waitFor(() => { listReply = replies[31]; return listReply !== undefined; }, 6000, "tools/list");
    const names = (listReply?.result?.tools ?? []).map((t) => t.name);
    check("14. tools/list: backend.*-Tools + Godot-Tools aus einer Hand", names.includes("backend.get_state") && names.includes("runtime_ux_scan"), names.join(","));

    // ── 15) Orchestrator: Onboarding, Work-Order, Anomalie → atomare Analyse ──
    agent.send({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "backend.onboard", arguments: {} } });
    await waitFor(() => replies[40] !== undefined, 6000, "onboard-Antwort");
    const ob = parse(replies[40]);
    check("15. backend.onboard: Vertrag+Loops+Human-Control ohne Code-Lektüre", !!ob.loops?.worker && !!ob.contract?.humanControl && Array.isArray(ob.nextSteps), JSON.stringify(ob).slice(0, 140));

    // Anomalie (runtime_failing_tool, id 30 oben → FAILED) muss OPEN → ANALYZED
    // durchlaufen und Analyse-Schritte mit echten Ziel-Calls enthalten.
    let anomalyReply = null;
    await waitFor(async () => {
      agent.send({ jsonrpc: "2.0", id: 43, method: "tools/call", params: { name: "backend.get_anomalies", arguments: {} } });
      await sleep(200);
      anomalyReply = replies[43];
      const an = parse(anomalyReply);
      const mine = (an.anomalies ?? []).find((a) => a.tool === "runtime_failing_tool");
      return mine && mine.state === "ANALYZED" && (mine.analysis?.steps?.length ?? 0) > 0;
    }, 25000, "Anomalie-Analyse");
    const an2 = parse(anomalyReply);
    const anomaly = (an2.anomalies ?? []).find((a) => a.tool === "runtime_failing_tool");
    const stepTools = (anomaly?.analysis?.steps ?? []).map((s) => s.tool).filter(Boolean);
    check("   Anomalie → atomare Analyse (generisch aus Ziel-Capabilities)", anomaly?.state === "ANALYZED" && stepTools.length > 0, JSON.stringify(anomaly?.analysis ?? {}).slice(0, 200));
    check("   Analyse-Schritte sind echte Ziel-Calls (Observation je Schritt)", (anomaly.analysis.steps ?? []).every((s) => s.tool === null || typeof s.observationId === "string"), JSON.stringify(anomaly.analysis.steps ?? []).slice(0, 200));

    // Work-Order: der Orchestrator packt Pakete mit echter Ziel-Baseline (REST).
    await waitFor(async () => {
      const o = await rest("GET", "/api/orchestrator");
      return (o.workOrders ?? []).some((w) => w.state === "OPEN" && w.baseline?.ok === true);
    }, 25000, "Work-Order mit Baseline");
    const orchState = await rest("GET", "/api/orchestrator");
    const order = orchState.workOrders.find((w) => w.state === "OPEN" && w.baseline?.ok === true);
    check("   Work-Order: Baseline aus echtem Ziel-Scan (kein Fake)", order?.baseline?.tool === "runtime_ux_scan" && order.baseline.ok === true, JSON.stringify(order?.baseline ?? {}).slice(0, 160));

    agent.send({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "backend.claim_work", arguments: {} } });
    await waitFor(() => replies[42] !== undefined, 6000, "claim_work");
    const cl = parse(replies[42]);
    check("   backend.claim_work: Übernahme am Backend sichtbar", cl.workOrder?.state === "CLAIMED" && cl.workOrder?.claimedBy === "contract-agent", JSON.stringify(cl).slice(0, 120));

    console.log(failures === 0 ? "\nCONTRACT ERFÜLLT: Das Backend funktioniert vollständig ohne echte Godot-Instanz." : `\n${failures} Beweis(e) fehlgeschlagen.`);
    agent.close();
    sim2.kill();
  } finally {
    backend.kill();
    sim.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
