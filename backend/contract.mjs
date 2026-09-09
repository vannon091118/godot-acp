/**
 * contract.mjs — DER EINGEFRORENE VERTRAG des GODOT ACP Backends.
 *
 * Eine Interpretation für alle Clients (React, Ink, Fake-Godot, MCP-Adapter).
 * Kein Frontend erfindet einen Zustand; jede Anzeige muss einen realen
 * Zustand hier haben. Zustandswechsel werden mechanisch validiert.
 *
 * Entities (jede trägt id · state · origin · timestamp · correlation):
 *   Target · Agent · Session · Command · Event · Observation · QaRun ·
 *   Evidence · Verdict
 *
 * SSE-Kanäle (ein Strom, kanalgetaggt):
 *   state.changed · command.started · command.completed · agent.activity ·
 *   godot.connected · godot.disconnected · qa.progress · qa.verdict ·
 *   evidence.ready
 */

/* ─────────────────────────── Zustandsmaschinen ──────────────────────── */

export const TARGET_STATES = ["OFFLINE", "CONNECTING", "ONLINE", "DEGRADED", "DISCONNECTED"];

export const TARGET_TRANSITIONS = {
  OFFLINE:      ["CONNECTING", "DISCONNECTED"],
  CONNECTING:   ["ONLINE", "OFFLINE", "DISCONNECTED"],
  ONLINE:       ["DEGRADED", "DISCONNECTED"],
  DEGRADED:     ["ONLINE", "DISCONNECTED"],
  DISCONNECTED: ["CONNECTING", "OFFLINE"],
};

export const AGENT_STATES = ["IDLE", "WORKING", "WAITING", "PAUSE_REQUESTED", "PAUSED", "BLOCKED", "FAILED", "STOPPED"];

export const AGENT_TRANSITIONS = {
  IDLE:            ["WORKING", "BLOCKED", "STOPPED"],
  WORKING:         ["WAITING", "PAUSE_REQUESTED", "BLOCKED", "FAILED", "STOPPED", "IDLE"],
  WAITING:         ["WORKING", "BLOCKED", "FAILED", "STOPPED", "PAUSE_REQUESTED"],
  PAUSE_REQUESTED: ["PAUSED", "WORKING", "STOPPED"],
  PAUSED:          ["WORKING", "STOPPED"],
  BLOCKED:         ["WORKING", "STOPPED", "IDLE"],
  FAILED:          ["WORKING", "IDLE", "STOPPED"],
  STOPPED:         ["IDLE"],
};

export const COMMAND_STATES = ["CREATED", "QUEUED", "DISPATCHED", "RUNNING", "WAITING", "COMPLETED", "FAILED", "CANCELLED", "BLOCKED"];

export const COMMAND_TRANSITIONS = {
  CREATED:   ["QUEUED", "REJECTED", "CANCELLED"],
  QUEUED:    ["DISPATCHED", "CANCELLED"],
  DISPATCHED: ["RUNNING", "WAITING", "FAILED", "COMPLETED", "BLOCKED"],
  RUNNING:   ["COMPLETED", "FAILED", "CANCELLED", "BLOCKED"],
  WAITING:   ["QUEUED", "CANCELLED", "BLOCKED"],
  COMPLETED: [],
  FAILED:    [],
  CANCELLED: [],
  BLOCKED:   [],
};

/** QaRun: die QA-Zustandsmaschine (User-Vorgabe). */
export const QA_STATES = ["CREATED", "RUNNING", "OBSERVING", "ASSERTING", "EVIDENCE", "PASS", "FAIL", "INCONCLUSIVE", "ARCHIVED", "CANCELLED"];

export const QA_TRANSITIONS = {
  CREATED:     ["RUNNING", "CANCELLED"],
  RUNNING:     ["OBSERVING", "ASSERTING", "CANCELLED"],
  OBSERVING:   ["ASSERTING", "CANCELLED"],
  // Mehrschritt-Lauf: nach der Prüfung eines Schritts darf der nächste
  // Schritt wieder beobachtet werden (ASSERTING → OBSERVING); vor dem Urteil
  // wird EVIDENCE erreicht (per RUNNING → EVIDENCE-Sprung über die erlaubte
  // Kette ASSERTING → EVIDENCE ist direkt im letzten Schritt).
  ASSERTING:   ["OBSERVING", "EVIDENCE", "PASS", "FAIL", "INCONCLUSIVE", "CANCELLED"],
  EVIDENCE:    ["PASS", "FAIL", "INCONCLUSIVE"],
  PASS:        ["ARCHIVED"],
  FAIL:        ["ARCHIVED"],
  INCONCLUSIVE: ["ARCHIVED"],
  ARCHIVED:    [],
  CANCELLED:   [],
};

export const ORIGINS = ["human", "agent", "system", "qa"];

/* ───────────────────────── SSE-Kanäle (fest) ────────────────────────── */

export const SSE_CHANNELS = [
  "state.changed",
  "command.started",
  "command.completed",
  "agent.activity",
  "godot.connected",
  "godot.disconnected",
  "qa.progress",
  "qa.verdict",
  "evidence.ready",
  "anomaly.opened",
  "anomaly.analyzed",
  "work.created",
  "work.claimed",
  "observation.recorded",
  "sequence.progress",
];

/* Orchestrator: Anomalie-Zustände (nur hier definiert — eine Interpretation). */
export const ANOMALY_STATES = ["OPEN", "ANALYZING", "ANALYZED"];
export const WORK_STATES = ["OPEN", "CLAIMED", "DONE"];

/* Ausführungsreihen: atomare Task-Sequenzen (sichtbares Fenster Pflicht). */
export const SEQUENCE_STATES = ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "BLOCKED", "CANCELLED"];

/* ─────────────────── Menschen-Wörter (die EINE Übersetzung) ─────────── */

export const TARGET_WORDS = {
  OFFLINE: "nicht erreichbar",
  CONNECTING: "verbindet …",
  ONLINE: "verbunden",
  DEGRADED: "reagiert schlecht",
  DISCONNECTED: "getrennt",
};

export const AGENT_WORDS = {
  IDLE: "wartet",
  WORKING: "arbeitet",
  WAITING: "wartet auf Antwort",
  PAUSE_REQUESTED: "Pause wird angefragt",
  PAUSED: "pausiert (dein Befehl)",
  BLOCKED: "angehalten (Blockade)",
  FAILED: "hat einen Fehler",
  STOPPED: "beendet",
};

export const COMMAND_WORDS = {
  CREATED: "angenommen",
  QUEUED: "in Warteschlange",
  DISPATCHED: "übergeben",
  RUNNING: "läuft",
  WAITING: "wartet auf dich",
  COMPLETED: "erledigt",
  FAILED: "fehlgeschlagen",
  CANCELLED: "abgebrochen",
  BLOCKED: "blockiert",
};

export const QA_WORDS = {
  CREATED: "angelegt",
  RUNNING: "läuft",
  OBSERVING: "beobachtet das Spiel",
  ASSERTING: "prüft die Erwartung",
  EVIDENCE: "sichert Beweise",
  PASS: "bestanden",
  FAIL: "fehlgeschlagen",
  INCONCLUSIVE: "unaufgelöst",
  ARCHIVED: "archiviert",
  CANCELLED: "abgebrochen",
};

/** Freundliches Wort für ein Tool — intern bleibt es exakt der Toolname. */
const TOOL_WORDS = {
  runtime_ux_scan: "Oberfläche ablesen",
  runtime_ux_find: "Auf dem Bildschirm suchen",
  runtime_ux_click: "Klicken",
  runtime_ux_type: "Text eintippen",
  runtime_click: "Klicken",
  runtime_key: "Taste drücken",
  runtime_scroll: "Scrollen",
  runtime_freeze: "Spiel einfrieren",
  runtime_step_frames: "Frameweise weiterschalten",
  runtime_screenshot: "Bildschirmfoto",
  runtime_eval: "Skript ausführen",
  runtime_autonomy_export: "Änderungen ins Spiel übernehmen",
  runtime_autonomy_rollback_all: "Änderungen zurückrollen",
  game_state_restore: "Spielstand laden",
  runtime_e2e_run: "Testszenario abspielen",
};

export function humanTool(tool) {
  if (!tool) return "unbekannte Aktion";
  return TOOL_WORDS[tool] ?? String(tool).replace(/^runtime_/, "").replace(/_/g, " ");
}

/* ─────────────────────── Mechanische Validierung ────────────────────── */

const MACHINES = { target: TARGET_TRANSITIONS, agent: AGENT_TRANSITIONS, command: COMMAND_TRANSITIONS, qa: QA_TRANSITIONS };

/* Mehrschritt-Konvention: ASSERTING → OBSERVING startet den nächsten Schritt;
   nach dem LETZTEN Schritt geht ASSERTING → EVIDENCE → Urteil. */

/** Wirft, wenn ein Übergang nicht im eingefrorenen Vertrag steht. */
export function requireTransition(kind, from, to) {
  const machine = MACHINES[kind];
  if (!machine) throw new Error(`unbekannte Zustandsmaschine: ${kind}`);
  const allowed = machine[from];
  if (!allowed) throw new Error(`${kind}: unbekannter Zustand ${from}`);
  if (to === from) return; // identisch = no-op, erlaubt
  if (!allowed.includes(to)) {
    throw new Error(`Vertragsverstoß: ${kind} ${from} → ${to} ist nicht erlaubt (erlaubt: ${allowed.join(", ")})`);
  }
}

/** Wire-Format einer SSE-Nachricht — Clients dürfen nichts anderes erwarten. */
export function sseFrame(channel, payload) {
  if (!SSE_CHANNELS.includes(channel)) {
    throw new Error(`Vertragsverstoß: SSE-Kanal ${channel} existiert nicht im Vertrag`);
  }
  return { channel, ts: Date.now(), ...payload };
}
