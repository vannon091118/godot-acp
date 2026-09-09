/**
 * useBackend — eine Hook, die die Backend-Autorität hält und live per SSE aktualisiert.
 * Genau eine Quelle der Wahrheit im Dashboard: der Backend-Snapshot (/api/status).
 * Die Hook enthält KEINE eigene Logik — sie rendert die Backend-Wahrheit.
 */
import { useEffect, useRef, useState, useCallback } from "react";

export function useBackend() {
  const [status, setStatus] = useState(null);
  const [events, setEvents] = useState([]);
  const [commands, setCommands] = useState([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let es = null;
    let retry = null;

    fetch("/api/status")
      .then((r) => r.json())
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => {});

    const open = () => {
      es = new EventSource("/api/events");
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        // SSE bricht beim Backend-Neustart — bewusst wiederverbinden.
        retry = setTimeout(open, 2000);
      };
      es.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data.type === "state") {
            setStatus({
              status: "ok",
              targets: data.targets,
              agents: data.agents,
              blocks: data.blocks,
              approvals: data.approvals,
              stats: data.stats,
              uptimeSeconds: data.uptimeSeconds,
              ports: data.ports,
              authority: data.authority,
            });
          } else if (data.type === "event") {
            setEvents((prev) => [data.event, ...prev].slice(0, 200));
          } else if (data.type === "command") {
            setCommands((prev) => {
              const rest = prev.filter((c) => c.id !== data.command.id);
              return [data.command, ...rest].slice(0, 100);
            });
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

  return { status, events, commands, connected, sendCommand, agentAction, decideApproval, toggleBlock, liftBlock };
}

/**
 * Übersetzung für Menschen: Keine MCP-Begriffe als primäre Oberfläche.
 * Intern bleibt es exakt der Toolname — extern spricht Deutsch.
 */
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
  return TOOL_WORDS[tool] ?? tool.replace(/^runtime_/, "").replace(/_/g, " ");
}

export function humanTargetState(s) {
  switch (s) {
    case "CONNECTED": return { label: "verbunden", cls: "ok" };
    case "CONNECTING": return { label: "verbindet …", cls: "warn" };
    case "RECONNECTING": return { label: "wird neu verbunden", cls: "warn" };
    case "DEGRADED": return { label: "reagiert schlecht", cls: "err" };
    default: return { label: "nicht erreichbar", cls: "idle" };
  }
}

export function humanAgentState(s) {
  switch (s) {
    case "WORKING": return { label: "arbeitet", cls: "ok" };
    case "PAUSE_REQUESTED": return { label: "Pause wird angefragt", cls: "warn" };
    case "PAUSED": return { label: "pausiert (dein Befehl)", cls: "warn" };
    case "STOP_REQUESTED": return { label: "wird beendet", cls: "warn" };
    default: return { label: "wartet", cls: "idle" };
  }
}

export function humanCommandState(s) {
  switch (s) {
    case "CREATED": case "QUEUED": case "DISPATCHED": return { label: "in Warteschlange", cls: "idle" };
    case "RUNNING": return { label: "läuft", cls: "ok" };
    case "COMPLETED": return { label: "erledigt", cls: "ok" };
    case "WAITING_APPROVAL": return { label: "wartet auf dich", cls: "warn" };
    case "BLOCKED": return { label: "blockiert", cls: "err" };
    case "REJECTED": return { label: "abgelehnt", cls: "err" };
    case "FAILED": return { label: "fehlgeschlagen", cls: "err" };
    case "TIMEOUT": return { label: "Zeit abgelaufen", cls: "err" };
    case "CANCELLED": return { label: "abgebrochen", cls: "idle" };
    default: return { label: s, cls: "idle" };
  }
}
