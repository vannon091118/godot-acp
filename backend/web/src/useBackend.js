/**
 * useBackend — eine Hook, die den zentralen State hält und SSE live aktualisiert.
 * Genau eine Quelle der Wahrheit im Dashboard: der Backend-Snapshot.
 */
import { useEffect, useRef, useState, useCallback } from "react";

export function useBackend() {
  const [state, setState] = useState(null);
  const [events, setEvents] = useState([]);
  const [tools, setTools] = useState([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef(null);

  const refreshTools = useCallback(async () => {
    try {
      const res = await fetch("/api/tools");
      const data = await res.json();
      setTools(data.tools ?? []);
    } catch {
      setTools([]);
    }
  }, []);

  const sendCommand = useCallback(async (type, payload = {}) => {
    const res = await fetch("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });
    return res.json();
  }, []);

  const decideApproval = useCallback(async (tool, approved) => {
    const res = await fetch(`/api/approvals/${encodeURIComponent(tool)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved }),
    });
    return res.json();
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/state")
      .then((r) => r.json())
      .then((snap) => { if (!cancelled) setState(snap); })
      .catch(() => {});

    const es = new EventSource("/api/events");
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === "state") {
          setState((prev) => ({ ...(prev ?? {}), ...data }));
        } else if (data.type === "event") {
          setEvents((prev) => [data.event, ...prev].slice(0, 200));
        } else if (data.type === "approval" || data.type === "approvalResolved") {
          // Approval-Änderungen stecken im nächsten State-Update; nichts zu tun.
        }
      } catch { /* ignore */ }
    };

    refreshTools();

    return () => {
      cancelled = true;
      es.close();
    };
  }, [refreshTools]);

  return { state, events, tools, connected, sendCommand, decideApproval, refreshTools };
}
