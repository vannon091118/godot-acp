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
import {
  requireTransition, sseFrame,
  TARGET_STATES, AGENT_STATES, COMMAND_STATES, QA_STATES, ORIGINS,
  TARGET_WORDS, AGENT_WORDS, COMMAND_WORDS, QA_WORDS, humanTool,
  SSE_CHANNELS, ANOMALY_STATES, WORK_STATES,
} from "./contract.mjs";

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

/** Korrelations-ID — verknüpft Commands, Events, QA-Runs, Evidence. */
const correlate = (base) => base;

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
  /** QA-Runs + Evidence (Vertrag: QaRun, Evidence, Verdict). */
  qaRuns: new Map(),
  /** Anomalien (Orchestrator): FAILED/TIMEOUT/isError → atomare Analyse. */
  anomalies: new Map(),  // id -> {id, kind, severity, state, source, message, commandId, tool, correlation, origin, createdAt, updatedAt, analysis}
  /** Work-Orders: vom Orchestrator gepackte Arbeitspakete (endet nicht). */
  workOrders: new Map(), // id -> {id, state, origin, goal, correlation, baseline, nextSteps, note, createdAt, updatedAt}
  /** Beobachtungen (Vertrag: Observation) — jede Ziel-Antwort wird eine. */
  observations: [],      // Ring: {id, at, targetId, tool, ok, summary, commandId}
  /** Live-Feed (Ring). */
  events: [],
  stats: { completed: 0, blocked: 0, failed: 0, timeout: 0, rejected: 0, eventsSeen: 0 },
};

const MAX_EVENTS = 500;
const MAX_COMMANDS = 300;

// Targets: konfiguriertes Standardziel registrieren (Vertrag: OFFLINE initial).
state.targets.set(TARGET_ID, {
  id: TARGET_ID, kind: "godot", state: "OFFLINE",
  host: GODOT_HOST, port: GODOT_PORT, lastSeenAt: null, lastError: null,
});

/* ───────────────── QA-Runs (Contract: QaRun · Evidence · Verdict) ───── */

function createQaRun({ name, steps, createdBy }) {
  const run = {
    id: nextId("qa"),
    name: String(name || "QA-Lauf"),
    state: "CREATED",
    origin: "qa",
    createdBy: createdBy || "human",
    steps: (steps ?? []).map((s) => ({
      label: String(s.label ?? s),
      tool: String(s.tool ?? "runtime_ux_scan"),
      expected: String(s.expected ?? ""),
      state: "PENDING",
    })),
    evidence: [],
    verdict: null,
    createdAt: now(),
    updatedAt: now(),
  };
  state.qaRuns.set(run.id, run);
  appendOnly(logEvents, { ts: now(), kind: "qa", message: `QA angelegt: ${run.name}`, qaRunId: run.id, qaState: run.state });
  broadcast(sseFrame("qa.progress", { qaRun: publicQa(run) }));
  broadcastState();
  return run;
}

function publicQa(run) {
  return {
    id: run.id, name: run.name, state: run.state, verdict: run.verdict,
    steps: run.steps.map((s) => ({ label: s.label, tool: s.tool, state: s.state, expected: s.expected, observed: s.observed })),
    evidence: run.evidence,
    createdAt: run.createdAt, updatedAt: run.updatedAt,
  };
}

function qaTransition(run, to, extra = {}) {
  requireTransition("qa", run.state, to);
  run.state = to;
  run.updatedAt = now();
  Object.assign(run, extra);
  appendOnly(logEvents, { ts: now(), kind: "qa", message: `QA ${run.name}: ${to}`, qaRunId: run.id, qaState: to });
  const channel = to === "PASS" || to === "FAIL" || to === "INCONCLUSIVE" ? "qa.verdict" : "qa.progress";
  broadcast(sseFrame(channel, { qaRunId: run.id, qaRun: publicQa(run) }));
  if (to === "PASS" || to === "FAIL" || to === "INCONCLUSIVE") {
    pushEvent("qa", `QA-Urteil: ${run.name} → ${to}`, { qaRunId: run.id, verdict: to });
  }
}

/**
 * QA-Ausführung: Beobachten (Tools, origin=qa über den Bus) → Prüfen → Beweis.
 */
async function executeQaRun(run) {
  qaTransition(run, "RUNNING");
  let anyFail = false;
  for (let i = 0; i < run.steps.length; i++) {
    const step = run.steps[i];
    if (run.state === "CANCELLED") return;
    // Vertrag: jeder Schritt = OBSERVING → ASSERTING; nach dem letzten
    // Schritt geht ASSERTING → EVIDENCE → Urteil.
    qaTransition(run, "OBSERVING");
    const result = await dispatchToolCallAwait({ origin: "qa", tool: step.tool, payload: {} });
    qaTransition(run, "ASSERTING");
    const observed = String(result?.content?.[0]?.text ?? result?.__error ?? "");
    const ok = result?.__error ? false : step.expected ? observed.toLowerCase().includes(step.expected.toLowerCase()) : true;
    step.state = ok ? "PASS" : "FAIL";
    step.observed = observed.slice(0, 200);
    if (!ok) anyFail = true;
    const evidence = {
      step: step.label,
      tool: step.tool,
      expected: step.expected || "(Aufruf darf nicht fehlschlagen)",
      observed: step.observed || "—",
      ok,
      ts: now(),
      commandId: result?.__commandId ?? null,
      qaRunId: run.id,
    };
    run.evidence.push(evidence);
    broadcast(sseFrame("evidence.ready", { qaRunId: run.id, evidence }));
    appendOnly(logEvents, { ts: now(), kind: "evidence", message: `Beweis: ${step.label} → ${ok ? "ok" : "Fehler"}`, ...evidence });
  }
  qaTransition(run, "EVIDENCE");
  qaTransition(run, anyFail ? "FAIL" : "PASS", { verdict: anyFail ? "FAIL" : "PASS" });
}

/** Tool-Call über den Bus, dessen Endergebnis der Aufrufer abwartet. */
function dispatchToolCallAwait({ origin, tool, payload }) {
  return new Promise((resolve) => {
    const cmd = createCommand({ origin, type: tool, payload, tool });
    cmd.qaResolve = resolve;
  });
}

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
    qaRuns: [...state.qaRuns.values()].map(publicQa),
    orchestrator: {
      running: !!ORCH.timer, analyzing: ORCH.analyzing,
      intervalMs: ORCH.intervalMs, lastTickAt: ORCH.lastTickAt, lastFullScanAt: ORCH.lastFullScanAt,
      capabilitiesCount: ORCH.capabilities.length, capabilities: ORCH.capabilities,
      stats: { ...ORCH.workStats },
      anomalies: [...state.anomalies.values()].map((a) => ({ ...a })),
      workOrders: [...state.workOrders.values()].map((w) => ({ ...w })),
      observations: state.observations.slice(-30),
    },
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
  requireTransition("command", cmd.state, to);
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
    settleQaResult(cmd);
    // Orchestrator-Aufrufe (Anomalie-Analyse, Work-Baseline) warten auf das Ende.
    if (cmd.__resolve) {
      const resolve = cmd.__resolve;
      cmd.__resolve = null;
      resolve({ ok: to === "COMPLETED", result: cmd.__targetResult ?? null, reason: cmd.reason });
    }
    // Echte Anomalie? (nicht die Analyse-Calls selbst, nicht interne Verben)
    if ((to === "FAILED" || to === "TIMEOUT") && cmd.tool && !cmd.payload?.__anomalyId && !cmd.payload?.__workOrderId) {
      recordAnomaly({
        kind: to === "TIMEOUT" ? "target_timeout" : "command_failed",
        severity: "high",
        source: cmd.origin,
        message: cmd.reason ?? "Ziel-Command endete fehlerhaft",
        commandId: cmd.id,
        tool: cmd.tool,
        correlation: cmd.id,
      });
    }
    broadcast(sseFrame(to === "COMPLETED" ? "command.completed" : "command.completed", {
      command: publicCommand(cmd),
    }));
  } else if (to === "RUNNING") {
    broadcast(sseFrame("command.started", { command: publicCommand(cmd) }));
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

/** QA wartet auf Endergebnisse (Contract: qa.progress/verdict braucht Resultate). */
function settleQaResult(cmd) {
  if (!cmd.qaResolve) return;
  const resolve = cmd.qaResolve;
  cmd.qaResolve = null;
  resolve(cmd.__targetResult ?? { __error: cmd.reason ?? cmd.state, __commandId: cmd.id });
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
        appendOnly(logEvents, { ts: now(), kind: "block", scope: "tool", value: String(tool), message: `Werkzeug blockiert: ${tool}`, event: "gesetzt", origin: cmd.origin });
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
  // Echte Pausen-Maschine: REQUESTED erst, PAUSED erst nach Ziel-ACK (oder Sofort-
  // Wirkung am Backend — die Autorität hängt nicht vom ACK ab).
  if (agentState === "PAUSED" && agent.state !== "PAUSED") {
    setAgentState(agent, "PAUSE_REQUESTED");
    setAgentState(agent, "PAUSED");
  } else if (agentState === "WORKING") {
    if (agent.state === "PAUSED") setAgentState(agent, "WORKING");
  } else if (agentState === "STOPPED" || agentState === "STOP_REQUESTED") {
    if (agent.state !== "STOPPED") {
      setAgentState(agent, agent.state === "WORKING" || agent.state === "WAITING" ? "PAUSE_REQUESTED" : agent.state);
      // Direkt über den Vertrag: WORKING→STOPPED existiert, PAUSE_REQUESTED→STOPPED auch.
      if (agent.state !== "STOPPED") setAgentState(agent, "STOPPED");
    }
  }
  connector.notifyTarget(cmd.targetId, notifyMethod, { agentId: agent.id });
  transition(cmd, "COMPLETED", `agent ${agent.id} → ${agent.state}`);
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

/**
 * Tool-Calls (origin agent|human|qa) — hier greifen Pause, Blockliste, Approval.
 * Prüfungen laufen VOR dem ersten Transition-Sprung (CREATED → QUEUED passiert
 * im createCommand; jede Ablehnung geht QUEUED → BLOCKED nach Vertrag).
 */
function dispatchToolCall(cmd) {
  const agent = cmd.agentId ? state.agents.get(cmd.agentId) : null;

  // 0) Vorvertragliche Prüfung: Aus QUEUED direkt blocken/canceln (erlaubt).
  const rejectBlocked = (reason) => {
    cmd.transitions.push({ from: cmd.state, to: "DISPATCHED", at: now() });
    cmd.state = "DISPATCHED";
    transition(cmd, "BLOCKED", reason);
  };
  const rejectCancelled = (reason) => {
    cmd.transitions.push({ from: cmd.state, to: "DISPATCHED", at: now() });
    cmd.state = "DISPATCHED";
    transition(cmd, "CANCELLED", reason);
  };

  // 1) Agent-Zustand ist echte Wahheit — kein Theater.
  if (agent && (agent.state === "PAUSED" || agent.state === "PAUSE_REQUESTED")) {
    rejectBlocked("Agent pausiert (Nutzerentscheidung)");
    return;
  }
  if (agent && (agent.state === "STOPPED" || agent.state === "STOP_REQUESTED")) {
    rejectBlocked("Agent wird beendet");
    return;
  }

  // 2) Blockliste — ebenfalls echte Entitäten.
  for (const b of state.blocks.values()) {
    if (!b.active) continue;
    if (b.scope === "tool" && b.value === cmd.tool) {
      rejectBlocked(`Werkzeug blockiert: ${b.reason}`);
      return;
    }
    if (b.scope === "agent" && (b.value === "*" || b.value === cmd.agentId)) {
      rejectBlocked(`Agent gesperrt: ${b.reason}`);
      return;
    }
  }

  // 3) Freigabepflichtige Werkzeuge — WAITING nach Vertrag (DISPATCHED → WAITING).
  if (needsApproval(cmd.tool) && !cmd.payload?.__approved) {
    transition(cmd, "DISPATCHED");
    transition(cmd, "WAITING", "Freigabe durch Nutzer erforderlich");
    state.approvals.set(cmd.id, { commandId: cmd.id, tool: cmd.tool, agentId: cmd.agentId, requestedAt: now() });
    pushEvent("approval", `Freigabe angefragt: ${cmd.tool}`, { commandId: cmd.id, tool: cmd.tool });
    broadcastState();
    setTimeout(() => {
      if (state.approvals.has(cmd.id)) {
        state.approvals.delete(cmd.id);
        transition(cmd, "CANCELLED", "Freigabe nicht rechtzeitig erteilt (Timeout)");
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
  if (!target || target.state !== "ONLINE" || !connector.isOpen(cmd.targetId)) {
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
  const { __approved, __anomalyId, __workOrderId, ...rest } = payload ?? {};
  return rest;
}

/** MCP-Ergebnis mit isError:true bzw. ERROR/BLOCKED-Text ist ein echter Fehler. */
function isErrorResult(result) {
  if (!result || typeof result !== "object") return false;
  if (result.isError === true) return true;
  const content = Array.isArray(result.content) ? result.content : [];
  return content.some((c) => typeof c?.text === "string" && /^\s*(BLOCKED|ERROR)\b/i.test(c.text));
}

function resultText(result) {
  if (!result || typeof result !== "object") return "";
  return (Array.isArray(result.content) ? result.content : [])
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .join(" | ");
}

/** Antwort des Ziels auf einen laufenden Command. */
function settleTargetResponse(wireId, msg) {
  const cmd = pendingByWire.get(wireId);
  if (!cmd) return;
  pendingByWire.delete(wireId);
  cmd.__targetResult = msg.error ? { __error: msg.error.message ?? "Zielfehler" } : msg.result;
  cmd.__commandId = cmd.id;
  const failText = msg.error
    ? (msg.error.message ?? "Zielfehler")
    : isErrorResult(msg.result) ? (resultText(msg.result).slice(0, 300) || "Ziel meldete isError") : null;
  // Jede Ziel-Antwort wird eine Observation (Vertrag: Observation-Entity).
  recordObservation({
    targetId: cmd.targetId,
    tool: cmd.tool ?? cmd.type,
    ok: !failText,
    summary: failText ? `Fehler: ${failText}` : summarizeResult(msg.result),
    commandId: cmd.id,
  });
  if (failText) transition(cmd, "FAILED", failText);
  else transition(cmd, "COMPLETED");
}

const pendingByWire = new Map();

/* ═════════════════════ Orchestrator (Backend ist Worker-Boss) ══════════ */
/**
 * Zentralisierungsdoktrin:
 *  - Das Backend ENDET NICHT: eine Dauerschleife beobachtet das System und
 *    passt ihr Verhalten an (Intervall reagiert auf Anomalien/QA/Offline).
 *  - Fragmentierung auf Mindestmaß: es gibt GENAU EINEN Binding-Pfad zu
 *    Ziel-Tools — die generische Tools/list des Ziels. Analyse-/Work-Calls
 *    sind normale Commands (origin=system), keine Parallelarchitektur.
 *  - Normalbetrieb ist billig: Beobachtung + gepackte Work-Orders.
 *    NUR bei Anomalie (FAILED/TIMEOUT/isError) triggert ATOMARE Analyse —
 *    generisch aus den Ziel-Capabilities (vision/ocr/audio/debug/ux).
 */

const ORCH = {
  timer: null,
  analyzing: false,
  lastTickAt: null,
  lastFullScanAt: null,
  intervalMs: 5000,
  capabilities: [],        // generisch aus Ziel-tools/list (keine Hardcodes)
  capabilitiesAt: null,
  workStats: { orders: 0, anomalies: 0, analyses: 0, completed: 0 },
};

const ANALYSIS_PATTERNS = ["vision", "screenshot", "image", "capture", "ocr", "text", "read", "audio", "sound", "debug", "inspect", "eval", "state", "ux", "scan", "logs", "trace"];
const OBSERVATION_KINDS = new Set(["target", "command_result", "qa", "evidence", "timeout", "block", "approval", "agent", "system"]);

function observeIntervalMs() {
  // Adaptives Verhalten: eng bei Anomalien/QA/Offline, sonst ruhig.
  const openAnomalies = [...state.anomalies.values()].filter((a) => a.state === "OPEN").length;
  const anyQa = [...state.qaRuns.values()].some((r) => !["ARCHIVED", "CANCELLED"].includes(r.state));
  if (ORCH.analyzing || openAnomalies > 0) return 2000;
  if (anyQa) return 3000;
  const t = state.targets.get(TARGET_ID);
  return t?.state === "ONLINE" ? 5000 : 15000;
}

function startOrchestrator() {
  if (ORCH.timer) clearTimeout(ORCH.timer);
  ORCH.timer = setTimeout(async function tick() {
    ORCH.lastTickAt = now();
    try { await orchestratorTick(); } catch (e) { pushEvent("system", `Orchestrator-Tick-Fehler: ${e.message}`); }
    ORCH.intervalMs = observeIntervalMs();
    startOrchestrator();
  }, ORCH.intervalMs);
  ORCH.timer.unref?.();
}

async function orchestratorTick() {
  const target = state.targets.get(TARGET_ID);
  const online = target?.state === "ONLINE" && connector.isTcpOpen(TARGET_ID);

  // 1) Offene Anomalien: atomare Analyse-Kette (ein Atomen-Call pro Schritt,
  //    Beobachtung zwischen den Schritten — dieselbe Disziplin wie der Player-Loop).
  if (online && !ORCH.analyzing) {
    const open = [...state.anomalies.values()].filter((a) => a.state === "OPEN");
    if (open.length > 0) {
      ORCH.analyzing = true;
      try { await analyzeAnomaly(open[0]); } finally { ORCH.analyzing = false; }
    }
  }

  // 2) Capabilities generisch binden (einmal pro Online-Phase).
  if (online) {
    if (!ORCH.capabilitiesAt || now() - ORCH.capabilitiesAt > 120000) await refreshTargetCapabilities();
    // 3) Work-Order-Paket, wenn der letzte Auftrag erledigt ist (endet nicht).
    const hasOpenWork = [...state.workOrders.values()].some((w) => w.state === "OPEN");
    if (!hasOpenWork) await createWorkOrder();
  }
}

/** Generisches Anbinden: Ziel-Tools/list -> Capability-Liste (kein Hardcode). */
async function refreshTargetCapabilities() {
  const tools = await targetToolsList(8000);
  if (tools) {
    ORCH.capabilities = tools;
    ORCH.capabilitiesAt = now();
    ORCH.lastFullScanAt = now();
  }
}

/** Ein Command, auf sein Ende gewartet — die einzige Orchestrierungsprimitve. */
function dispatchAndWait({ origin, type, tool = null, payload = {}, agentId = null, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    let cmd;
    try {
      cmd = createCommand({ origin, type, payload, agentId, tool });
    } catch (e) {
      resolve({ ok: false, result: null, reason: e.message });
      return;
    }
    cmd.__resolve = resolve;
    const to = setTimeout(() => {
      if (cmd.__resolve) { cmd.__resolve = null; resolve({ ok: false, result: null, reason: "orchestrator timeout" }); }
    }, timeoutMs);
    cmd.__orchTimeout = to;
    to.unref?.();
  });
}

/** Anomalie-Entity anlegen (idempotent pro Command). */
function recordAnomaly({ kind, severity, source, message, commandId, tool, correlation }) {
  if ([...state.anomalies.values()].some((a) => a.commandId === commandId)) return;
  const a = {
    id: nextId("anom"), kind, severity, state: "OPEN", source, message,
    commandId: commandId ?? null, tool: tool ?? null, correlation: correlation ?? commandId ?? null,
    origin: source, analysis: null,
    createdAt: now(), updatedAt: now(),
  };
  state.anomalies.set(a.id, a);
  ORCH.workStats.anomalies++;
  appendOnly(logEvents, { ts: now(), kind: "anomaly", message: `Anomalie ${a.id}: ${message}`, anomalyId: a.id, severity });
  broadcast(sseFrame("anomaly.opened", { anomaly: a }));
  broadcastState();
}

function recordObservation({ targetId, tool, ok, summary, commandId }) {
  const o = { id: nextId("obs"), at: now(), targetId, tool, ok, summary: String(summary ?? "").slice(0, 300), commandId: commandId ?? null };
  state.observations.push(o);
  if (state.observations.length > 100) state.observations.shift();
  broadcast(sseFrame("observation.recorded", { observation: o }));
  return o;
}

function summarizeResult(result) {
  const t = resultText(result);
  if (t) return t.slice(0, 200);
  if (result && typeof result === "object") return JSON.stringify(result).slice(0, 200);
  return "leer";
}

/**
 * ATOMARE Analyse-Kette bei Anomalie — generisch aus den Ziel-Capabilities:
 * 1) Zustand sichern (Debug/State-Tool), 2) Sicht sichern (Vision/OCR/Audio),
 * 3) Logs lesen. Ein Atom pro Call, Observation nach jedem Schritt, Evidence
 * in der Anomalie. Kein Ergebnis wird erfunden — Misserfolg wird dokumentiert.
 */
async function analyzeAnomaly(a) {
  const tools = await targetToolNames();
  const pick = (patterns, exclude = []) => tools.find((t) =>
    !exclude.includes(t) && patterns.some((p) => t.toLowerCase().includes(p))) ?? null;

  // Generische Auswahl aus den ECHTEN Ziel-Tool-Namen — je mehr das Ziel
  // kann (vision/ocr/audio/debug), desto reicher die Analyse. Fehlt eine
  // Kategorie, wird der Schritt als "nicht verfügbar" dokumentiert.
  const stateTool = pick(["debug", "game_state", "runtime_state", "inspect", "eval", "summary"]);
  const visualTool = pick(["screenshot", "vision", "capture", "frame", "scan", "ux_scan"], ["ocr"]);
  const ocrTool = pick(["ocr", "text_read"]);
  const audioTool = pick(["audio", "sound", "mic"]);
  const logTool = pick(["logs", "log_read", "log_tail"]);

  a.state = "ANALYZING";
  a.updatedAt = now();
  a.analysis = { startedAt: now(), steps: [] };
  broadcastState();
  pushEvent("system", `Orchestrator: atomare Analyse für ${a.id} gestartet (${tools.length} Ziel-Tools verfügbar)`, { anomalyId: a.id });

  const runStep = async (label, tool, args) => {
    if (!tool) { a.analysis.steps.push({ label, tool: null, ok: false, note: "kein passendes Ziel-Tool (Capability nicht vorhanden)" }); return; }
    const res = await dispatchAndWait({ origin: "system", type: tool, tool, payload: { __anomalyId: a.id }, timeoutMs: 20000 });
    const obs = recordObservation({ targetId: TARGET_ID, tool, ok: res.ok, summary: res.ok ? summarizeResult(res.result) : res.reason, commandId: null });
    a.analysis.steps.push({ label, tool, ok: res.ok, observationId: obs.id, summary: obs.summary, reason: res.reason ?? null });
    a.updatedAt = now();
    broadcastState();
  };

  await runStep("Systemzustand sichern", stateTool, {});
  await runStep("Sicht sichern (Vision)", visualTool, {});
  if (ocrTool) await runStep("Text lesen (OCR)", ocrTool, {});
  if (audioTool) await runStep("Audio-Spur sichern", audioTool, {});
  await runStep("Logs lesen", logTool, {});

  a.state = "ANALYZED";
  a.updatedAt = now();
  a.analysis.finishedAt = now();
  ORCH.workStats.analyses++;
  appendOnly(logEvents, { ts: now(), kind: "anomaly", message: `Anomalie ${a.id} analysiert (${a.analysis.steps.length} Schritte)`, anomalyId: a.id, analyzed: true });
  broadcast(sseFrame("anomaly.analyzed", { anomaly: a }));
  broadcastState();
}

/** Ziel-Tool-Namen: generisch über eine echte tools/list-Anfrage ans Ziel. */
async function targetToolNames() {
  if (ORCH.capabilities.length) return ORCH.capabilities;
  const tools = await targetToolsList(8000);
  if (tools) { ORCH.capabilities = tools; ORCH.capabilitiesAt = now(); }
  return ORCH.capabilities;
}

/** Echte tools/list ans Ziel (gleicher Probe-Pfad wie beim Agent-tools/list). */
function targetToolsList(timeoutMs = 8000) {
  return new Promise((resolve) => {
    const target = state.targets.get(TARGET_ID);
    if (!target || target.state !== "ONLINE" || !connector.isOpen(TARGET_ID)) return resolve(null);
    const wireId = `probe-orch-${++orchProbeSeq}`;
    const to = setTimeout(() => {
      if (orchProbes.has(wireId)) { orchProbes.delete(wireId); resolve(null); }
    }, timeoutMs);
    to.unref?.();
    orchProbes.set(wireId, { resolve, to });
    connector.send(TARGET_ID, { jsonrpc: "2.0", id: wireId, method: "tools/list", params: {} });
  });
}
let orchProbeSeq = 0;
const orchProbes = new Map();

/** Work-Order: das Arbeitspaket des Orchestrators (endet nicht). */
async function createWorkOrder() {
  const order = {
    id: nextId("work"), state: "OPEN", origin: "system", correlation: null,
    goal: "Beobachtungslauf: Systemzustand prüfen, Anomalien verhindern",
    baseline: null, nextSteps: [], note: null,
    createdAt: now(), updatedAt: now(),
  };
  ORCH.workStats.orders++;

  const scanTool = ORCH.capabilities.find((t) => t.includes("ux") && t.includes("scan")) ?? ORCH.capabilities.find((t) => t.includes("scan")) ?? null;
  if (scanTool) {
    const res = await dispatchAndWait({ origin: "system", type: scanTool, tool: scanTool, payload: { __workOrderId: order.id }, timeoutMs: 20000 });
    const obs = recordObservation({ targetId: TARGET_ID, tool: scanTool, ok: res.ok, summary: res.ok ? summarizeResult(res.result) : res.reason, commandId: null });
    order.baseline = { tool: scanTool, observationId: obs.id, ok: res.ok, summary: obs.summary };
  } else {
    order.baseline = { tool: null, ok: false, summary: "kein Scan-Tool am Ziel verfügbar" };
  }
  order.nextSteps = [
    "Agent kann das Paket übernehmen (backend.get_work / backend.claim_work)",
    "Human kann Ziel/Blocklist/Ampel über Dashboard setzen",
  ];
  order.updatedAt = now();
  // Erst veröffentlichen, wenn die Baseline steht (kein sichtbares Halbwissen).
  state.workOrders.set(order.id, order);
  appendOnly(logEvents, { ts: now(), kind: "work", message: `Work-Order ${order.id} gepackt`, workOrderId: order.id });
  broadcast(sseFrame("work.created", { workOrder: order }));
  broadcastState();
}

/** Timeout-Sweeper: RUNNING-Commands, die nie antworten, sterben sauber. */
setInterval(() => {
  const t = now();
  for (const cmd of state.commands.values()) {
    if (cmd.state === "RUNNING" && t - cmd.updatedAt > COMMAND_TIMEOUT_MS) {
      if (cmd.wireId) pendingByWire.delete(cmd.wireId);
      transition(cmd, "FAILED", `keine Antwort vom Ziel nach ${Math.round(COMMAND_TIMEOUT_MS / 1000)}s (Timeout)`);
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
  requireTransition("agent", agent.state, to);
  const from = agent.state;
  agent.state = to;
  if (to === "WORKING" && !agent.startedAt) agent.startedAt = now();
  logAgentTransition(agent, from, to);
  pushEvent("agent", `Agent ${agent.id}: ${from} → ${to}`, { agentId: agent.id });
  broadcast(sseFrame("agent.activity", { agentId: agent.id, from, to, agent: { ...agent } }));
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
  let wireSeq = 0;
  // Adapter-Handshake: MCP-Ziele (echtes Godot) verlangen initialize vor dem
  // ersten Tool. ONNLINE ist erst nach Handshake wahr — sonst wäre "verbunden"
  // nur ein offener TCP-Port (verbotene Scheinwahrheit).
  const handshakes = new Map();  // targetId -> "pending" | "done"

  function isOpen(targetId) {
    return sockets.has(targetId) && handshakes.get(targetId) === "done";
  }

  function isTcpOpen(targetId) {
    return sockets.has(targetId);
  }

  function runHandshake(targetId) {
    handshakes.set(targetId, "pending");
    const wireId = `hs-${++wireSeq}`;
    send(targetId, { jsonrpc: "2.0", id: wireId, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "godot-acp-backend", version: "1.0.0" } } });
    setTimeout(() => {
      if (handshakes.get(targetId) === "pending") {
        // Kein Handshake-Antwort: Verbindung als nicht brauchbar behandeln.
        const sock = sockets.get(targetId);
        try { sock?.destroy(); } catch { /* egal */ }
      }
    }, 8000).unref?.();
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
    if (target.state === "OFFLINE" || target.state === "DISCONNECTED") {
      target.state = "CONNECTING";
      broadcastState();
    }
    const sock = net.connect(target.port, target.host);
    let buffer = "";

    sock.on("connect", () => {
      sockets.set(TARGET_ID, sock);
      runHandshake(TARGET_ID);
      // ONLINE erst nach Handshake — TCP allein ist kein "verbunden".
    });
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        target.lastSeenAt = now();
        if (target.state === "DEGRADED") core.onTargetStateChanged(TARGET_ID, "ONLINE", "Ping-Timeout behoben");
        try {
          const msg = JSON.parse(line);
          // Handshake-Antwort: erst jetzt gilt das Ziel als wirklich ONLINE.
          if (typeof msg.id === "string" && msg.id.startsWith("hs-")) {
            if (handshakes.get(TARGET_ID) === "pending") {
              handshakes.set(TARGET_ID, "done");
              core.onTargetConnected(TARGET_ID);
            }
            continue;
          }
          core.onTargetMessage(TARGET_ID, msg);
        } catch { /* kein JSON — Leben reicht */ }
      }
    });
    sock.on("error", (err) => { target.lastError = String(err.message || err); });
    sock.on("close", () => {
      if (sockets.get(TARGET_ID) === sock) {
        sockets.delete(TARGET_ID);
        handshakes.delete(TARGET_ID);
      }
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
          if (target?.state === "ONLINE") core.onTargetStateChanged(targetId, "DEGRADED", "Ziel antwortet nicht (Ping-Timeout)");
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

  return { connect, send, isOpen, isTcpOpen, notifyTarget, start, handlePong };
})();

/* ───────────────────── Kern: entscheidet aus Adapter-Meldungen ──────── */

const core = {
  onTargetConnected(targetId) {
    const target = state.targets.get(targetId);
    if (!target) return;
    const from = target.state;
    requireTransition("target", from, "ONLINE");
    target.state = "ONLINE";
    target.lastSeenAt = now();
    target.lastError = null;
    pushEvent("target", `godot.connected: ${targetId} (${target.host}:${target.port})`, { targetId, from });
    broadcast(sseFrame("godot.connected", { targetId, target: { ...target } }));
    broadcastState();
  },

  onTargetDisconnected(targetId, lastError) {
    const target = state.targets.get(targetId);
    if (!target) return;
    // Recovery-Regel: Target geht in DISCONNECTED, Reconnect-Lauf startet
    // (CONNECTING folgt automatisch). Laufenede Commands verrecken NICHT im
    // Hängen: Der Timeout-Sweeper beendet sie nach COMMAND_TIMEOUT_MS sauber.
    const from = target.state;
    if (from !== "DISCONNECTED") {
      requireTransition("target", from, "DISCONNECTED");
      target.state = "DISCONNECTED";
    }
    pushEvent("target", `godot.disconnected: ${targetId} — Reconnect-Lauf läuft`, { targetId, lastError });
    broadcast(sseFrame("godot.disconnected", { targetId, lastError }));
    setTimeout(() => {
      const t = state.targets.get(targetId);
      if (t?.state === "DISCONNECTED") {
        requireTransition("target", "DISCONNECTED", "CONNECTING");
        t.state = "CONNECTING";
        broadcastState();
      }
    }, 500);
    broadcastState();
  },

  onTargetStateChanged(targetId, to, reason) {
    const target = state.targets.get(targetId);
    if (!target || target.state === to) return;
    const from = target.state;
    requireTransition("target", from, to);
    target.state = to;
    pushEvent("target", `godot.state_changed: ${targetId} ${from} → ${to}`, { targetId, reason });
    broadcast(sseFrame("state.changed", { what: "target", targetId, from, to, target: { ...target } }));
    broadcastState();
  },

  onTargetMessage(targetId, msg) {
    // Ping-Management (Liveness, kein Fachzustand).
    if (msg.id === "acp-ping") { connector.handlePong(targetId); return; }

    // 1) Antwort auf eine Probe (tools/list)?
    if (typeof msg.id === "string" && msg.id.startsWith("probe-")) {
      if (settleProbeReply(msg.id, msg)) return;
      if (msg.id.startsWith("probe-orch-")) {
        const p = orchProbes.get(msg.id);
        if (p) {
          orchProbes.delete(msg.id);
          clearTimeout(p.to);
          p.resolve((msg.result?.tools ?? []).map((t) => String(t.name)).filter(Boolean));
          return;
        }
      }
    }

    // 2) Antwort auf einen laufenden Command?
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
      const backendTools = [
        { name: "backend.get_state", description: "Kompletter Backend-State (Targets, Agents, Blocks, QA-Runs, Stats)." },
        { name: "backend.capabilities", description: "Vertrag + Fähigkeiten + Loops — Discovery ohne Code-Lektüre." },
        { name: "backend.send_command", description: "Backend-Verben ausführen (pause/resume/goal/…, origin=agent)." },
        { name: "backend.observe", description: "Letzte Events + Ziel-Zustand beobachten." },
        { name: "backend.start_qa", description: "QA-Lauf starten (Steps mit expected-Erwartungen)." },
        { name: "backend.get_evidence", description: "Beweise eines QA-Laufs abrufen (erwartet/beobachtet/ok)." },
        { name: "backend.get_agent_activity", description: "Alle Agent-Sessions mit Zustand." },
        { name: "backend.onboard", description: "Onboarding: Vertrag, Fähigkeiten, Loops, Human-Control — alles, was ein externer Agent braucht, ohne Code zu lesen." },
        { name: "backend.get_work", description: "Aktuelles Arbeitspaket des Orchestrators abholen (Baseline, Ziel, nächste Schritte)." },
        { name: "backend.claim_work", description: "Arbeitspaket übernehmen (Status OPEN → CLAIMED)." },
        { name: "backend.get_anomalies", description: "Anomalien + Analyse-Beweise abrufen (vision/ocr/audio/debug-Kette)." },
      ];
      if (target?.state === "ONLINE" && connector.isOpen(agent.targetId)) {
        connector.send(agent.targetId, { ...msg, id: `probe-${msg.id}` });
        proxyReplies.set(`probe-${msg.id}`, { sock, agentMsgId: msg.id, backendTools });
      } else {
        writeMsg(sock, { jsonrpc: "2.0", id: msg.id, result: { tools: backendTools } });
      }
      return;
    }

    if (method === "tools/call") {
      const tool = String(msg.params?.name ?? "");

      // ── Backend-MCP-Fassade: backend.*-Tools bedienen die zentrale Welt. ──
      if (tool.startsWith("backend.")) {
        return handleBackendTool(sock, msg, agent, tool);
      }

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

/**
 * backend.* — MCP ist ab jetzt nur die Agent-Schnittstelle des zentralen
 * Systems. Der Agent sieht die Backend-Welt, nicht den Godot-Code.
 */
function handleBackendTool(sock, msg, agent, tool) {
  const args = msg.params?.arguments ?? {};
  const reply = (result) => writeMsg(sock, {
    jsonrpc: "2.0", id: msg.id,
    result: { content: [{ type: "text", text: JSON.stringify(result) }] },
  });

  switch (tool) {
    case "backend.get_state":
      return reply(snapshot());
    case "backend.capabilities":
      return reply({
        backend: "godot-acp 0.3.0",
        contract: { targets: TARGET_STATES, agents: AGENT_STATES, commands: COMMAND_STATES, qa: QA_STATES, origins: ORIGINS },
        backendTools: ["backend.get_state", "backend.send_command", "backend.observe", "backend.start_qa", "backend.get_evidence", "backend.get_agent_activity", "backend.capabilities"],
        godotToolsHint: "Godot-Fachtools via tools/list, sobald das Ziel ONLINE ist",
        loops: {
          observe_before_act: "ein Tool-Call pro Schritt; nach jedem Call backend.observe",
        },
      });
    case "backend.send_command": {
      const type = String(args.type ?? "");
      if (!COMMAND_VERBS.has(type)) {
        return reply({ error: `nur Backend-Verben erlaubt: ${[...COMMAND_VERBS].join(", ")}` });
      }
      const cmd = createCommand({ origin: "agent", type, payload: args.payload ?? {}, agentId: agent.id });
      return reply({ commandId: cmd.id, state: cmd.state });
    }
    case "backend.observe":
      return reply({
        events: state.events.slice(-Number(args.limit ?? 20)),
        target: state.targets.get(agent.targetId)?.state ?? "OFFLINE",
      });
    case "backend.start_qa": {
      const run = createQaRun({ name: args.name, steps: args.steps, createdBy: agent.id });
      executeQaRun(run).catch((e) => pushEvent("qa", `QA-Fehler: ${e.message}`, { qaRunId: run.id }));
      return reply({ qaRunId: run.id, state: run.state });
    }
    case "backend.get_evidence": {
      const run = args.qaRunId ? state.qaRuns.get(String(args.qaRunId)) : null;
      if (args.qaRunId && !run) return reply({ error: `unbekannter QA-Run ${args.qaRunId}` });
      return reply(run ? { qaRunId: run.id, state: run.state, verdict: run.verdict, evidence: run.evidence } : { evidence: [...state.qaRuns.values()].flatMap((r) => r.evidence).slice(-50) });
    }
    case "backend.get_agent_activity":
      return reply({ agents: [...state.agents.values()].map((a) => ({ ...a })) });
    case "backend.onboard":
      return reply(buildOnboarding(agent));
    case "backend.get_work": {
      const orders = [...state.workOrders.values()].sort((a, b) => b.createdAt - a.createdAt);
      const open = orders.find((w) => w.state === "OPEN") ?? orders[0] ?? null;
      return reply({ workOrder: open, orchestrator: { intervalMs: ORCH.intervalMs, capabilitiesCount: ORCH.capabilities.length } });
    }
    case "backend.claim_work": {
      const order = [...state.workOrders.values()].filter((w) => w.state === "OPEN").sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
      if (!order) return reply({ error: "kein offenes Arbeitspaket" });
      order.state = "CLAIMED";
      order.claimedBy = agent.id;
      order.updatedAt = now();
      ORCH.workStats.completed++;
      appendOnly(logEvents, { ts: now(), kind: "work", message: `Work-Order ${order.id} von ${agent.id} übernommen`, workOrderId: order.id, claimedBy: agent.id });
      broadcast(sseFrame("work.claimed", { workOrder: order }));
      broadcastState();
      return reply({ workOrder: order });
    }
    case "backend.get_anomalies": {
      const list = [...state.anomalies.values()]
        .filter((a) => (args.openOnly ? a.state === "OPEN" : true))
        .sort((a, b) => b.createdAt - a.createdAt);
      return reply({ anomalies: list.slice(0, Number(args.limit ?? 20)), orchestratorStats: { ...ORCH.workStats } });
    }
    default:
      return writeMsg(sock, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unbekanntes Backend-Tool: ${tool}` } });
  }
}

/** Onboarding: ALLES, was ein externer Agent braucht — null Code-Lektüre. */
function buildOnboarding(agent) {
  const target = state.targets.get(agent.targetId);
  return {
    system: "GODOT ACP — Backend ist Autorität; Godot ist Adapter; du (Agent) bist externer Teilnehmer.",
    contract: {
      targetStates: TARGET_STATES, agentStates: AGENT_STATES, commandStates: COMMAND_STATES, qaStates: QA_STATES, origins: ORIGINS,
      humanControl: "Mensch kann pausieren, blockieren, freigeben, Ziele setzen — deine Calls werden dann ehrlich abgelehnt (BLOCKED), das ist kein Fehler deines Codes.",
    },
    capabilities: {
      target: target?.state ?? "OFFLINE",
      targetTools: ORCH.capabilities,
      analysisChain: "Bei Anomalien führt das BACKEND automatisch eine atomare Analyse (Vision/OCR/Audio/Debug/Logs) — du musst sie nicht nachbauen; backend.get_anomalies liefert die Beweise.",
    },
    loops: {
      worker: "1) backend.get_work → 2) Ziel-Tools atomar (ein Call, dann backend.observe) → 3) Ergebnis/Evidence → 4) backend.claim_work.",
      observe_before_act: "ein Tool-Call pro Schritt; nach jedem Call backend.observe",
    },
    humanInterface: "React-Dashboard (Web) und Ink-Cockpit (Terminal) zeigen denselben Backend-State; sie senden über denselben Command-Bus wie du.",
    nextSteps: [
      "backend.get_work → Arbeitspaket lesen",
      "tools/list → Ziel-Fachtools (sobald Ziel ONLINE)",
      "Ein Atom pro Call, Observation dazwischen (loops.observe_before_act)",
      "Bei BLOCKED: Grund lesen, Nutzer-Entscheidung respektieren, nicht retry-en",
    ],
    ports: { backend: BACKEND_PORT, proxy: PROXY_PORT, godot: GODOT_PORT },
  };
}

const proxyReplies = new Map(); // probe-<wireId> -> { sock, agentMsgId, backendTools }
function writeMsg(sock, obj) {
  try { sock.write(JSON.stringify(obj) + "\n"); } catch { /* ignore */ }
}

/** tools/list-Antwort vom Ziel: merge mit backend.*-Tools, dann zum Agent. */
function settleProbeReply(wireId, msg) {
  const entry = proxyReplies.get(wireId);
  if (!entry) return false;
  proxyReplies.delete(wireId);
  const godotTools = msg.result?.tools ?? [];
  writeMsg(entry.sock, {
    jsonrpc: "2.0", id: entry.agentMsgId,
    result: { tools: [...entry.backendTools, ...godotTools] },
  });
  return true;
}

/* ─────────────────────── Boot: Replay aus JSONL ─────────────────────── */

function restoreFromLogs() {
  // Sessions: Agent-Zustände ableitbar machen (PAUSED/BLOCKED überlebt Neustart;
  // transiente Zustände wie PAUSE_REQUESTED/WAITING fallen auf WORKING zurück —
  // ohne echtes Ziel kann nichts wartet).
  const restoredAgents = replay(
    logSessions,
    (acc, rec) => {
      if (!rec.agentId) return acc;
      if (rec.to === "IDLE") { acc[rec.agentId] = "IDLE"; return acc; }
      acc[rec.agentId] = rec.to ?? acc[rec.agentId] ?? "IDLE";
      return acc;
    },
    {},
  );
  for (const [agentId, agentState] of Object.entries(restoredAgents)) {
    if (agentState === "IDLE") continue;
    if (!state.agents.has(agentId)) {
      const recovered = ["PAUSED", "BLOCKED", "WORKING", "WAITING", "FAILED"].includes(agentState) ? agentState : "WORKING";
      const agent = { id: agentId, name: agentId, state: recovered, goal: "", currentAction: "", startedAt: now(), lastSeenAt: null, targetId: TARGET_ID };
      state.agents.set(agentId, agent);
      pushEvent("agent", `Recovery: Agent ${agentId} wiederhergestellt als ${recovered}`, { agentId });
    }
  }

  // Blocks: aktive Sperren überleben Backend-Neustarts (Benutzerentscheidungen
  // sind keine Dekoration).
  replay(
    logEvents,
    (acc, rec) => {
      if (rec.kind === "block" && rec.scope && rec.value) {
        acc.push({ scope: rec.scope, value: rec.value, reason: rec.message ?? "", active: rec.event !== "aufgehoben" });
      }
      return acc;
    },
    [],
  ).forEach((b) => {
    const id = nextId("blk");
    state.blocks.set(id, {
      id, scope: b.scope, value: b.value, reason: b.reason || "wiederhergestellt",
      active: b.active, createdBy: "recovery", createdAt: now(),
    });
  });

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

  // ── Eingefrorener Vertrag (für Clients; KEINE zweite Interpretation) ──
  if (p === "/api/contract" && req.method === "GET") {
    return sendJson(res, 200, {
      targets: TARGET_STATES, agents: AGENT_STATES, commands: COMMAND_STATES, qa: QA_STATES,
      anomalies: ANOMALY_STATES, work: WORK_STATES,
      origins: ORIGINS, words: { target: TARGET_WORDS, agent: AGENT_WORDS, command: COMMAND_WORDS, qa: QA_WORDS },
      channels: SSE_CHANNELS,
    });
  }

  // ── Orchestrator: Onboarding, Anomalien, Work-Orders ──
  if (p === "/api/onboard" && req.method === "GET") {
    return sendJson(res, 200, buildOnboarding({ id: "human-dashboard", targetId: TARGET_ID }));
  }
  if (p === "/api/orchestrator" && req.method === "GET") {
    return sendJson(res, 200, {
      running: !!ORCH.timer, analyzing: ORCH.analyzing, intervalMs: ORCH.intervalMs,
      lastTickAt: ORCH.lastTickAt, lastFullScanAt: ORCH.lastFullScanAt,
      capabilities: ORCH.capabilities, capabilitiesAt: ORCH.capabilitiesAt,
      stats: { ...ORCH.workStats },
      anomalies: [...state.anomalies.values()].sort((a, b) => b.createdAt - a.createdAt),
      workOrders: [...state.workOrders.values()].sort((a, b) => b.createdAt - a.createdAt),
      observations: state.observations.slice(-50),
    });
  }

  // ── QA-Runs ──
  if (p === "/api/qa" && req.method === "GET") {
    return sendJson(res, 200, { runs: [...state.qaRuns.values()].map(publicQa) });
  }
  if (p === "/api/qa" && req.method === "POST") {
    const body = await readBody(req);
    if (!Array.isArray(body.steps) || body.steps.length === 0) {
      return sendJson(res, 400, { error: "steps erforderlich (Array aus {label, tool, expected})" });
    }
    const run = createQaRun({ name: body.name, steps: body.steps, createdBy: "human" });
    executeQaRun(run).catch((e) => pushEvent("qa", `QA-Fehler: ${e.message}`, { qaRunId: run.id }));
    return sendJson(res, 202, publicQa(run));
  }
  const qaMatch = p.match(/^\/api\/qa\/([^/]+)\/(cancel|archive)$/);
  if (qaMatch && req.method === "POST") {
    const run = state.qaRuns.get(decodeURIComponent(qaMatch[1]));
    if (!run) return sendJson(res, 404, { error: "QA-Run nicht gefunden" });
    if (qaMatch[2] === "cancel") {
      qaTransition(run, "CANCELLED");
    } else if (["PASS", "FAIL", "INCONCLUSIVE"].includes(run.state)) {
      qaTransition(run, "ARCHIVED");
    }
    return sendJson(res, 200, publicQa(run));
  }
  if (/^\/api\/qa\/[^/]+$/.test(p) && req.method === "GET") {
    const run = state.qaRuns.get(decodeURIComponent(p.split("/")[3]));
    return run ? sendJson(res, 200, publicQa(run)) : sendJson(res, 404, { error: "QA-Run nicht gefunden" });
  }

  if (p === "/api/targets" && req.method === "GET") {
    return sendJson(res, 200, { targets: [...state.targets.values()].map((t) => ({ ...t })) });
  }

  if (p === "/api/agents" && req.method === "GET") {
    return sendJson(res, 200, { agents: [...state.agents.values()].map((a) => ({ ...a })) });
  }

  // ── Command einschleusen (origin: human/qa/system; default human) ──
  if (p === "/api/commands" && req.method === "POST") {
    const body = await readBody(req);
    const origin = ORIGINS.includes(body.origin) && body.origin !== "agent" ? body.origin : "human";
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
    // Eine Sperre pro (scope, value) — Duplikate reaktivieren statt stapeln.
    const scope = ["tool", "agent", "target", "command"].includes(body.scope) ? body.scope : "tool";
    const value = String(body.value ?? "");
    const existing = [...state.blocks.values()].find((b) => b.scope === scope && b.value === value);
    let id;
    if (existing) {
      existing.active = true;
      existing.reason = String(body.reason || existing.reason);
      existing.updatedAt = now();
      id = existing.id;
    } else {
      id = nextId("blk");
      state.blocks.set(id, {
        id,
        scope,
        value,
        reason: String(body.reason || `blockiert durch ${body.createdBy || "human"}`),
        active: true, createdBy: body.createdBy || "human", createdAt: now(),
      });
    }
    appendOnly(logEvents, { ts: now(), kind: "block", scope, value, message: `Block aktiv: ${scope}=${value}`, event: "gesetzt", origin: "human" });
    pushEvent("block", `Block aktiv: ${scope}=${value}`, { scope, value });
    broadcastState();
    return sendJson(res, existing ? 200 : 201, { ...state.blocks.get(id) });
  }
  const blockMatch = p.match(/^\/api\/blocks\/([^/]+)\/(deactivate)$/);
  if (blockMatch && req.method === "POST") {
    const b = state.blocks.get(decodeURIComponent(blockMatch[1]));
    if (!b) return sendJson(res, 404, { error: "Block nicht gefunden" });
    b.active = false;
    appendOnly(logEvents, { ts: now(), kind: "block", scope: b.scope, value: b.value, message: `Block aufgehoben: ${b.scope}=${b.value}`, event: "aufgehoben", origin: "human" });
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
    const evidence = [...state.qaRuns.values()].flatMap((r) => r.evidence.map((e) => ({ ...e, qaRunId: r.id, qaName: r.name })));
    const recent = state.events.filter((e) => ["target", "command_result", "approval", "block", "timeout"].includes(e.kind)).slice(-30);
    return sendJson(res, 200, { evidence, recent, note: "Bild-Artefakte liegen beim Ziel (user://mcp_context); Anzeige geplant (ROADMAP v1.1)" });
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
  startOrchestrator();
  pushEvent("system", "Orchestrator läuft: Beobachtung endet nicht; atomare Analyse nur bei Anomalie");
});

net.createServer(handleAgentConnection).listen(PROXY_PORT, () => {
  pushEvent("system", `Agent-Proxy lauscht auf :${PROXY_PORT}`);
});

process.on("SIGINT", () => {
  console.log("\n[godot-acp] Backend beendet.");
  process.exit(0);
});
