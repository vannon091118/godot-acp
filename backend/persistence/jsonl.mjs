/**
 * jsonl.mjs — Append-only-Persistenz für das Backend (eine Ebene über Godot).
 *
 * Doktrin (User-Vorgabe): **Append-only Eventlog zuerst**, der aktuelle State
 * ist IMMER aus dem Log ableitbar (Replay/Fold). Keine status.json/agent.json,
 * die gegeneinander kämpfen.
 *
 * - `appendOnly(file, record)` — nie überschreiben, nur anfügen.
 * - `replay(file, fold)` — Log ab Anfang falten; defekte Zeilen werden
 *   übersprungen ( Crash-Tail), nicht repariert.
 * - `readTail(file, n)` — letzte n Einträge (Feed-Ansichten).
 *
 * Dateien (DATA_DIR, default ~/.godot-acp/data):
 *   events.jsonl     — jeder beobachtete Vorfall (Ziel-Events, Agent-Aktivität, …)
 *   commands.jsonl   — jeder Command mit Übergängen (CREATED → … → terminal)
 *   sessions.jsonl   — Agent-Session-Lebenszyklen (START/RESUME/PAUSE/STOP)
 */
import fs from "node:fs";
import path from "node:path";

export function createLog(dataDir, name) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, name);
  return { file };
}

/** Ein Datensatz ans Log. Persistenz darf den Betrieb nie blockieren. */
export function appendOnly(log, record) {
  try {
    fs.appendFileSync(log.file, JSON.stringify(record) + "\n");
  } catch {
    /* Disk voll? Weiterlaufen. Der State im RAM ist eh die Wahrheit. */
  }
}

/** Komplettes Log falth — rebuild State from scratch. */
export function replay(log, fold, initialState) {
  let state = initialState;
  let data;
  try {
    data = fs.readFileSync(log.file, "utf8");
  } catch {
    return state;
  }
  for (const line of data.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      state = fold(state, JSON.parse(trimmed));
    } catch {
      /* Crashed tail — überspringen, nicht retuschieren. */
    }
  }
  return state;
}

/** Die letzten n Einträge, älteste zuerst. */
export function readTail(log, n) {
  let data;
  try {
    data = fs.readFileSync(log.file, "utf8");
  } catch {
    return [];
  }
  const lines = data.split("\n").filter((l) => l.trim());
  return lines.slice(-n).map((l) => {
    try { return JSON.parse(l); } catch { return { unparsable: true }; }
  });
}
