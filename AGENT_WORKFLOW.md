# MCP Agent Workflow — Autonome Playtesting-Umgebung (GODOT ACP)

**Stand:** 2026-09-09
**Ziel:** Unkomplizierte, umfassende Autonomie für Agents, die mit jeder Benutzung schneller und präziser wird — unabhängig vom konkreten Godot-Projekt. **Ohne Code-Lektüre:** Alles Nötige liefert `runtime_mcp_capabilities` (Bootstrap-Discovery: Settings, Capabilities, vorgeschriebene Loops, Transport).

> **LIVE-SPIELERREGEL (ATOMARE VERKETTUNG, generisch und serverseitig erzwungen):**
> Sichtbares Gameplay wird ausschließlich als einzelne MCP-Atome ausgeführt.
> **Ein Atom = genau ein MCP-Tool-Call.** Der Agent liest nach jedem Call die
> Live-Oberfläche und entscheidet den nächsten Zug **erst danach**. Gilt für
> JEDES Spiel — die Kette ist nicht projektspezifisch, sondern strukturell:
>
> ```
> Scan → Move → [Scan] → Click/Key/Scroll → Wait → Scan   (dann neu entscheiden)
> ```
>
> Verboten im player-Profil (serverseitig erzwungen, Verstöße werden gezählt):
> direkte GameState-Mutation, `runtime_goal_sequence`, `runtime_goal_play`,
> `runtime_chain_run`, `runtime_ux_click` (Find+Klick in einem Tool),
> Freeze/Step, `runtime_e2e_run`, Autonomy-Writes — und jeder Runner, der
> mehrere Atome bündelt oder vorausplant. Der vollständige Vertrag steht in
> `PLAYTEST_HANDOFF.md`.

## Bootstrap für externe Agents (kein Code-Research nötig)

1. Verbinden (stdio-Bridge oder TCP 9090), `initialize` → `initialized`.
2. **`runtime_mcp_capabilities`** aufrufen. Die Antwort enthält:
   - `settings`: welche `application/mcp/*`-Werte das Projekt gesetzt hat
   - `degradations`: welche Features deshalb SKIP/BLOCKED/not-configured melden
   - `capabilities`: Runtime-/Editor-Fähigkeiten, Profile (player/qa/dev)
   - `loops`: die VORSCHRIFT für Spieler- und Repair-Loop (atomare Kette)
   - `transport`: Ports, Bridges, Ressourcen-URIs
3. Danach arbeiten — ohne eine einzige Addon-Datei gelesen zu haben. Diese
   Doku ist für Menschen und Reviewer; die Maschinen-Wahrheit liefert das Tool.

## Modi strikt trennen

- **Live-Spieler:** atomare Kette (oben). Jeder Schritt ist ein eigener MCP-Call; für viele Schritte darf der Transport persistent bleiben (`atomic_session.js`), aber eine Zeile bleibt genau ein Call.
- **Autonomie-Repair:** Workspace, Write-Gate, Export und Rollback; kein Gameplay-Nachweis.
- **Vertragstest:** Headless oder sichtbare Test-Suite; kein Spieler-PASS. Chains zuerst validieren, dann in begrenzten Segmenten ausführen.
- **Editor-Tooling:** Editor-Port/Dock, Undo/Redo und Editor-Schreibrechte; kein Runtime-Gameplay-PASS.


---

## Installation & Selbst-Registrierung (projektagnostisch)

Das Add-on ist projektagnostisch: Es koppelt keine Spiel-Logik ein und richtet
sich beim Aktivieren **automatisch im aktuellen Godot-Projekt** ein — kein
manuelles Einfügen in `project.godot` nötig. Der vollständige Addon↔Host-Vertrag
steht in `ENTKOPPLUNG.md`.

### Wie aktivieren

1. Ordner unter `res://addons/mcp/` ablegen (Kopie / submodule /
   packaged Release).
2. **Project Settings → Plugins**: `GODOT ACP` aktivieren.
3. Beim nächsten Editor-Boot registriert das Plugin idempotent (nur fehlende):
   - Autoloads `McpRuntime` + `McpProjectAdapter` (inert ohne `--mcp`-Flag),
   - leere `application/mcp/*`-Settings (vollständige Liste mit
     Degradierungs-Verhalten: `runtime_mcp_capabilities` → `settings`, oder
     `ENTKOPPLUNG.md` §3).

### `application/mcp/*`-Settings (Defaults vs. projektseitig)

| Setting | Default | Zweck |
|---|---|---|
| `preflight_script` | leer (⇒ BLOCKED) | Pfad des Preflight-Tests für den `preflight_constraint`-Chain-Schritt |
| `main_menu_scene` | leer (⇒ Driver-Abbruch mit Anleitung) | Start-Szene des sichtbaren Playthrough-Driver |
| `e2e_start_label` / `e2e_world_scene` / `e2e_save_label` / `e2e_menu_label` | leer (⇒ SKIP) | UI-Labels/Szenen-Name für game-abhängige E2E-Szenarien |
| `game_state_node` | leer (= auto) | Pfad zum spielspezifischen GameState-Node, falls vorhanden |
| `event_log_node` | leer (= auto) | Pfad zum EventLog-Node, falls vorhanden |
| `project_adapter_node` | leer (= auto, `/root/McpProjectAdapter`) | optionaler Projekt-Adapter |
| `game_state_script` | leer (= auto/Scan) | Skript-Pfad für GameState-API-Analyse |
| `planets_node` / `planets_group` | leer (⇒ not configured) | Entity-Brücke für `game_entity_*` |
| `worker_manager_node` | leer | Reserve für Dispatch-/Worker-Brücken |
| `default_faction` / `resource_ids` | leer | Default-Key bzw. Ressourcen-IDs des Projekts |
| `audio_analyzer_script` | leer (⇒ not configured) | Projekt-eigener Audio-Analyse-Worker |
| `chain_dir` | `res://addons/mcp/mcp_chains` | Chain-Manifest-Katalog (Addon-Eigentum, überschreibbar) |

Alle Werte gehören dem **Host-Projekt**; das Addon trägt nie Pfade oder Namen
eines konkreten Spiels. Lesen tut ausschließlich `McpAddonConfig`
(`runtime/core/mcp_addon_config.gd`) — Details: `ENTKOPPLUNG.md` §3.

### In ein beliebiges Projekt integrieren

1. Plugin aktivieren (siehe oben) — Autoloads/Settings kommen automatisch.
2. Optional `application/mcp/preflight_script` + `main_menu_scene` auf eigene
   Pfade setzen (oder weglassen → generische Tools, die ohne Spiel allein
   funktionieren).
3. Optional `mcp/game_state_node`/`event_log_node`/`game_state_script` und die
   Entity-Brücken für State-/Log-/Entity-Zugriff setzen; fehlen sie, degradiert
   MCP clean (leere Capabilities, `not configured`-Antworten) statt zu crashen.
4. Sichtbaren Runtime starten: `$GODOT_BIN --path . -- --mcp --mcp-port 9090`.

---

## Kernprinzip

Jeder Agent speichert seine funktionierenden Scripts atomar, kategorisiert sie und hinterlässt Wissen im `index.jsonl`-Archiv. Der nächste Agent liest dieses Archiv und nutzt vorhandene Lösungen statt null-deriviert zu analysieren.

---

## Workflow (6 Schritte)

### Schritt 1: Archiv lesen (5 Sekunden)
```bash
# Vorhandene Scripts laden:
# → index.jsonl in user://mcp_playthrough/scripts/
# → Kategorien: runtime, gameplay, e2e, ux, fix
# → Jeder Eintrag: name, category, verdict, session, path, tested_with, description
```
**Frage an sich selbst:** "Gibt es ein Script das mein Problem bereits löst?"

### Schritt 2: Projekt analysieren (30 Sekunden)
```
runtime_analyze_project   → Szenen, Autoloads und verfügbare MCP-/State-APIs
runtime_analyze_input     → _input/_unhandled_input Treffer
runtime_analyze_game_state → konfigurierte oder erkannte State-Skripte/öffentliche Methoden
```
**Frage:** "Welche Lücken gibt es die mein Archiv nicht abdeckt?"

### Schritt 3: Scripts schreiben oder fixen (variabel)
- **Neues Script:** In `user://mcp_playthrough/scripts/<name>.gd` schreiben
- **Bestehendes Script fixen:** Kopie anlegen, fixen, altes Archivieren
- **Atomar:** Jedes Live-Action-Script darf genau einen MCP-Tool-Call ausführen. Transport, Zielsuche, Hover, Klick, Wait, Scan, Screenshot, State- und Log-Lesen bleiben getrennte Scripts.
- **Kein Composer:** Ein Script, das mehrere Live-Aktionen plant oder ausführt, ist kein Live-Spieler-Script und darf nicht als Playthrough-Erfolg archiviert werden.

### Schritt 4: Testen (30-120 Sekunden)
```
runtime_e2e_run → scenario_id: "freeze_step" oder "analyze_and_goal"
runtime_goal_play → goal: "GameState.run_id() != &''"
```
**Verdict:** PASS oder FAIL + Anomalien

### Schritt 5: Archivieren (5 Sekunden)
```json
{
  "name": "camera_move_to",
  "category": "runtime",
  "verdict": "PASS",
  "session": "2026-08-24",
  "path": "user://mcp_playthrough/scripts/camera_move_to.gd",
  "tested_with": ["freeze_step"],
  "description": "Kamera per Tween zu x,y bewegen"
}
```

### Schritt 6: Übergabe (automatisch)
Der nächste Agent beginnt bei Schritt 1 und liest den neuen Eintrag.

---

## Kategorien

| Kategorie | Inhalt | Beispiele |
|-----------|--------|-----------|
| `runtime` | Grundwerkzeuge | camera_move_to, freeze_step |
| `gameplay` | Spiel-Abfragen | faction_query_recursive, ship_list |
| `e2e` | Test-Logik | goal_play_enhanced, scenario_runner |
| `ux` | UI-Interaktion | scan_controls, find_button |
| `fix` | Bugfixes | faction_query_fix, camera_fix |

---

## Script-Format

Jedes Script in `user://mcp_playthrough/scripts/` muss:
1. `extends RefCounted` sein
2. `static func get_tool_defs() -> Array` liefern
3. `func dispatch_tool(tool_name, args) -> Variant` implementieren
4. Optional: `func dispatch_async(tool_name, args) -> Variant` für async Tools

---

## Archiv-Struktur

```
user://mcp_playthrough/
├── playthrough.jsonl          # Aktionen (existiert)
├── frames/                    # Screenshots (existiert)
├── snapshots/                 # GameState-Presets (existiert)
├── scripts/                   # NEU: Agent-Script-Archive
│   ├── index.jsonl            # Kategorie, Name, Zustand pro Script
│   ├── camera_move_to.gd      # Funktionierendes Modul
│   ├── faction_query_fix.gd   # Bugfix-Modul
│   └── goal_play_enhanced.gd  # Verbesserter Goal-Player
```

---

## Metriken

| Metrik | Bedeutung |
|--------|-----------|
| `index.jsonl` Einträge | Gesamtzahl archivierter Scripts |
| Scripts pro Kategorie | Verteilung der Lösungen |
| Durchschnittliche Test-Dauer | Geschwindigkeit pro Session |
| Agent-Skript-Verwendungsrate | Wie oft vorhandene Scripts genutzt werden |

---

## Fehlerbehandlung

| Situation | Aktion |
|-----------|--------|
| Script existiert bereits mit gleichem Namen | Neue Version als `<name>_v2.gd` oder UPDATE in index.jsonl |
| Test schlägt fehl | Script nicht archivieren, Fehler in index.jsonl dokumentieren |
| Archiv korrupt | JSONL ist append-only; letzte Zeile kann ignoriert werden |
| Kein MapCamera vorhanden | `runtime_camera_move_to` gibt `{"error": "MapCamera not found"}` zurück |

---

## Beispiel-Session

```
Agent 1 (Session 2026-08-24):
  1. Liest index.jsonl → 0 Einträge
  2. Analysiert Projekt → findet: camera_move_to fehlt
  3. Schreibt camera_move_to.gd
  4. Testet mit freeze_step → PASS
  5. Archiviert: index.jsonl + scripts/camera_move_to.gd

Agent 2 (Session 2026-08-25):
  1. Liest index.jsonl → 1 Eintrag: camera_move_to (PASS)
  2. Nutzt camera_move_to direkt → spart 10 Minuten Analyse
  3. Findet: faction_query braucht Fix
  4. Schreibt faction_query_fix.gd
  5. Testet mit new_game_to_world → PASS
  6. Archiviert: index.jsonl + scripts/faction_query_fix.gd

Agent 3 (Session 2026-08-26):
  1. Liest index.jsonl → 2 Einträge: camera_move_to + faction_query_fix
  2. Nutzt beide direkt → spart 20 Minuten Analyse
  3. Findet: goal_play braucht Retry-Logik
  4. Schreibt goal_play_enhanced.gd
  5. Testet mit analyze_and_goal → PASS
  6. Archiviert: index.jsonl + scripts/goal_play_enhanced.gd
```

---

## 🔁 Der vollautonome 8-Schritte Repair- & Feature-Loop (`agent_repair_loop.js`)

> **Client-Rollen:** Externer Standard-Transport ist die Python-Bridge
> (`mcp_stdio_bridge.py`); der Repair-Loop und die atomaren Playthrough-Helfer
> sind Node/JS (`mcp_lib.js` + Atomic-Tools). Bild-/OCR-Analyse läuft im
> Python-Vision-Worker.

Für geschlossene, vollautomatische Reparatur- und Feature-Entwicklungsläufe:

```
[1. Handshake]        initialize → protocol negotiated
       ↓
[2. Baseline]         godot://gameState/summary & godot://scene/current
       ↓
[3. Sandbox Start]    runtime_autonomy_workspace_begin
       ↓
[4. Edit & Patch]     runtime_autonomy_workspace_import + runtime_autonomy_patch
       ↓
[5. Gated Export]     runtime_autonomy_export (apply=true) + resource_barrier Settle
       ↓
[6. Headless Chain]   runtime_chain_run (Preflight / Contract Assertions)
       ↓
[7. Visible Verification] einzelne MCP-Atome, jeweils nach Live-Beobachtung entschieden
       ↓
[8. Verdict & Close]  PASS: sichtbare Evidenz + getrennte Game-/MCP-Findings
                      FAIL: runtime_autonomy_rollback_all nur für Workspace-Mutationen, nie als Gameplay-Ersatz
```

Ausführung via CLI:
```bash
node addons/mcp/client/agent_repair_loop.js \
  --file "res://scripts/..." \
  --old "old_code" \
  --new "new_code" \
  --goal "Feature oder Bugfix Beschreibung"
# optional: --chain chain.json (runtime_chain_run-Schritte) und
#           --sequence sequence.json (runtime_goal_sequence-Aktionen)
```

Der Repair-Loop ist ein Code-/Workspace-Modus. Sein optionales `goal_sequence` darf nicht für sichtbares Spieler-Playtesting verwendet werden; Live-Gameplay folgt ausschließlich `PLAYTEST_HANDOFF.md`.

**Evidence:** Jeder Workspace-Run erzeugt automatisch einen einheitlichen
Run-Trace (`user://mcp_traces/<run_id>.json`, Abruf über `runtime_run_trace
status|snapshot|list|read`) — Tool-Calls, GameState-Fingerprints, Events und
Verdict an EINER Trace-ID.

## 🗂 Versionierte Chain-Manifeste (`res://addons/mcp/mcp_chains/`)

Wiederholbare Testketten als JSON (F5). Katalog ansehen, laden, ausführen:
```bash
# Katalog + Validierung + Lauf (Profile qa|dev, sichtbares Spiel):
runtime_chain_list
runtime_chain_load  {"chain_id": "world_smoke"}
runtime_chain_run   {"chain_id": "preflight_core"}   # headless Preflight-Kern
runtime_chain_run   {"chain_id": "world_smoke"}      # visible Smoke am laufenden Spiel
```
Manifeste sind versioniert (git) und werden vor Ausführung validiert
(`runtime_chain_validate`); Assertions binden das Tool-Result als `result`
und dürfen zusätzlich GameState lesen (`has_active_run()` etc.).
