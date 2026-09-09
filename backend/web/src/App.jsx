/**
 * GODOT ACP — Agent-Cockpit (Dashboard).
 *
 * Nicht-technische Aufsicht: zusehen, pausieren, Ziel geben, Tools sperren,
 * Freigaben entscheiden — alles ohne den Agent-Chat zu berühren. Der Nutzer
 * ändert Systemzustände, der Agent erhält die Konsequenz als Protokollantwort.
 */
import React, { useState } from "react";
import { useBackend } from "./useBackend.js";

const SESSION_LABELS = {
  IDLE: " wartet auf Ziel",
  RUNNING: "arbeitet",
  PAUSE_REQUESTED: "Pause angefragt",
  PAUSED: "pausiert (dein Befehl)",
  STOP_REQUESTED: "wird beendet",
};

function pillClass(sess) {
  switch (sess) {
    case "RUNNING": return "pill ok";
    case "PAUSED": case "PAUSE_REQUESTED": case "STOP_REQUESTED": return "pill warn";
    default: return "pill idle";
  }
}

function targetPill(t) {
  switch (t) {
    case "CONNECTED": return "pill ok";
    case "CONNECTING": case "RECONNECTING": return "pill warn";
    case "DEGRADED": return "pill err";
    default: return "pill idle";
  }
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function App() {
  const { state, events, tools, connected, sendCommand, decideApproval } = useBackend();
  const [goalDraft, setGoalDraft] = useState("");

  if (!state) {
    return (
      <div className="app">
        <p>Verbinde mit Backend …</p>
      </div>
    );
  }

  const { target, agent, stats, blockedTools, approvals, ports } = state;
  const sess = agent.session;
  const controlsOn = sess.controlsEnabled;

  const submitGoal = async () => {
    const g = goalDraft.trim();
    if (!g) return;
    await sendCommand("session.goal", { goal: g });
    setGoalDraft("");
  };

  const toggleBlock = async (tool) => {
    if (blockedTools.includes(tool)) {
      await sendCommand("tools.unblock", { tools: [tool] });
    } else {
      await sendCommand("tools.block", { tools: [tool] });
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>GODOT ACP — Agent-Cockpit</h1>
        <span className="live-dot" data-on={connected} style={connected ? { background: "var(--ok)" } : {}}>
        </span>
        <span className="subtitle" style={{ margin: 0 }}>{connected ? "Live" : "Backend nicht erreichbar"}</span>
      </header>
      <p className="subtitle">
        Du siehst, was der KI-Agent im Spiel tut. Du kannst ihn jederzeit anhalten, umlenken oder
        einzelne Werkzeuge sperren — ohne ein Wort mit ihm zu wechseln.
      </p>

      {approvals.length > 0 && (
        <section className="approval-box">
          <h3>Freigabe erforderlich</h3>
          <p style={{ margin: "0 0 10px" }}>
            Der Agent möchte eine besonders wirksame Aktion ausführen: <strong>{approvals.join(", ")}</strong>.
            Du entscheidest.
          </p>
          <div className="controls-row" style={{ marginTop: 0 }}>
            <button className="success" onClick={() => decideApproval(approvals[0], true)}>Erlauben</button>
            <button className="danger" onClick={() => decideApproval(approvals[0], false)}>Ablehnen</button>
          </div>
        </section>
      )}

      <div className="grid">
        {/* ── Zustand ── */}
        <section className="card">
          <h2>Zustand</h2>
          <div className="status-line">
            <span>Spiel (Godot)</span>
            <span className={targetPill(target.state)}>{target.state}</span>
          </div>
          <div className="status-line">
            <span>Agent</span>
            <span className={pillClass(sess.state)}>{SESSION_LABELS[sess.state] ?? sess.state}</span>
          </div>
          <div className="status-line">
            <span>Aktuelle Aktion</span>
            <span className="dim">{sess.currentAction || "—"}</span>
          </div>
          <div className="status-line">
            <span>Läuft seit</span>
            <span className="dim">{Math.floor(state.uptimeSeconds / 60)} min</span>
          </div>
        </section>

        {/* ── Steuerung ── */}
        <section className="card">
          <h2>Steuerung</h2>
          <div className="controls-row">
            {sess.state === "PAUSED" ? (
              <button className="success" disabled={!controlsOn} onClick={() => sendCommand("session.resume", {})}>
                Weiterlaufen lassen
              </button>
            ) : (
              <button className="danger" disabled={!controlsOn} onClick={() => sendCommand("session.pause", {})}>
                Pause
              </button>
            )}
            <button disabled={!controlsOn} onClick={() => sendCommand("session.stop", {})}>
              Beenden
            </button>
            <button disabled={!controlsOn} onClick={() => sendCommand("godot.reconnect", {})}>
              Spiel neu verbinden
            </button>
          </div>

          <label htmlFor="goal" style={{ display: "block", marginTop: 14, color: "var(--text-dim)", fontSize: 13 }}>
            Ziel für den Agenten (ändert, WORAN er arbeitet — nicht wie):
          </label>
          <input
            id="goal"
            className="goal-input"
            placeholder="z. B. Spiele das Hauptmenü durch und schaue, ob alle Buttons funktionieren"
            value={goalDraft}
            disabled={!controlsOn}
            onChange={(e) => setGoalDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitGoal()}
          />
          <div className="controls-row">
            <button className="success" disabled={!controlsOn || !goalDraft.trim()} onClick={submitGoal}>
              Ziel setzen
            </button>
          </div>
          <p className="hint">
            Aktuelles Ziel: {sess.goal ? <strong>{sess.goal}</strong> : <em>noch keins gesetzt</em>}
          </p>
        </section>

        {/* ── Werkzeuge sperren ── */}
        <section className="card">
          <h2>Werkzeuge sperren</h2>
          {tools.length === 0 ? (
            <p className="dim" style={{ color: "var(--text-dim)", fontSize: 14 }}>
              Keine Werkzeugliste verfügbar — das Spiel läuft gerade nicht. Starte Godot mit dem MCP-Addon.
            </p>
          ) : (
            <>
              <p className="hint" style={{ marginTop: 0 }}>
                Anklicken = sperren (rot, durchgestrichen). Der Agent erhält dann für dieses Werkzeug
                nur noch eine höfliche, aber unmissverständliche Ablehnung.
              </p>
              <div className="tool-list">
                {tools.map((t) => (
                  <button
                    key={t.name}
                    className={"tool-chip" + (blockedTools.includes(t.name) ? " blocked" : "")}
                    title={t.description}
                    disabled={!controlsOn}
                    onClick={() => toggleBlock(t.name)}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>

        {/* ── Zahlen ── */}
        <section className="card">
          <h2>Zahlen</h2>
          <div className="stats-grid">
            <div><div className="num">{stats.callsOk}</div>erlaubte Aktionen</div>
            <div><div className="num">{stats.callsDenied}</div>gestoppte Aktionen</div>
            <div><div className="num">{stats.callsBlocked}</div>durch Blockliste</div>
            <div><div className="num">{stats.callsTotal}</div>insgesamt</div>
          </div>
        </section>
      </div>

      {/* ── Live-Feed ── */}
      <section className="card">
        <h2>Live — was der Agent gerade tut</h2>
        {events.length === 0 ? (
          <p style={{ color: "var(--text-dim)", fontSize: 14 }}>Noch ruhig hier. Der Feed füllt sich, sobald der Agent arbeitet.</p>
        ) : (
          <div className="feed">
            {events.map((ev, i) => (
              <div className="feed-item" key={`${ev.ts}-${i}`}>
                <span className="feed-time">{fmtTime(ev.ts)}</span>
                <span className={"feed-kind " + ev.kind}>{ev.kind}</span>
                <span className="feed-msg">{ev.message}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="hint">
        Ports: Dashboard {ports.backend} · Agent-Proxy {ports.proxy} · Spiel {ports.target ?? ports.godot}.
        Der Agent verbindet sich ausschließlich mit dem Proxy — jede seiner Aktionen ist hier sichtbar
        und stoppbar. Belege (Screenshots, Chains) liegen beim Spiel unter <code>user://mcp_context</code>.
      </p>
    </div>
  );
}
