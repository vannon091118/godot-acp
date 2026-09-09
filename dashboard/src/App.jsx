/**
 * GODOT ACP — Agent-Cockpit (Dashboard).
 *
 * Beantwortet die sechs Nutzerfragen ohne technisches Wissen:
 *   WAS LÄUFT? · WAS MACHT DER AGENT? · WORAUF WARTET ER?
 *   IST ETWAS BLOCKIERT? · KANN ICH EINGREIFEN? · WAS IST DER LETZTE BEWEIS?
 * Technische Details nur hinter „Details". Jede Anzeige hat einen realen
 * Backend-Zustand — kein erfundener Text, keine Deko-Punkte.
 */
import React, { useState } from "react";
import {
  useBackend, humanTool, targetWord, agentWord, commandWord, qaWord,
  targetCls, agentCls, commandCls, qaCls,
} from "./useBackend.js";

const fmtTime = (ts) => new Date(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export default function App() {
  const { status, contract, events, commands, connected, agentAction, decideApproval, toggleBlock, liftBlock, startQa } = useBackend();
  const [goalDraft, setGoalDraft] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [openEvidence, setOpenEvidence] = useState(null); // qaRunId

  if (!status) return <div className="app"><p>Verbinde mit Backend …</p></div>;

  const agent = status.agents?.find((a) => a.state !== "IDLE") ?? status.agents?.[0];
  const target = status.targets?.[0];
  const activeBlocks = (status.blocks ?? []).filter((b) => b.active);
  const runningCmd = commands.find((c) => c.state === "RUNNING");
  const waitingCmd = commands.find((c) => c.state === "WAITING");
  const blockedCount = commands.filter((c) => ["BLOCKED", "FAILED"].includes(c.state) && Date.now() - c.updatedAt < 60000).length;
  const latestQa = (status.qaRuns ?? [])[0];
  const latestEvidence = latestQa?.evidence?.[latestQa.evidence.length - 1];
  const knownTools = [...new Set(commands.filter((c) => c.tool && c.tool.startsWith("runtime_")).map((c) => c.tool))];

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
        Sechs Antworten, kein Agent-Chat: Was läuft, was tut der Agent, worauf
        wartet er, was ist blockiert, wie greifst du ein, was ist der letzte Beweis.
      </p>

      {/* ── Freigaben: WORAUF WARTET ER → KANN ICH EINGREIFEN ── */}
      {(status.approvals ?? []).length > 0 && (
        <section className="approval-box">
          <h3>Der Agent bittet um Erlaubnis</h3>
          {status.approvals.map((a) => (
            <div key={a.commandId} style={{ marginBottom: 10 }}>
              <p style={{ margin: "0 0 8px" }}>
                Besonders wirksame Aktion: <strong>{humanTool(a.tool)}</strong>
                {showDetails && <span className="hint"> ({a.tool} · command {a.commandId})</span>}
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
        {/* ── WAS LÄUFT? / WAS MACHT DER AGENT? / WORAUF WARTET ER? ── */}
        <section className="card">
          <h2>Was läuft?</h2>
          <div className="status-line">
            <span>Spiel</span>
            <span className={`pill ${targetCls(target?.state)}`}>{targetWord(target?.state, contract)}</span>
          </div>
          <div className="status-line">
            <span>Agent</span>
            <span className={`pill ${agentCls(agent?.state)}`}>{agentWord(agent?.state, contract)}</span>
          </div>
          <div className="status-line">
            <span>Gerade am Werk</span>
            <span className="dim">
              {runningCmd ? humanTool(runningCmd.tool) : agent?.currentAction ? humanTool(agent.currentAction) : "—"}
            </span>
          </div>
          {waitingCmd && (
            <div className="status-line">
              <span>Wartet auf</span>
              <span style={{ color: "var(--warn)" }}>deine Entscheidung: {humanTool(waitingCmd.tool)}</span>
            </div>
          )}
          {agent?.goal && <p className="hint">Ziel: <strong>{agent.goal}</strong></p>}
        </section>

        {/* ── KANN ICH EINGREIFEN? ── */}
        <section className="card">
          <h2>Eingreifen</h2>
          <div className="controls-row">
            {agent?.state === "PAUSED" ? (
              <button className="success" onClick={() => agentAction(agent.id, "resume")}>Weiter arbeiten lassen</button>
            ) : (
              <button className="danger" onClick={() => agentAction(agent?.id ?? "", "pause")}>Pause</button>
            )}
            <button onClick={() => agentAction(agent?.id ?? "", "stop")}>Beenden</button>
            <button onClick={() => fetch("/api/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin: "human", type: "target_reconnect", payload: {} }) })}>
              Spiel neu verbinden
            </button>
          </div>
          <label htmlFor="goal" style={{ display: "block", marginTop: 14, color: "var(--text-dim)", fontSize: 13 }}>
            Ziel ändern (sagt WAS, nicht WIE):
          </label>
          <input
            id="goal" className="goal-input"
            placeholder="z. B. Prüfe das Hauptmenü und klicke jeden Button einmal an"
            value={goalDraft}
            onChange={(e) => setGoalDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitGoal()}
          />
          <div className="controls-row">
            <button className="success" disabled={!goalDraft.trim()} onClick={submitGoal}>Ziel setzen</button>
          </div>
        </section>

        {/* ── IST ETWAS BLOCKIERT? ── */}
        <section className="card">
          <h2>Blockiert?</h2>
          <div className="status-line">
            <span>Aktive Sperren</span>
            <span className={`pill ${activeBlocks.length ? "warn" : "idle"}`}>{activeBlocks.length}</span>
          </div>
          <div className="status-line">
            <span>Kürzlich gestoppt/fehlgeschlagen</span>
            <span className={`pill ${blockedCount ? "err" : "idle"}`}>{blockedCount}</span>
          </div>
          {activeBlocks.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {activeBlocks.map((b) => (
                <div className="status-line" key={b.id}>
                  <span>{humanTool(b.value)} <span className="dim">({b.reason})</span></span>
                  <button style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => liftBlock(b.id)}>Freigeben</button>
                </div>
              ))}
            </div>
          )}
          {knownTools.length > 0 && (
            <>
              <p className="hint" style={{ marginTop: 10 }}>Werkzeug entziehen (Klick = sperren):</p>
              <div className="tool-list">
                {knownTools.map((tool) => {
                  const blocked = activeBlocks.some((b) => b.scope === "tool" && b.value === tool);
                  return (
                    <button
                      key={tool}
                      className={"tool-chip" + (blocked ? " blocked" : "")}
                      title={tool}
                      onClick={() => toggleBlock(tool, "vom Cockpit entzogen")}
                    >
                      {humanTool(tool)}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </section>

        {/* ── QA STARTEN (Human Control: qa-Command über denselben Bus) ── */}
        <section className="card">
          <h2>Schnelltest starten</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Ein kleiner QA-Lauf: Beobachten, Erwartung prüfen, Beweis sichern.
          </p>
          <div className="controls-row">
            <button
              className="success"
              onClick={() => startQa("Menü-Sanity", [
                { label: "Oberfläche lesbar", tool: "runtime_ux_scan", expected: "" },
                { label: "Suche antwortet", tool: "runtime_ux_find", expected: "" },
              ])}
            >
              Schnelltest ausführen
            </button>
          </div>
          {latestQa && (
            <div style={{ marginTop: 10 }}>
              <div className="status-line">
                <span>{latestQa.name}</span>
                <span className={`pill ${qaCls(latestQa.verdict ?? latestQa.state)}`}>
                  {latestQa.verdict ? qaWord(latestQa.verdict, contract) : qaWord(latestQa.state, contract)}
                </span>
              </div>
              {latestQa.steps.map((s, i) => (
                <div className="status-line" key={i}>
                  <span>{s.label}</span>
                  <span className={`pill ${s.state === "PASS" ? "ok" : s.state === "FAIL" ? "err" : "idle"}`}>{s.state === "PASS" ? "ok" : s.state === "FAIL" ? "fehler" : "läuft"}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* ── WARTET DER ORCHESTRATOR? (Backend beobachtet endet nicht) ── */}
      <section className="card">
        <h2>Automatische Überwachung</h2>
        <div className="status-line">
          <span>Überwachung</span>
          <span className={`pill ${status.orchestrator?.running ? "ok" : "idle"}`}>
            {status.orchestrator?.running ? "aktiv" : "aus"}
            {status.orchestrator?.analyzing ? " · analysiert" : ""}
          </span>
        </div>
        <div className="status-line">
          <span>Offene Auffälligkeiten</span>
          <span className={`pill ${(status.orchestrator?.anomalies ?? []).some((a) => a.state === "OPEN") ? "err" : "ok"}`}>
            {(status.orchestrator?.anomalies ?? []).filter((a) => a.state === "OPEN").length}
          </span>
        </div>
        {(status.orchestrator?.anomalies ?? []).length > 0 && (
          <div style={{ marginTop: 8 }}>
            {status.orchestrator.anomalies.slice(0, 4).map((a) => (
              <div className="status-line" key={a.id}>
                <span>
                  {a.tool ? <code>{humanTool(a.tool)}</code> : "System"} <span className="dim">— {a.message?.slice(0, 70)}</span>
                </span>
                <span className={`pill ${a.state === "ANALYZED" ? "ok" : a.state === "ANALYZING" ? "warn" : "err"}`}>
                  {a.state === "ANALYZED" ? "untersucht" : a.state === "ANALYZING" ? "wird untersucht" : "offen"}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="hint">
          Das Backend beobachtet dauerhaft und untersucht Auffälligkeiten automatisch
          (Ansicht, Texterkennung, Spuren). Arbeitspakete: {status.orchestrator?.workOrders?.length ?? 0} ·
          Spiel-Fähigkeiten gebunden: {status.orchestrator?.capabilitiesCount ?? 0}
          {showDetails && status.orchestrator?.capabilities?.length > 0 && (
            <span> · <code>{status.orchestrator.capabilities.join(", ")}</code></span>
          )}
        </p>
      </section>

      {/* ── WAS IST DER LETZTE BEWEIS? ── */}
      <section className="card">
        <h2>Letzter Beweis</h2>
        {latestEvidence ? (
          <div>
            <div className="status-line">
              <span><strong>{latestEvidence.step}</strong> — erwartet: „{latestEvidence.expected}"</span>
              <span className={`pill ${latestEvidence.ok ? "ok" : "err"}`}>{latestEvidence.ok ? "bestätigt" : "abweichend"}</span>
            </div>
            <p className="hint">Beobachtet: {latestEvidence.observed} · {fmtTime(latestEvidence.ts)}</p>
            {(latestQa.evidence.length > 1 || latestQa.verdict) && (
              <div className="controls-row">
                <button onClick={() => setOpenEvidence(openEvidence === latestQa.id ? null : latestQa.id)}>
                  {openEvidence === latestQa.id ? "Beweise zuklappen" : `Alle ${latestQa.evidence.length} Beweise ansehen`}
                </button>
              </div>
            )}
            {openEvidence === latestQa.id && (
              <div className="feed" style={{ marginTop: 8 }}>
                {latestQa.evidence.slice().reverse().map((e, i) => (
                  <div className="feed-item" key={i}>
                    <span className="feed-time">{fmtTime(e.ts)}</span>
                    <span className={"feed-kind " + (e.ok ? "agent" : "intercept")}>{e.ok ? "ok" : "abweichend"}</span>
                    <span className="feed-msg">
                      <strong>{e.step}</strong> — erwartet „{e.expected}", beobachtet: {e.observed}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p style={{ color: "var(--text-dim)", fontSize: 14 }}>
            Noch kein Beweis vorhanden — starte einen Schnelltest oder warte, bis der Agent arbeitet.
          </p>
        )}
      </section>

      {/* ── Live-Feed ── */}
      <section className="card">
        <h2>Live</h2>
        {events.length === 0 ? (
          <p style={{ color: "var(--text-dim)", fontSize: 14 }}>Ruhig. Der Feed füllt sich bei Aktivität.</p>
        ) : (
          <div className="feed">
            {events.slice(0, 30).map((ev, i) => (
              <div className="feed-item" key={`${ev.ts}-${i}`}>
                <span className="feed-time">{fmtTime(ev.ts)}</span>
                <span className={"feed-kind " + ev.kind}>{feedLabel(ev)}</span>
                <span className="feed-msg">{feedText(ev)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Details (technisch) nur auf Wunsch ── */}
      <div className="controls-row">
        <button onClick={() => setShowDetails(!showDetails)}>
          {showDetails ? "Details verbergen" : "Technische Details anzeigen"}
        </button>
      </div>
      {showDetails && (
        <section className="card" style={{ marginTop: 10 }}>
          <h2>Technische Details</h2>
          <div className="feed">
            {commands.slice(0, 10).map((c) => (
              <div className="feed-item" key={c.id}>
                <span className="feed-time">{fmtTime(c.updatedAt)}</span>
                <span className={"feed-kind " + (commandCls(c.state) === "ok" ? "agent" : commandCls(c.state) === "err" ? "intercept" : "command")}>
                  {c.origin}
                </span>
                <span className="feed-msg">
                  <code>{c.tool ?? c.type}</code> · {c.state}{c.reason ? ` — ${c.reason}` : ""} · <code>{c.id}</code>
                </span>
              </div>
            ))}
          </div>
          <p className="hint">
            Vertrag: {(contract?.channels ?? []).join(" · ")} · Ports {JSON.stringify(status.ports ?? {})}
          </p>
        </section>
      )}
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
    case "qa": return "QA";
    case "evidence": return "Beweis";
    case "command": return "Befehl";
    default: return "System";
  }
}

/* Technisches Backend-Event → Menschenwort (musterbasiert, nicht exakt). */
function feedText(ev) {
  const m = ev.message ?? "";
  const obs = m.match(/observation[ —-]*(.*)$/i);
  if (obs) {
    const detail = obs[1]
      .replace(/SceneTree sichtbar,\s*(\d+)\s*Controls/i, (_, n) => `Szene sichtbar · ${n} Elemente`)
      .replace(/SceneTree/i, "Szene");
    return `Spiel meldet: ${detail}`;
  }
  if (/acp\/pause_agent/i.test(m) && /ACK/i.test(m)) return "Spiel bestätigt: Pause angekommen";
  if (/acp\/resume_agent/i.test(m) && /ACK/i.test(m)) return "Spiel bestätigt: Weiterarbeiten";
  if (/command_result/i.test(m)) return "Spiel bestätigt: Befehl ausgeführt";
  return m
    .replace("godot.connected:", "Spiel verbunden:")
    .replace("godot.disconnected:", "Spiel getrennt:")
    .replace("godot.state_changed:", "Spiel-Status:")
    .replace(/godot\.event[ —-]*/i, "");
}
