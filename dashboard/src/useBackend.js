/**
 * useBackend — eine Hook, die die Backend-Autorität hält und live per SSE aktualisiert.
 * Die Zustands-Übersetzungen kommen aus /api/contract (EIN Vertrag, keine
 * Frontend-Deutung). Die Hook enthält KEINE eigene Logik.
 */
import { useEffect, useState, useCallback } from "react";

export function useBackend() {
  const [status, setStatus] = useState(null);
  const [contract, setContract] = useState(null);
  const [events, setEvents] = useState([]);
  const [commands, setCommands] = useState([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let es = null;
    let retry = null;

    fetch("/api/contract").then((r) => r.json()).then((c) => { if (!cancelled) setContract(c); }).catch(() => {});
    fetch("/api/status").then((r) => r.json()).then((s) => { if (!cancelled) setStatus(s); }).catch(() => {});

    const open = () => {
      es = new EventSource("/api/events");
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        retry = setTimeout(open, 2000);
      };
      es.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          // Ein Strom, kanalgetaggt (Vertrag): state.changed u. Voll-Snapshot.
          if (data.type === "state") {
            setStatus((prev) => ({
              ...(prev ?? {}),
              targets: data.targets ?? prev?.targets,
              agents: data.agents ?? prev?.agents,
              blocks: data.blocks ?? prev?.blocks,
              approvals: data.approvals ?? prev?.approvals,
              qaRuns: data.qaRuns ?? prev?.qaRuns,
              orchestrator: data.orchestrator ?? prev?.orchestrator,
              stats: data.stats ?? prev?.stats,
              uptimeSeconds: data.uptimeSeconds,
              ports: data.ports ?? prev?.ports,
            }));
          } else if (data.type === "event") {
            setEvents((prev) => [data.event, ...prev].slice(0, 200));
          } else if (data.type === "command") {
            setCommands((prev) => {
              const rest = prev.filter((c) => c.id !== data.command.id);
              return [data.command, ...rest].slice(0, 100);
            });
          } else if (data.channel === "qa.progress" || data.channel === "qa.verdict") {
            // QA-Runs im Snapshot ersetzen (Backend ist Quelle).
            setStatus((prev) => prev ? { ...prev, qaRuns: mergeQa(prev.qaRuns, data.qaRun) } : prev);
          }
        } catch { /* ignore */ }
      };
    };
    open();

    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, []);

  const sendCommand = useCallback(async (type, payload = {}, origin = "human") => {
    const res = await fetch("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload, origin }),
    });
    return res.json();
  }, []);

  const agentAction = useCallback(async (agentId, action, body = {}) => {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }, []);

  const decideApproval = useCallback(async (commandId, approved) => {
    const res = await fetch(`/api/approvals/${encodeURIComponent(commandId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved }),
    });
    return res.json();
  }, []);

  const toggleBlock = useCallback(async (tool, reason) => {
    const res = await fetch("/api/blocks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "tool", tools: [tool], reason }),
    });
    return res.json();
  }, []);

  const liftBlock = useCallback(async (blockId) => {
    const res = await fetch(`/api/blocks/${encodeURIComponent(blockId)}/deactivate`, { method: "POST" });
    return res.json();
  }, []);

  const startQa = useCallback(async (name, steps) => {
    const res = await fetch("/api/qa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, steps }),
    });
    return res.json();
  }, []);

  return { status, contract, events, commands, connected, sendCommand, agentAction, decideApproval, toggleBlock, liftBlock, startQa };
}

function mergeQa(runs, updated) {
  if (!updated) return runs;
  const rest = (runs ?? []).filter((r) => r.id !== updated.id);
  return [updated, ...rest];
}

/* Zustands-Wörter: aus dem Vertrag, falls geladen; sonst Fallback-Tabellen
   (identischer Inhalt — NICHT eine zweite Interpretation). */

const TARGET_WORDS = { OFFLINE: "nicht erreichbar", CONNECTING: "verbindet …", ONLINE: "verbunden", DEGRADED: "reagiert schlecht", DISCONNECTED: "getrennt" };
const AGENT_WORDS = { IDLE: "wartet", WORKING: "arbeitet", WAITING: "wartet auf Antwort", PAUSE_REQUESTED: "Pause wird angefragt", PAUSED: "pausiert (dein Befehl)", BLOCKED: "angehalten (Blockade)", FAILED: "hat einen Fehler", STOPPED: "beendet" };
const COMMAND_WORDS = { CREATED: "angenommen", QUEUED: "in Warteschlange", DISPATCHED: "übergeben", RUNNING: "läuft", WAITING: "wartet auf dich", COMPLETED: "erledigt", FAILED: "fehlgeschlagen", CANCELLED: "abgebrochen", BLOCKED: "blockiert" };
const QA_WORDS = { CREATED: "angelegt", RUNNING: "läuft", OBSERVING: "beobachtet das Spiel", ASSERTING: "prüft die Erwartung", EVIDENCE: "sichert Beweise", PASS: "bestanden", FAIL: "fehlgeschlagen", INCONCLUSIVE: "unaufgelöst", ARCHIVED: "archiviert", CANCELLED: "abgebrochen" };
const TOOL_WORDS = {
  runtime_ux_scan: "Oberfläche ablesen", runtime_ux_find: "Auf dem Bildschirm suchen",
  runtime_ux_click: "Klicken", runtime_ux_type: "Text eintippen", runtime_click: "Klicken",
  runtime_key: "Taste drücken", runtime_scroll: "Scrollen", runtime_freeze: "Spiel einfrieren",
  runtime_step_frames: "Frameweise weiterschalten", runtime_screenshot: "Bildschirmfoto",
  runtime_eval: "Skript ausführen", runtime_autonomy_export: "Änderungen ins Spiel übernehmen",
  runtime_autonomy_rollback_all: "Änderungen zurückrollen", game_state_restore: "Spielstand laden",
  runtime_e2e_run: "Testszenario abspielen", runtime_failing_tool: "Fehlertest",
};

export const humanTool = (t) => (t ? TOOL_WORDS[t] ?? String(t).replace(/^runtime_/, "").replace(/_/g, " ") : "unbekannte Aktion");
export const targetWord = (s, contract) => (contract?.words?.target ?? TARGET_WORDS)[s] ?? s;
export const agentWord = (s, contract) => (contract?.words?.agent ?? AGENT_WORDS)[s] ?? s;
export const commandWord = (s, contract) => (contract?.words?.command ?? COMMAND_WORDS)[s] ?? s;
export const qaWord = (s, contract) => (contract?.words?.qa ?? QA_WORDS)[s] ?? s;

/** Pill-Farbe — rein präsentational, Zustand kommt vom Backend. */
export const targetCls = (s) => ({ ONLINE: "ok", CONNECTING: "warn", DISCONNECTED: "warn", DEGRADED: "err" }[s] ?? "idle");
export const agentCls = (s) => ({ WORKING: "ok", PAUSED: "warn", PAUSE_REQUESTED: "warn", WAITING: "warn", STOP_REQUESTED: "warn", BLOCKED: "err", FAILED: "err" }[s] ?? "idle");
export const commandCls = (s) => ({ RUNNING: "ok", COMPLETED: "ok", WAITING: "warn", BLOCKED: "err", FAILED: "err", CANCELLED: "idle", REJECTED: "err" }[s] ?? "idle");
export const qaCls = (s) => ({ PASS: "ok", FAIL: "err", INCONCLUSIVE: "warn", RUNNING: "ok", OBSERVING: "ok", ASSERTING: "warn", EVIDENCE: "warn" }[s] ?? "idle");
