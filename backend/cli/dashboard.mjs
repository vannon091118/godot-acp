#!/usr/bin/env node
/**
 * dashboard.mjs — Terminal-Cockpit für das GODOT ACP Backend (React-ink).
 *
 * Derselbe Command-Bus wie im Web-Dashboard, nur in der Shell:
 * Zusehen, pausieren, Ziel geben, Werkzeuge sperren — ohne Agent-Chat.
 *
 * Start:  node cli/dashboard.mjs   (ENV: ACP_BACKEND_URL=http://localhost:8787)
 * React-ink ist optional: fehlt es, wird ein Statik-Modus verwendet.
 */
import React, { useState, useEffect, useCallback } from "react";
import { render, Text, Box, useInput } from "ink";

const BACKEND = process.env.ACP_BACKEND_URL || "http://localhost:8787";

async function getState() {
  const res = await fetch(`${BACKEND}/api/state`);
  return res.json();
}

async function sendCommand(type, payload = {}) {
  const res = await fetch(`${BACKEND}/api/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, payload }),
  });
  return res.json();
}

async function getTools() {
  try {
    const res = await fetch(`${BACKEND}/api/tools`);
    const data = await res.json();
    return data.tools ?? [];
  } catch {
    return [];
  }
}

const SESSION_LABELS = {
  IDLE: "wartet",
  RUNNING: "arbeitet",
  PAUSE_REQUESTED: "Pause angefragt",
  PAUSED: "PAUSIERT",
  STOP_REQUESTED: "wird beendet",
};

function App() {
  const [state, setState] = useState(null);
  const [tools, setTools] = useState([]);
  const [goalDraft, setGoalDraft] = useState("");
  const [mode, setMode] = useState("status"); // status | goal | tools
  const [blockSel, setBlockSel] = useState(0);
  const [lastEvent, setLastEvent] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const s = await getState();
        if (alive) setState(s);
      } catch { /* Backend weg? nächster Tick probiert es wieder */ }
    };
    poll();
    const t = setInterval(poll, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [tick]);

  useEffect(() => {
    if (mode === "tools") getTools().then(setTools);
  }, [mode]);

  useInput((input, key) => {
    if (input === "p") sendCommand(state?.agent?.session?.state === "PAUSED" ? "session.resume" : "session.pause", {});
    if (input === "s") sendCommand("session.stop", {});
    if (input === "r") sendCommand("godot.reconnect", {});
    if (input === "g") setMode(mode === "goal" ? "status" : "goal");
    if (input === "t") setMode(mode === "tools" ? "status" : "tools");
    if (input === "q") process.exit(0);
    if (mode === "goal") {
      if (key.return) {
        const g = goalDraft.trim();
        if (g) sendCommand("session.goal", { goal: g });
        setGoalDraft("");
        setMode("status");
      } else if (key.backspace || key.delete) setGoalDraft((d) => d.slice(0, -1));
      else if (input && input.length === 1) setGoalDraft((d) => d + input);
    }
    if (mode === "tools" && tools.length > 0) {
      if (key.upArrow) setBlockSel((i) => Math.max(0, i - 1));
      if (key.downArrow) setBlockSel((i) => Math.min(tools.length - 1, i + 1));
      if (key.return) {
        const tool = tools[blockSel]?.name;
        const blocked = state?.blockedTools ?? [];
        sendCommand(blocked.includes(tool) ? "tools.unblock" : "tools.block", { tools: [tool] });
        setTick((n) => n + 1);
      }
    }
  });

  if (!state) return <Text>Verbinde mit Backend {BACKEND} …</Text>;

  const { target, agent, stats, blockedTools } = state;
  const sess = agent.session;

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Text bold color="cyan">GODOT ACP — Agent-Cockpit (Terminal)</Text>

      <Box flexDirection="column">
        <Text>Spiel (Godot):  <Text bold color={target.state === "CONNECTED" ? "green" : "red"}>{target.state}</Text></Text>
        <Text>Agent:         <Text bold color={sess.state === "RUNNING" ? "green" : sess.state === "PAUSED" ? "yellow" : "gray"}>{SESSION_LABELS[sess.state] ?? sess.state}</Text></Text>
        <Text>Aktion:        <Text dimColor>{sess.currentAction || "—"}</Text></Text>
        <Text>Ziel:          <Text dimColor>{sess.goal || "noch keins"}</Text></Text>
        <Text>Gestoppt:      {stats.callsDenied} von {stats.callsTotal} Aktionen</Text>
      </Box>

      {mode === "status" && (
        <Box flexDirection="column">
          <Text>[p] Pause/Weiter  [s] Stop  [g] Ziel  [t] Werkzeuge  [r] Neu verbinden  [q] Beenden</Text>
          {lastEvent ? <Text dimColor>{lastEvent}</Text> : null}
        </Box>
      )}

      {mode === "goal" && (
        <Box flexDirection="column">
          <Text color="green">Ziel eingeben, Enter bestätigt: {goalDraft}|</Text>
          <Text dimColor>[Enter] setzen  [Esc/Q] abbrechen</Text>
        </Box>
      )}

      {mode === "tools" && (
        <Box flexDirection="column">
          <Text>[↑/↓] wählen  [Enter] sperren/freigeben  [t] zurück</Text>
          <Box flexDirection="column">
            {tools.slice(0, 12).map((tool, i) => {
              const isBlocked = (state?.blockedTools ?? []).includes(tool.name);
              return (
                <Text key={tool.name} color={i === blockSel ? "cyan" : undefined}>
                  {i === blockSel ? "› " : "  "}
                  {isBlocked ? "✗ " : "  "}
                  {tool.name}
                </Text>
              );
            })}
          </Box>
        </Box>
      )}
    </Box>
  );
}

render(<App />);
