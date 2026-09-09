/**
 * GODOT ACP — Agent-Cockpit (Dashboard).
 *
 * Zeigt die Backend-Wahrheit. Keine technischen MCP-Begriffe als primäre
 * Oberfläche: Der Nutzer sieht „Oberfläche ablesen", intern bleibt es
 * `runtime_ux_scan`. Steuerung = Systemzustände ändern, nie chatten.
 */
import React, { useState } from "react";
import { useBackend, humanTool, humanTargetState, humanAgentState, humanCommandState } from "./useBackend.js";

const fmtTime = (ts) => new Date(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export default function App() {
  const { status, events, commands, connected, agentAction, decideApproval, toggleBlock, liftBlock } = useBackend();
  const [goalDraft, setGoalDraft] = useState("");

  if (!status) {
    return <div className="app"><p>Verbinde mit Backend …</p></div>;
  }

  const agent = status.agents.find((a) => a.state !== "IDLE") ?? status.agents[0];
  const target = status.targets[0];
  const activeBlocks = status.blocks.filter((b) => b.active);
  const runningCmd = commands.find((c) => c.state === "RUNNING");
  const recent = commands.slice(0, 8);
  const knownTools = [
    ...new Set(recent.filter((c) => c.tool).map((c) => c.tool)),
  ];

  const submitGoal = async () => {
    const g = goalDraft.trim();
    if (!g || !agent) return;
    await agentAction(agent.id, "goal", { goal: g });
    setGoalDraft("");
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>GODOT ACP — Agent-Cockpit</h1>
        <span className={"live-dot" + (connected ? " on" : "")}></span>
        <span className="subtitle" style={{ margin: 0 }}>{connected ? "Live" : "Backend nicht erreichbar"}</span>
      </header>
      <p className="subtitle">
        Du siehst, was der KI-Agent im Spiel tut. Pausieren, umlenken, Werkzeuge
        entziehen — ohne ein Wort mit ihm zu wechseln. Dein Befehl wird zur
        Systemwahrheit, der Agent bekommt sie als Antwort auf seine nächste Aktion.
      </p>

      {/* ── Freigaben zuerst — der Nutzer entscheidet ── */}
      {status.approvals.length > 0 && (
        <section className="approval-box">
          <h3>Der Agent bittet um Erlaubnis</h3>
          {status.approvals.map((a) => (
            <div key={a.commandId} style={{ marginBottom: 10 }}>
              <p style={{ margin: "0 0 8px" }}>
                Besonders wirksame Aktion: <strong>{humanTool(a.tool)}</strong>
                <span className="hint" style={{ display: "inline" }}> (intern: {a.tool})</span>
              </p>
              <div className="controls-row" style={{ marginTop: 0 }}>
                <button className="success" onClick={() => decideApproval(a.commandId, true)}>Erlauben</button>
                <button className="danger" onClick={() => decideApproval(a.commandId, false)}>Nicht erlauben</button>
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="grid">
        {/* ── STATUS ── */}
        <section className="card">
          <h2>Status</h2>
          <div className="status-line">
            <span>Spiel</span>
            <span className={`pill ${humanTargetState(target?.state).cls}`}>
              {humanTargetState(target?.state).label}
            </span>
          </div>
          <div className="status-line">
            <span>Agent</span>
            <span className={`pill ${humanAgentState(agent?.state).cls}`}>
              {humanAgentState(agent?.state).label}
            </span>
          </div>
          <div className="status-line">
            <span>Gerade am Werk</span>
            <span className="dim">{runningCmd ? humanTool(runningCmd.tool) : agent?.currentAction ? humanTool(agent.currentAction) : "—"}</span>
          </div>
          <div className="status-line">
            <span>Backend läuft seit</span>
            <span className="dim">{Math.floor(status.uptimeSeconds / 60)} min</span>
          </div>
        </section>

        {/* ── KONTROLLE ── */}
        <section className="card">
          <h2>Kontrolle</h2>
          <div className="controls-row">
            {agent?.state === "PAUSED" ? (
              <button className="success" onClick={() => agentAction(agent.id, "resume")}>Weiter arbeiten lassen</button>
            ) : (
              <button className="danger" disabled={agent?.state === "PAUSED"} onClick={() => agentAction(agent.id, "pause")}>Pause</button>
            )}
            <button onClick={() => agentAction(agent?.id ?? "", "stop")}>Beenden</button>
            <button onClick={() => status && fetch("/api/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin: "human", type: "target_reconnect", payload: {} }) })}>
              Spiel neu verbinden
            </button>
          </div>
          <label htmlFor="goal" style={{ display: "block", marginTop: 14, color: "var(--text-dim)", fontSize: 13 }}>
            Ziel vorgeben (sagt dem Agenten WAS er tun soll — nicht wie):
          </label>
          <input
            id="goal"
            className="goal-input"
            placeholder="z. B. Spiele das Hauptmenü durch und schaue, ob alle Buttons funktionieren"
            value={goalDraft}
            onChange={(e) => setGoalDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitGoal()}
          />
          <div className="controls-row">
            <button className="success" disabled={!goalDraft.trim()} onClick={submitGoal}>Ziel setzen</button>
          </div>
          {agent?.goal && <p className="hint">Aktuelles Ziel: <strong>{agent.goal}</strong></p>}
        </section>

        {/* ── BLOCKIERUNGEN ── */}
        <section className="card">
          <h2>Werkzeuge entziehen</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Anklicken = dem Agenten dieses Werkzeug entziehen (mit Grund). Erhält
            er dann einen Befehl dafür, wird dieser sauber blockiert.
          </p>
          {knownTools.length === 0 && activeBlocks.length === 0 && (
            <p style={{ color: "var(--text-dim)", fontSize: 14 }}>
              Noch keine Werkzeuge sichtbar — sie erscheinen, sobald der Agent gearbeitet hat.
            </p>
          )}
          <div className="tool-list">
            {knownTools.map((tool) => {
              const blocked = activeBlocks.some((b) => b.scope === "tool" && b.value === tool);
              return (
                <button
                  key={tool}
                  className={"tool-chip" + (blocked ? " blocked" : "")}
                  title={tool}
                  onClick={() => toggleBlock(tool, blocked ? "" : "vom Cockpit entzogen")}
                >
                  {humanTool(tool)}
                </button>
              );
            })}
            {activeBlocks.filter((b) => b.scope === "tool").map((b) => (
              knownTools.includes(b.value) ? null : (
                <button key={b.id} className="tool-chip blocked" onClick={() => liftBlock(b.id)} title={b.reason}>
                  {humanTool(b.value)}
                </button>
              )
            ))}
          </div>
          {activeBlocks.length > 0 && (
            <p className="hint">Aktive Sperren: {activeBlocks.length} · Grund jeweils „{activeBlocks[0].reason}“</p>
          )}
        </section>

        {/* ── ZAHLEN ── */}
        <section className="card">
          <h2>Zahlen</h2>
          <div className="stats-grid">
            <div><div className="num">{status.stats.completed}</div>erledigt</div>
            <div><div className="num">{status.stats.blocked}</div>gestoppt</div>
            <div><div className="num">{status.stats.failed + status.stats.timeout}</div>fehlgeschlagen</div>
            <div><div className="num">{status.stats.eventsSeen}</div>Ereignisse</div>
          </div>
        </section>
      </div>

      {/* ── LIVE-FEED ── */}
      <section className="card">
        <h2>Live — was gerade passiert</h2>
        {events.length === 0 ? (
          <p style={{ color: "var(--text-dim)", fontSize: 14 }}>Noch ruhig hier. Der Feed füllt sich, sobald etwas passiert.</p>
        ) : (
          <div className="feed">
            {events.slice(0, 40).map((ev, i) => (
              <div className="feed-item" key={`${ev.ts}-${i}`}>
                <span className="feed-time">{fmtTime(ev.ts)}</span>
                <span className={"feed-kind " + ev.kind}>{feedLabel(ev)}</span>
                <span className="feed-msg">{feedText(ev)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="hint">
        Ports: Cockpit {status.ports.backend} · Agent-Zugang {status.ports.proxy} · Spiel {status.ports.godot}.
        Der Agent kennt nur den Zugang {status.ports.proxy} — jede seiner Aktionen läuft über
        das Backend und ist hier sichtbar und stoppbar. Alle Belege (Abläufe, Befehle,
        Freigaben) sind in <code>{/* data dir */}backend/data/*.jsonl</code> dauerhaft protokolliert.
      </p>
    </div>
  );
}

function feedLabel(ev) {
  switch (ev.kind) {
    case "agent": return "Agent";
    case "target": return "Spiel";
    case "command_result": return "Ergebnis";
    case "approval": return "Freigabe";
    case "block": return "Sperre";
    case "timeout": return "Zeitlimit";
    case "command": return "Befehl";
    default: return "System";
  }
}

function feedText(ev) {
  return ev.message
    .replace("godot.event — acp/pause_agent: command_result", "Spiel bestätigt: Pause angekommen")
    .replace("godot.event — notifications/message: command_result", "Spiel bestätigt: Befehl angekommen")
    .replace("godot.event — acp/resume_agent", "Spiel bestätigt: Weiterarbeiten")
    .replace("godot.connected", "Spiel verbunden")
    .replace("godot.disconnected", "Spiel getrennt")
    .replace("godot.state_changed", "Spiel-Status geändert")
    ?? ev.message;
}
