# ROADMAP — GODOT ACP

> **Stand:** September 2026 · Witz-Pflicht: erfüllt. Priorisierung: ehrlich.

Wie jede gute Roadmap ist auch diese eine Momentaufnahme mit Ambitionen.
Abgehakt heißt: implementiert **und** bewiesen (Chains vor Behauptungen —
siehe `AGENTS.md`).

---

## ✅ Erledigt (v1.0)

- [x] MCP-Server im Spiel-Prozess (TCP 9090, JSON-RPC 2.0, PROCESS_MODE_ALWAYS)
- [x] 143+ Domain-Tools + 6 Host-Tools über die `McpToolRegistry`
- [x] Runtime-/Input-Tools: Szenenbaum, Klicks mit sanfter Annäherung, Tasten, Drag, Scroll
- [x] Freeze/Step: deterministische Frame-Steuerung inkl. Input-Queue im gefrorenen Baum
- [x] Vision-Pipeline: lokale Screenshot-Artefakte (TTL 45 s), Python-Worker, OCR-Pool
- [x] `visual_evidence`: Fire-and-forget-Beweise bei unerwarteten Antworten
- [x] UX-Pipeline: Scan/Find/Click/Watch mit ereignisgesteuerten Snapshots
- [x] Session-Profile `player`/`qa`/`dev` mit Contract-Gate (Spieler-Vertrag erzwungen)
- [x] Autonomy-Workspace: journaled Writes, Fail-closed Patches, gated Export, Hash-Rollback
- [x] Chain-Controller: versionierte Manifeste, Validation vor Ausführung, Evidenz-Trace
- [x] Run-Trace: ein Evidence-Record pro Run (`user://mcp_traces/`)
- [x] Playthrough-Archiv: JSONL + Frames + Presets für Cross-Session-Wissen
- [x] **Entkopplung:** keine Spiel-Defaults, `McpAddonConfig` als zentrale Config-Schicht,
      saubere Degradierung (`SKIP`/`BLOCKED`/`not configured`)
- [x] Commit-Governance (`agent.md`) + Commit-Gate (`testing/commit_gate.sh`)
- [x] **Backend-Cockpit (v1.0-Halbgeburt fixiert):** zentrale Steuerungsebene unabhängig von
      Godot (`backend/server.mjs`) — Agent-Proxy mit Pause/Blockliste/Freigaben/Zielen,
      React-Dashboard (Live-Feed, Ziel-Eingabe, Tool-Sperrliste), SSE + JSONL-Persistenz,
      Smoke-Test mit Godot-Simulator beweist alle vier Eingriffspfade

## 🔨 In Arbeit (v1.1)

- [ ] **Backend v1.1:** Screenshot-Evidenz im Dashboard anzeigen (Bild-Pfad aus
      `user://mcp_context` serialisieren), Mehr-Agent-Views, Ink-Cockpit mit `ink` als
      optionalem Dependency-Hinweis statt Hand-Installation
- [ ] Editor-Session-Tools komplett auf ACP-Präfixe konsolidieren
- [ ] Bestandsaufnahme (`BESTANDSAUFNAHME.md`) als lebendes Dokument finalisieren
- [ ] Portable Smoke in CI (GitHub Actions, Godot-Headless-Build als Matrix)
- [ ] `.tres`-Szenarien komplett auf konfigurierbare Labels umstellen

## 🎯 Nächste Station (v1.2)

- [ ] **Multi-Client-Sessions:** zwei Agenten, ein Spiel, konfliktfrei
      (Session-Scopes für Watch-Status und Kontext-Artefakte)
- [ ] **Impact-Graph** (offen seit dem Audit): Code-Analyzer-Muster zu echtem
      Abhängigkeits-Graphen für gezielte Regressionstests
- [ ] **Assertion-Bibliothek:** wiederverwendbare `expect`-Bausteine für
      Chain-Manifeste (DOM-artige UI-Matcher: sichtbar, enabled, Text enthält)
- [ ] **Screenshot-Diff-Alarme** im UX-Watch: Signatur-Delta mit Schwelle statt
      nur exaktem Hash
- [ ] **Windows-/Linux-Install-Skript** für Addon + Bridge-Wrapper in einem Rutsch

## 🌭 Danach (v2.0)

- [ ] **Replay-Format:** aufgezeichnete Agent-Sessions als abspielbare, diffbare
      Dateien (Beweismaterial mit Rückspulfunktion)
- [ ] **Coverage-View:** welche UI-Flows wurden von Agenten schon gesehen,
      welche nie? (Schwärzestand als Metrik)
- [ ] **Goal-Player 2.0:** LLM-unabhängige Heuristik-Goals ("erreiche Szene X")
      ohne `runtime_eval`
- [ ] **Audio-Evidence-Integration:** der lokale Audio-Analyzer wird
      Erstklassbürger im Run-Trace (Waveforms als Evidenz)

## 🌙 Mondschuss (Backlog ohne Termin)

- [ ] **Godot-Editor-Web-View:** Live-Pipeline im Browser
- [ ] **Multi-Game-Farm:** ein Agent, N Spiele, Round-Robin-Playtesting
- [ ] **A11y-Audits:** automatische Kontrast-/Fokus-Checks aus der UX-Pipeline
- [ ] **Mutation-Testing:** das Add-on mutiert Spielcode bewusst und misst,
      ob die Chains es merken (Chains, die Chains prüfen — Inception mit Beleg)

---

## Versions-Disziplin

- **Patch** (1.0.x): Bugfixes mit Beleg, Doku, Tool-Verhalten unverändert
- **Minor** (1.x.0): neue Tools, neue Settings, neue Chain-Features — rückwärtskompatibel
- **Major** (x.0.0): Tool-Renamings, Setting-Migrationen, Protokoll-Änderungen

Jede Versionserhöhung läuft durchs Commit-Gate (`testing/commit_gate.sh`) und
aktualisiert `plugin.cfg` + diese Roadmap. Ohne Ausnahme. Das Gate schaut weg,
wenn du es umgehst — aber das Anomalien-Register nicht.
