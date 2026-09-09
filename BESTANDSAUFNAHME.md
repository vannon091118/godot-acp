# BESTANDSAUFNAHME — GODOT ACP (MCP-Addon)

**Stand:** September 2026 · **Repo:** [github.com/vannon091118/godot-acp](https://github.com/vannon091118/godot-acp)
**Zählung autoritativ:** `McpToolRegistry`-Reflection + Direktzählung der
`get_tool_defs()`-Einträge pro Modul (siehe Anhang A). Diese Datei ist die
verbindliche Modul- und Kopplungs-Landkarte; neue Module/Tools werden hier
nachgeführt (Pflicht gemäß `agent.md` §3).

---

## 1. Addon-Identität

| Attribut | Wert |
|---|---|
| Name | **GODOT ACP** (Agent Control Protocol) |
| `plugin.cfg` | `name="GODOT ACP"`, Version 1.0.0, Skript `editor/gdscript_mcp_plugin.gd` |
| Autoloads | `McpRuntime` (Server-Host), `McpProjectAdapter` (optionale Projekt-Brücke) |
| Transport | JSON-RPC 2.0 über stdio (`mcp_stdio_bridge.py`) / TCP (Runtime 9090) |
| Renderer-Pflicht | Headless wird beim Serverstart **verweigert** (Vision/Evidenz erfordern echtes Rendering) |
| Umfang | 57 GDScript-Dateien (~15.6k LOC) + 56 `.uid`-Sidecars, Client-Tools ~4.7k LOC |
| Doku-Hierarchie | L1 `agent.md`/`ENTKOPPLUNG.md` → L2 `MCP_INDEX.md`/`PERSISTENCE.md` → L3 Workflow-Doku → L4 Archiv (diese Datei, `MCP_ANOMALIES.md`) |

## 2. Modullandkarte (runtime/)

| Modul | Pfad | Tools | Zustand |
|---|---|---|---|
| Registry/Routing | `runtime/core/mcp_tool_registry.gd` | — (Dispatcher) | ✅ stabil; Chain-Routing F-01 gefixt (§5) |
| Zentrale Config | `runtime/core/mcp_addon_config.gd` | — (Getter) | ✅ Entkopplung: EIN Ort für `application/mcp/*` |
| Custom-Loader | `runtime/core/mcp_custom_tool_loader.gd` | `custom_*` (hot-reload) | ✅ Host-Projekt-Erweiterungspunkt (`res://mcp_tools/`) |
| Projekt-Adapter | `runtime/core/mcp_project_adapter.gd` | — | ✅ optional, Konventions-Erkennung |
| Server-Host | `runtime/host/mcp_server.gd` | 7 Host-Tools | ✅ inkl. `runtime_mcp_capabilities` (Bootstrap-Discovery, F-03) |
| Runtime-Autoload | `runtime/host/mcp_runtime.gd` | — | ✅ Boot über `--mcp` / `MCP_EMBEDDED` |
| Protokoll/Lifecycle | `runtime/protocol/`, `runtime/lifecycle/` | — | ✅ JSON-RPC-Encoding, Latenz-Tracking |
| Runtime/Input | `runtime/tools/runtime/` | 22 | ✅ Klicks (smooth travel), Freeze/Step, virtuelle Maus |
| Vision | `runtime/tools/vision/` | 22 | ✅ Artefakt-Transport, Worker, OCR-Pool |
| Debug | `runtime/tools/debug/` | 12 | ✅ Perf, Memory, ClassDB, Files |
| UX-Pipeline | `runtime/tools/ux/` | 10 | ✅ Scan/Find/Click/Watch; Szenen-Heuristik entkoppelt |
| Audio/Systeme | `runtime/tools/systems/` | 29 | ⚠️ Audio-Analyse degradiert ohne `audio_analyzer_script` (gewollt) |
| Gameplay (generisch) | `runtime/tools/gameplay/` | 5 | ✅ entkoppelt: `game_state_*`, `game_entity_*` (Duck-Typing) |
| E2E | `runtime/tools/e2e/mcp_e2e.gd` | 2 | ✅ Szenarien degradieren ohne `e2e_*`-Config mit SKIP |
| Goal-Player | `runtime/tools/e2e/mcp_goal_player.gd` | 4 | ✅ qa/dev-Profile |
| Code-Analyzer | `runtime/tools/e2e/mcp_code_analyzer.gd` | 4 | ✅ statische Analyse, `game_state_script`-autark |
| Playthrough-Archiv | `runtime/tools/e2e/mcp_playthrough_tools.gd` | 8 | ✅ `user://mcp_playthrough/` |
| Autonomy-Planner | `runtime/autonomy/mcp_capability_planner.gd` | 19 | ✅ Write-Gate, Workspace, Journal, Rollback |
| Contract-Gate | `runtime/autonomy/mcp_contract_gate.gd` | — | ✅ player/qa/dev-Blocklisten (inkl. neuer `game_*`-Tools) |
| Chain-Controller | `runtime/autonomy/mcp_chain_controller.gd` | 5 | ✅ validate/run/trace/**list/load**; Preflight via Config |
| Run-Trace/Context | `runtime/context/` | — | ✅ Evidence-Records, Artefakt-TTL 45 s |

## 3. Editor-, Test- und Client-Ebene

- **Editor:** `editor/gdscript_mcp_plugin.gd` (Klasse `GodotAcpPlugin`, Auto-Registrierung
  idempotent, `GODOT-ACP`-Log-Prefix) + `mcp_dock.gd` (QA-Live-Dock: Launch, Profile,
  Pipeline-Anzeige) + `mcp_runtime_client.gd` (Liveness-Probe). Editor-Session bietet
  19 `editor_*`-Tools.
- **Testing:** `testing/mcp_test_runner.gd` (Szenario-Runner, sichtbar),
  `mcp_build_check.gd`, 4 Contract-/Red-Team-Tests, `testing/e2e/mcp_playthrough_driver.gd`
  (Start-Szene ausschließlich via Config), `testing/portable/run_portable_smoke.sh`
  (Fremdprojekt-Beweis), `testing/commit_gate.sh` (Governance-Gate, agent.md §2.2).
- **Client:** `client/mcp_stdio_bridge.py` (externer Standard-Transport, zero-dependency),
  `mcp_file_driver.js` + `atomic/*` (interner Queue-Treiber, 1 Zeile = 1 Call),
  `vision_worker.py` (Bildanalyse/OCR), `agent_repair_loop.js` (8-Schritte-Repair-Loop),
  Playthrough-Skripte als L4-Archiv.
- **Chains:** `mcp_chains/preflight_core.json` (headless) + `world_smoke.json` (visible).

## 4. Tool-Bilanz

| Block | Anzahl |
|---|---|
| Runtime/Input | 22 |
| Vision | 22 |
| Debug | 12 |
| UX | 10 |
| Audio/Animation/Gamepad/Network | 29 |
| Gameplay (generisch) | 5 |
| E2E + Goal + Analyzer + Playthrough | 18 |
| Autonomy-Workspace | 19 |
| Chain-Controller | 5 |
| Custom-Loader | dynamisch (`res://mcp_tools/`) |
| **Domain-Summe** | **142** |
| Host-Tools (Server) | 7 (`runtime_mcp_capabilities`, `runtime_mcp_status`, `runtime_mcp_events`, `runtime_agent_goal_set`, `runtime_agent_activity`, `runtime_visual_evidence`, `runtime_run_trace`) |
| Editor-Session zusätzlich | 19 `editor_*` |

## 5. Gefundene & geschlossene Lücken (F-Register)

| ID | Befund | Status |
|---|---|---|
| F-01 | `runtime_chain_list`/`runtime_chain_load` waren definiert, aber im Registry-Dispatcher nicht geroutet ("Unknown tool") | ✅ behoben (`mcp_tool_registry.gd`) |
| F-02 | Gameplay-Tools mit Spielfachlichkeit (Faktion/Planet/Schiff-Vokabular) | ✅ entkoppelt → generische `game_*`-Brücken (vorige Iteration) |
| F-03 | Preflight-/Start-Szenen-Pfade als Addon-Defaults | ✅ ersetzt durch Config mit Degradierung |
| F-04 | Kopplungsreste (Szenen-Labels, Audio-Worker-Pfad) im Addon-Kern | ✅ config-getrieben, Commit-Gate wacht ab jetzt |
| F-05 | OCR-Doku beschrieb entferntes Tesseract.js-Setup (`MCP_OCR_POOL`); Realität: pytesseract-Worker, serialisiert | ✅ Doku korrigiert (MCP_INDEX, AGENTS, PERSISTENCE, README) |
| F-06 | PLAYTEST_HANDOFF nannte Phantom-Tool `runtime_game_state_summary` (existiert nicht) | ✅ durch reale `game_state_summary` + Sperr-Status ersetzt |
| F-07 | Kein Bootstrap-Discovery: externe Agents mussten Addon-Code lesen, um Setup/Loops zu kennen | ✅ `runtime_mcp_capabilities` (Settings/Capabilities/Loops/Transport, in jedem Profil erlaubt) |
| F-08 | `serverInfo` hieß `gdscript-mcp-bridge` (Alter Name) | ✅ `godot-acp` 1.0.0 |
| F-09 | Atomare Verkettung war dokumentiert, aber nicht als generische Vorschrift maschinenlesbar | ✅ `loops.player_atomic_loop` im Discovery-Tool + AGENT_WORKFLOW §Bootstrap |

Offene Lücken: **G-01 Impact-Graph** (siehe Audit) und **G-02 Multi-Client-Scopes**
— beide in `ROADMAP.md` (v1.2) terminiert, nicht in v1.0 enthalten.

**Claim-Audit (September 2026):** Alle 8 README-Use-Cases wurden gegen den
Code geprüft (Tool-Existenz, Routing, Degradierung). Ergebnisse: UC1/2/3/4/6/7/8
erfüllbar, UC5 mit korrigiertem OCR-Claim (F-05); Setup-Lücken als F-06 bis
F-09 geschlossen.

## 6. Backend-Ebene (backend/ — unabhängig von Godot, eigene Zentralisierung)

| Baustein | Pfad | Zustand |
|---|---|---|
| Zentralserver | `backend/server.mjs` | ✅ Target-State (CONNECTED/DEGRADED via Ping), Command-Bus (`origin: human/system/agent`), REST + SSE, JSONL-Persistenz (`~/.godot-acp/`) |
| Agent-Proxy | `:9099` in server.mjs | ✅ Jeder `tools/call` wird geprüft: PAUSED → `-32003`, Blockliste → `-32003`, Approval-Pflicht (60 s Timeout) → Wartet auf Dashboard-Freigabe, sonst Durchleitung + Response-Routing zurück zum Agent |
| Web-Dashboard | `backend/web/` (React+Vite) | ✅ Deutsch, nontechnisch: Statuskarten, Pause/Stop/Neu-Verbinden, Ziel-Eingabe, Tool-Sperrliste (Chips), Freigabe-Box, Live-Feed, Stats |
| Terminal-Cockpit | `backend/cli/dashboard.mjs` (Ink) | ✅ Gleiche Commands, Tastatur-Steuerung (`p`/`s`/`g`/`t`/`r`/`q`); `ink` optional installierbar |
| Godot-Simulator | `backend/test/fake_godot.mjs` | ✅ MCP über TCP simuliert — Backend-Tests ohne Godot-Editor |
| Smoke-Test | `backend/test/smoke_test.mjs` | ✅ Beweist Durchleitung, Pause-Ablehnung, Blockliste (gezielt + SELECT-Calls laufen weiter), Approval-Flow, Ziel-Setzung (7/7 PASS) |
| Discovery | `/api/tools` (REST) | ✅ `tools/list`-Weiterleitung an Godot für die Blocklisten-Auswahl |

**Architektur-Satz:** Der Agent verbindet sich NUR mit dem Proxy (`:9099`), nie
mehr direkt mit dem Spiel. Einfluss ohne Agent-Chat = Systemzustand ändern
(Pause/Blockliste/Ziel/Freigabe), der als Protokollantwort beim Agenten ankommt.
Godot muss von alledem nichts wissen — das ist der Punkt.

## 7. Persistenz-Bilanz (Kurzform, verbindlich: PERSISTENCE.md)

`res://` (git): Addon-Code inkl. `.uid`-Sidecars, Chain-Manifeste, `.mcp.json`-Vorlage ·
`user://` (persist): Traces, Workspaces, Playthrough-Archiv, Profile/Config ·
`user://` (ephemer): Context-Artefakte (TTL 45 s, 6 Records, 32 MB) ·
Backend-Host (persist): `~/.godot-acp/{events,commands}.jsonl` — Command-Bus-Historie,
unabhängig von Godot ·
Cache: `node_modules/.cache/tesseract.js/` (regenerierbar), `backend/web/node_modules/` (Build).

## 8. Prüf-Auftrag für die Zukunft

1. Nach jeder Tool-Änderung: Zählung in §4 aktualisieren (`agent.md` §3 Absatz 5).
2. Nach jedem neuen Modul: Zeile in §2 ergänzen, sonst ist das Modul offiziell
   nicht existent. Das ist keine Büroeinladung, das ist Bilanzpflicht.
3. Commit-Gate (`testing/commit_gate.sh`) vor jedem Commit; Verstöße wandern
   ins Register in `MCP_ANOMALIES.md`.

---

## Anhang A — Zähl-Methode

Domain-Tools = Summe der `get_tool_defs()`-Einträge je Modul
(gemessen per `grep -cE '^\s*(_make|_make_tool)\("'` bzw. `"name": "runtime_…"`-Zählung
in den Controller-Dateien), plus 7 Server-Host-Tools. Die Registry-Reflection zur
Laufzeit bleibt die autoriative Quelle; diese Datei ist die dokumentierte
Momentaufnahme (Stand: Commit `d4a71e5`).
