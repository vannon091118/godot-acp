#!/usr/bin/env node
/**
 * dashboard.mjs — Terminal-Cockpit für das GODOT ACP Backend.
 *
 * ZWEITES FRONTEND, kein zweites Gehirn: Es besitzt keinerlei eigene Logik.
 * SSE abonnieren → State halten → rendern → User Input → REST-Command.
 * Genau derselbe Eventstrom wie im React-Dashboard, dieselben Aktionen
 * über denselben Command-Bus.
 *
 * Start:  node cli/dashboard.mjs   (ENV: ACP_BACKEND_URL=http://localhost:8787)
 * Ink ist optional installiert (npm --prefix cli install ink react);
 * ohne gibt es einen Poll-Modus ohne Dependencies.
 *
 * Bewusst ohne JSX: Node führt diese Datei direkt aus (kein Build-Schritt).
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
  mode: "status",  // status | goal
  goalDraft: "",
};

/* ── Menschenwörter (nur Anzeige-Übersetzung, KEINE Zustandslogik) ───── */

const TARGET_WORDS = { OFFLINE: "aus", CONNECTING: "verbinde…", ONLINE: "verbunden", DEGRADED: "eingeschränkt", DISCONNECTED: "getrennt" };
const AGENT_WORDS = { IDLE: "wartet", WORKING: "arbeitet", WAITING: "wartet auf dich", PAUSE_REQUESTED: "pausiere…", PAUSED: "pausiert", BLOCKED: "geblockt", FAILED: "fehler", STOP_REQUESTED: "stoppe…", STOPPED: "beendet" };

/* ── Ink-Frontend (falls installiert) ────────────────────────────────── */

let inkAvailable = false;
try {
  await import("ink");
  inkAvailable = true;
} catch {
  inkAvailable = false;
}

// Ink nur mit echtem TTY: ohne Raw-Mode-Fähigkeit (piped/ohne Terminal)
// läuft der Poll-Modus — dieselbe Backend-Wahrheit, dieselben Befehle.
if (inkAvailable && process.stdin.isTTY) {
  const React = (await import("react")).default;
  const { useState, useEffect } = await import("react");
  const { render, Text, Box, useInput } = await import("ink");

  // React.createElement statt JSX — die Datei bleibt direkt mit Node startbar.
  const h = React.createElement;
  const T = (props, ...children) => h(Text, props, ...children);

  function Cockpit() {
    const [, force] = useState(0);
    useEffect(() => {
      sseConnect("/api/events", (item) => {
        // Der SSE-Frame ist der komplette Backend-Snapshot ("state") plus Events —
        // die CLI führt KEINE eigene Zustandslogik, sie spiegelt nur.
        if (item.type === "state") {
          ui.status = item;
        } else if (item.type === "event") {
          ui.lastEvents = [item.event, ...ui.lastEvents].slice(0, 12);
        }
        force((n) => n + 1);
      });
      const t = setInterval(() => force((n) => n + 1), 1000);
      return () => clearInterval(t);
    }, []);

    useInput(async (input, key) => {
      const agent = ui.status?.agents?.find((a) => a.state !== "IDLE") ?? ui.status?.agents?.[0];
      // [y]/[n]: echte Freigabe-Entscheidung über denselben REST-Bus wie React.
      const pending = ui.status?.approvals?.[0];
      if (pending && (input === "y" || input === "n")) {
        await post(`/api/approvals/${encodeURIComponent(pending.commandId)}`, { approved: input === "y" });
        return;
      }
      if (input === "p" && agent) await post(`/api/agents/${encodeURIComponent(agent.id)}/${agent.state === "PAUSED" ? "resume" : "pause"}`, {});
      if (input === "s" && agent) await post(`/api/agents/${encodeURIComponent(agent.id)}/stop`, {});
      if (input === "g") { ui.mode = ui.mode === "goal" ? "status" : "goal"; ui.goalDraft = ""; }
      if (ui.mode === "goal") {
        if (key.return && agent && ui.goalDraft.trim()) {
          await post(`/api/agents/${encodeURIComponent(agent.id)}/goal`, { goal: ui.goalDraft.trim() });
          ui.mode = "status";
        } else if (key.backspace || key.delete) ui.goalDraft = ui.goalDraft.slice(0, -1);
        else if (input && input.length === 1) ui.goalDraft += input;
      }
      if (input === "q") process.exit(0);
    });

    if (!ui.status) return h(Text, null, `Verbinde mit ${BACKEND} …`);
    const { targets, agents, blocks, approvals, stats, ports } = ui.status;
    const agent = agents?.find((a) => a.state !== "IDLE") ?? agents?.[0];
    const target = targets?.[0];
    const activeBlocks = (blocks ?? []).filter((b) => b.active);

    const lines = [
      T({ bold: true, color: "cyan" }, "GODOT ACP — Agent-Cockpit (Terminal)"),
      T(null, "Spiel:  ", T({ bold: true, color: target?.state === "ONLINE" ? "green" : "red" }, TARGET_WORDS[target?.state] ?? target?.state ?? "—")),
      T(null, "Agent:  ", T({ bold: true, color: agent?.state === "WORKING" ? "green" : agent?.state === "PAUSED" ? "yellow" : "gray" }, AGENT_WORDS[agent?.state] ?? agent?.state ?? "—")),
      T(null, "Aktion: ", T({ dimColor: true }, agent?.currentAction || "—")),
      T(null, "Ziel:   ", T({ dimColor: true }, agent?.goal || "noch keins")),
      T(null, `Bilanz: ${stats?.completed ?? 0} erledigt · ${stats?.blocked ?? 0} gestoppt · ${stats?.eventsSeen ?? 0} Ereignisse`),
    ];
    if (activeBlocks.length > 0) lines.push(T({ color: "red" }, `Aktive Sperren: ${activeBlocks.map((b) => b.value).join(", ")}`));
    if ((approvals ?? []).length > 0) lines.push(T({ color: "yellow" }, `FREIGABE ERFORDERLICH: ${approvals.map((a) => a.tool).join(", ")} — [y] erlauben · [n] verweigern`));
    lines.push(T({ dimColor: true }, "[p] Pause/Weiter  [s] Stop  [g] Ziel  [y]/[n] Freigabe  [q] Beenden"));
    if (ui.mode === "goal") {
      lines.push(T({ color: "green" }, `Ziel: ${ui.goalDraft}| (Enter = setzen)`));
    }
    lines.push(T({ dimColor: true }, `Backend ${ports?.backend} · Agent-Zugang ${ports?.proxy} · Spiel ${ports?.godot}`));
    for (const ev of ui.lastEvents.slice(0, 8)) {
      lines.push(T({ dimColor: ev.kind === "command" }, `${new Date(ev.ts).toLocaleTimeString("de-DE")} ${String(ev.kind).padEnd(8)} ${ev.message}`));
    }

    return h(Box, { flexDirection: "column", padding: 1, gap: 1 }, ...lines);
  }

  render(h(Cockpit));
} else {
  /* ── Fallback: Poll-Modus ohne Dependencies ── */
  const { stdin } = process;
  try { stdin.setRawMode(true); } catch { /* nicht-interaktiv */ }
  stdin.resume();
  stdin.setEncoding("utf8");
  stdin.on("data", async (key) => {
    const agentRes = await fetch(`${BACKEND}/api/status`).then((r) => r.json()).catch(() => null);
    const agent = agentRes?.agents?.find((a) => a.state !== "IDLE") ?? agentRes?.agents?.[0];
    if (key === "q" || key === "\u0003") process.exit(0);
    const pending = agentRes?.approvals?.[0];
    if (pending && (key === "y" || key === "n")) {
      await post(`/api/approvals/${encodeURIComponent(pending.commandId)}`, { approved: key === "y" });
      return;
    }
    if (key === "p" && agent) await post(`/api/agents/${encodeURIComponent(agent.id)}/${agent.state === "PAUSED" ? "resume" : "pause"}`, {});
    if (key === "s" && agent) await post(`/api/agents/${encodeURIComponent(agent.id)}/stop`, {});
  });

  sseConnect("/api/events", (item) => {
    if (item.type === "state") ui.status = item;
    if (item.type === "event") {
      ui.lastEvents = [item.event, ...ui.lastEvents].slice(0, 8);
      console.clear?.();
      const s = ui.status ?? {};
      const agent = s.agents?.find((a) => a.state !== "IDLE") ?? s.agents?.[0];
      console.log("GODOT ACP — Cockpit (Poll-Modus, p=Pause/Weiter s=Stop y/n=Freigabe q=Ende)");
      console.log(`Spiel: ${s.targets?.[0]?.state ?? "—"}  Agent: ${agent?.state ?? "—"}  Aktion: ${agent?.currentAction ?? "—"}`);
      console.log(`Bilanz: ${JSON.stringify(s.stats ?? {})}`);
      if ((s.approvals ?? []).length > 0) console.log(`FREIGABE ERFORDERLICH: ${s.approvals.map((a) => a.tool).join(", ")} — [y] erlauben · [n] verweigern`);
      for (const ev of ui.lastEvents) console.log(`  ${new Date(ev.ts).toLocaleTimeString("de-DE")} ${ev.kind.padEnd(8)} ${ev.message}`);
    }
  });
}
