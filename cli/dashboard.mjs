#!/usr/bin/env node
/**
 * dashboard.mjs — Terminal-Cockpit für das GODOT ACP Backend.
 *
 * ZWEITES FRONTEND, kein zweites Gehirn: Es besitzt keinerlei eigene Logik.
 * SSE abonnieren → State halten → rendern → User Input → REST-Command.
 * Genau derselbe Eventstrom wie im React-Dashboard.
 *
 * Start:  node cli/dashboard.mjs   (ENV: ACP_BACKEND_URL=http://localhost:8787)
 * React-ink ist optional installiert; ohne gibt es einen Poll-Modus (readline).
 */
import net from "node:http";

const BACKEND = process.env.ACP_BACKEND_URL || "http://localhost:8787";

/* ── SSE-Client (zero-dependency, nur node:http) ─────────────────────── */

function sseConnect(path, onItem) {
  let retry = null;
  let closed = false;
  const open = () => {
    if (closed) return;
    const req = net.get(`${BACKEND}${path}`, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        buf += c;
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (line) {
            try { onItem(JSON.parse(line.slice(6))); } catch { /* ignore */ }
          }
        }
      });
      res.on("end", () => { if (!closed) retry = setTimeout(open, 2000); });
    });
    req.on("error", () => { if (!closed) retry = setTimeout(open, 2000); });
  };
  open();
  return () => { closed = true; if (retry) clearTimeout(retry); };
}

async function post(path, body) {
  const payload = JSON.stringify(body ?? {});
  return new Promise((resolve) => {
    const url = new URL(`${BACKEND}${path}`);
    const req = net.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    });
    req.on("error", () => resolve({ error: "Backend nicht erreichbar" }));
    req.write(payload);
    req.end();
  });
}

/* ── Frontend-State (nur Spiegel des Backends) ───────────────────────── */

const ui = {
  status: null,
  lastEvents: [],
  mode: "status",  // status | goal | blocks
  goalDraft: "",
  blockSel: 0,
  tools: [],       // aus /api/status abgeleitete bekannte Tools (Command-Historie)
};

/* ── Ink-Frontend (falls installiert) ────────────────────────────────── */

let inkAvailable = false;
try {
  await import("ink");
  inkAvailable = true;
} catch {
  inkAvailable = false;
}

if (inkAvailable) {
  const React = (await import("react")).default;
  const { render, Text, Box, useInput, useState, useEffect } = await import("ink");

  function Cockpit() {
    const [, force] = useState(0);
    useEffect(() => {
      sseConnect("/api/events", (item) => {
        if (item.type === "state") {
          ui.status = {
            targets: item.targets, agents: item.agents, blocks: item.blocks,
            approvals: item.approvals, stats: item.stats,
            uptimeSeconds: item.uptimeSeconds, ports: item.ports,
          };
        } else if (item.type === "event") {
          ui.lastEvents = [item.event, ...ui.lastEvents].slice(0, 12);
        }
        force((n) => n + 1);
      });
      const t = setInterval(() => force((n) => n + 1), 1000);
      return () => clearInterval(t);
    }, []);

    useInput(async (input, key) => {
      const agent = ui.status?.agents.find((a) => a.state !== "IDLE") ?? ui.status?.agents[0];
      if (input === "p" && agent) await post(`/api/agents/${encodeURIComponent(agent.id)}/${agent.state === "PAUSED" ? "resume" : "pause"}`, {});
      if (input === "s" && agent) await post(`/api/agents/${encodeURIComponent(agent.id)}/stop`, {});
      if (input === "g") { ui.mode = ui.mode === "goal" ? "status" : "goal"; ui.goalDraft = ""; }
      if (input === "t") ui.mode = ui.mode === "blocks" ? "status" : "blocks";
      if (ui.mode === "goal") {
        if (key.return && agent) {
          await post(`/api/agents/${encodeURIComponent(agent.id)}/goal`, { goal: ui.goalDraft.trim() });
          ui.mode = "status";
        } else if (key.backspace || key.delete) ui.goalDraft = ui.goalDraft.slice(0, -1);
        else if (input && input.length === 1) ui.goalDraft += input;
      }
      if (input === "q") process.exit(0);
    });

    if (!ui.status) return <Text>Verbinde mit {BACKEND} …</Text>;
    const { targets, agents, blocks, approvals, stats, ports } = ui.status;
    const agent = agents.find((a) => a.state !== "IDLE") ?? agents[0];
    const target = targets[0];
    const activeBlocks = blocks.filter((b) => b.active);

    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Text bold color="cyan">GODOT ACP — Agent-Cockpit (Terminal)</Text>
        <Box flexDirection="column">
          <Text>Spiel:  <Text bold color={target?.state === "CONNECTED" ? "green" : "red"}>{target?.state ?? "OFFLINE"}</Text></Text>
          <Text>Agent:  <Text bold color={agent?.state === "WORKING" ? "green" : agent?.state === "PAUSED" ? "yellow" : "gray"}>{agent?.state ?? "—"}</Text></Text>
          <Text>Aktion: <Text dimColor>{agent?.currentAction || "—"}</Text></Text>
          <Text>Ziel:   <Text dimColor>{agent?.goal || "noch keins"}</Text></Text>
          <Text>Bilanz: {stats.completed} erledigt · {stats.blocked} gestoppt · {stats.eventsSeen} Ereignisse</Text>
          {activeBlocks.length > 0 && <Text color="red">Aktive Sperren: {activeBlocks.map((b) => b.value).join(", ")}</Text>}
        </Box>
        {approvals.length > 0 && (
          <Text color="yellow">FREIGABE ERFORDERLICH: {approvals.map((a) => a.tool).join(", ")} — im Web-Cockpit entscheiden</Text>
        )}
        {ui.mode === "status" && <Text dimColor>[p] Pause/Weiter  [s] Stop  [g] Ziel  [t] Sperren  [q] Beenden</Text>}
        {ui.mode === "goal" && (
          <Box flexDirection="column"><Text color="green">Ziel: {ui.goalDraft}| (Enter = setzen)</Text><Text dimColor>[Enter] setzen  [g] zurück</Text></Box>
        )}
        {ui.mode === "blocks" && <Text dimColor>Sperren über das Web-Cockpit verwalten (Klick mit Grund) · [t] zurück</Text>}
        <Box flexDirection="column">
          {ui.lastEvents.slice(0, 8).map((ev, i) => (
            <Text key={i} dimColor={ev.kind === "command"}>
              {new Date(ev.ts).toLocaleTimeString("de-DE")} {ev.kind.padEnd(8)} {ev.message}
            </Text>
          ))}
        </Box>
        <Text dimColor>Backend {ports.backend} · Agent-Zugang {ports.proxy} · Spiel {ports.godot}</Text>
      </Box>
    );
  }

  render(React.createElement(Cockpit));
} else {
  /* ── Fallback: Poll-Modus ohne Dependencies ── */
  const { stdin } = process;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  stdin.on("data", async (key) => {
    const agentRes = await fetch(`${BACKEND}/api/agents`).then((r) => r.json()).catch(() => null);
    const agent = agentRes?.agents?.find((a) => a.state !== "IDLE") ?? agentRes?.agents?.[0];
    if (key === "q") process.exit(0);
    if (key === "p" && agent) await post(`/api/agents/${encodeURIComponent(agent.id)}/${agent.state === "PAUSED" ? "resume" : "pause"}`, {});
    if (key === "s" && agent) await post(`/api/agents/${encodeURIComponent(agent.id)}/stop`, {});
    if (key === "\u0003") process.exit(0);
  });

  sseConnect("/api/events", (item) => {
    if (item.type === "state") ui.status = item;
    if (item.type === "event") {
      ui.lastEvents = [item.event, ...ui.lastEvents].slice(0, 8);
      console.clear?.();
      const s = ui.status ?? {};
      const agent = s.agents?.find((a) => a.state !== "IDLE") ?? s.agents?.[0];
      console.log("GODOT ACP — Cockpit (Poll-Modus, p=Pause/Weiter s=Stop q=Ende)");
      console.log(`Spiel: ${s.targets?.[0]?.state ?? "—"}  Agent: ${agent?.state ?? "—"}  Aktion: ${agent?.currentAction ?? "—"}`);
      console.log(`Bilanz: ${JSON.stringify(s.stats ?? {})}`);
      for (const ev of ui.lastEvents) console.log(`  ${new Date(ev.ts).toLocaleTimeString("de-DE")} ${ev.kind.padEnd(8)} ${ev.message}`);
    }
  });
}
