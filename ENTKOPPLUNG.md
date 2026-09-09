# ENTKOPPLUNG — Addon ↔ Host-Projekt (verbindlicher Vertrag)

**Stand:** 2026-09-09 · **Gültigkeit:** Pflicht-Lese für jede Änderung am MCP-Addon.

Dieses Dokument ist die autoritative Referenz dafür, wie das MCP-Addon vom
Host-Projekt (dem Spiel) getrennt bleibt — **eigene Doku, eigene Hierarchie,
eigene Zentralisierung**. Das Addon ist ein eigenständiges Godot-4.x-Addon
(`addons/mcp/`) und kennt **kein konkretes Spiel**: keine Szenenpfade, keine
Node-Namen, keine Tool-Defaults, die nur in einem einzigen Projekt existieren.

---

## 1. Die drei Trennungsregeln

1. **Kein Spielvokabular im Addon-Kern.** Runtime-/Registry-/Protocol-/Host-
   Code enthält keine Bezeichner eines konkreten Spiels (Fraktionen, Planeten,
   Menü-Labels, Szenennamen). Wo das Addon Spiel-Zustand liest, geschieht das
   ausschließlich über die generische `game_*`-Brücke und Duck-Typing-Konventionen
   (`get_id()`/`get_faction()`/`snapshot()`).
2. **Kein Default auf einen konkreten Projektpfad.** Alle `application/mcp/*`
   -Settings werden mit **leeren Werten** registriert. Fehlt eine Konfiguration,
   degradiert das Feature sauber (`SKIP` im E2E, `BLOCKED`/`not configured`
   bei Chain- und Audio-Schritten) — statt stillschweigend ein fremdes
   Projekt anzunehmen.
3. **Zentrale Konfig-Lese-Schicht.** Genau EIN Modul liest `application/mcp/*`:
   `runtime/core/mcp_addon_config.gd` (`McpAddonConfig`). Kein anderes Modul
   ruft `ProjectSettings.get_setting("application/mcp/...")` direkt auf.

---

## 2. Eigene Hierarchie (Addon = eigenes Paket)

```
addons/mcp/
├── plugin.cfg                      Addon-Manifest (eigene Identität)
├── agent.md                        Commit-Governance & Arbeitsvertrag (Ton, Gates)
├── ENTKOPPLUNG.md                  Diese Datei (Vertrag)
├── AGENTS.md                       MCP-Test-Doktrin (Pflicht-Lese)
├── MCP_INDEX.md                    Architektur & Tool-Liste
├── PERSISTENCE.md                  Persistenz-Landkarte
├── AGENT_WORKFLOW.md               Agent-Workflow
├── PLAYTEST_HANDOFF.md             Spieler-Vertrag + Atom-Registry
├── MCP_ANOMALIES.md                GAME vs MCP-Mismatch-Referenz
├── mcp_chains/                     Versionierte Chain-Manifeste (Addon-Eigentum)
├── client/                         Externe Transport-/Analyse-Clients
├── editor/                         Plugin + QA-Live-Dock
├── runtime/                        MCP-Server-Kern (kein Spielcode)
│   ├── core/      registry, addon-config (ZENTRALISIERUNG), custom loader, adapter
│   ├── host/      runtime autoload + server
│   ├── protocol/  JSON-RPC
│   ├── lifecycle/ Server-Zustand
│   ├── context/   Artefakte, Run-Trace, Archiv
│   ├── autonomy/  Workspace, Contract-Gate, Chain-Controller, Journal
│   └── tools/     runtime/vision/debug/ux/systems/e2e/gameplay
└── testing/                        Test-Runner, Szenarien, E2E-Driver, portable Smoke, commit_gate
```

Regeln:
- Alles, was das Addon braucht, lebt **ausschließlich** unter `addons/mcp/`.
  Kein Addon-Code referenziert `res://scripts/`, `res://scenes/`, `res://tools/`
  oder andere Host-Pfade hart.
- Einzige erwarte Struktur-Annahme: der Well-known-Pfad `addons/mcp/` selbst
  (Godot-Addon-Konvention; siehe offizielle Plugin-Doku).
- Host-Projekte koppeln sich über `project.godot` an das Addon — nie umgekehrt.

---

## 3. Eigene Zentralisierung (`McpAddonConfig`)

**Eine Klasse, ein Pfad:** `res://addons/mcp/runtime/core/mcp_addon_config.gd`.

| Getter | Setting | Leer ⇒ Verhalten |
|---|---|---|
| `game_state_node()` | `game_state_node` | Auto-Erkennung über Konvention (Autoload/Node `GameState`), sonst degradiert |
| `event_log_node()` | `event_log_node` | Auto-Erkennung (`EventLog`), sonst nur Engine-Logs |
| `project_adapter_node()` | `project_adapter_node` | Default `/root/McpProjectAdapter` (Addon-eigenes Autoload) |
| `game_state_script()` | `game_state_script` | Auto-Scan im Code-Analyzer |
| `preflight_script()` | `preflight_script` | `preflight_constraint`-Chain-Schritt antwortet `not configured` (BLOCKED) |
| `main_menu_scene()` | `main_menu_scene` | Playthrough-Driver bricht mit Anleitung ab |
| `e2e_start_label()` | `e2e_start_label` | game-abhängige E2E-Szenarien melden `SKIP` |
| `e2e_world_scene()` | `e2e_world_scene` | Welt-Verifikation wird übersprungen |
| `e2e_save_label()` / `e2e_menu_label()` | `e2e_save_label` / `e2e_menu_label` | Sub-Prüfungen im Pausen-Szenario entfallen |
| `planets_node()` / `planets_group()` | `planets_node` / `planets_group` | `game_entity_query/info` antworten `not configured` |
| `worker_manager_node()` | `worker_manager_node` | (Reserve für Dispatch-Brücken) |
| `default_faction()` | `default_faction` | Calls müssen den Key explizit angeben |
| `resource_ids()` | `resource_ids` | Ressourcen-Erkennung nur über Methoden-Konvention |
| `audio_analyzer_script()` | `audio_analyzer_script` | Audio-Analyse-Tools antworten `not configured` |
| `chain_dir()` | `chain_dir` | Addon-eigener Default `res://addons/mcp/mcp_chains` |

**Neue Einstellung anlegen:** Getter in `McpAddonConfig` ergänzen, leeren
Eintrag in `MCP_SETTINGS` des Plugins aufnehmen, hier eintragen. Fertig.

---

## 4. Konventionen statt Kopplung (Duck-Typing-Vertrag)

Das Addon erkennt Host-Fähigkeiten über Methoden-Namen, nicht über Typen:

| Konvention | Genutzt von | Bedeutung |
|---|---|---|
| `snapshot()` / `snapshot_run()` | `game_state_snapshot` | Zustands-Snapshot erzeugen |
| `restore(data)` / `restore_run(data)` | `game_state_restore` | Zustand wiederherstellen |
| `get_id()` + `get_faction()` | `game_entity_query/info` | Entity-Objekte im Baum/Gruppe |
| `get_worker_count()`, `get_build_slot_count()` | `game_entity_info` | optionale Zusatzfelder |

Ein Host-Projekt implementiert, was es anbieten will. Fehlt alles, liefern die
`game_*`-Tools `{"available": false, ...}` — der Agent sieht sofort, was
existiert, ohne zu raten.

---

## 5. Ports, Transport, Registrierung (projektneutral)

- Runtime-MCP: `127.0.0.1:9090` (Default, konfigurierbar) — im **Spiel**-Prozess.
- Editor-Dock startet das Spiel als separaten Prozess (`MCP_EMBEDDED`-Env).
- Externe Clients: `client/mcp_stdio_bridge.py` (zero-dependency, stdlib-only)
  über einen cwd-immunen Wrapper mit **absolutem** Pfad in der Client-Config.
- `.mcp.json` ist eine **Vorlage**: Host-Projekte tragen ihren eigenen
  absoluten Wrapper-Pfad ein (`<ABSOLUTE_PROJECT_PATH>/mcp_bridge.cmd`).

---

## 6. Verstoß-Kriterien (was NICHT in das Addon darf)

- Ein Pfad wie `res://scenes/<spiel>/...` oder `res://scripts/<spiel>.gd` im
  Addon-Code oder in Addon-Manifesten (`.tres`-Szenarien, Chain-Manifeste).
- Ein UI-Label-Default (`"Neues Spiel"`, `"SPEICHERN"`, …) in Szenarien.
- Ein Node-Name-Default (`PlanetField`, `WorkerManager`, …) außerhalb der
  dokumentierten Konventions-Erkennung (`GameState`/`EventLog`-Autoload-Fallback).
- Ein `ProjectSettings.get_setting("application/mcp/...")`-Aufruf außerhalb
  von `McpAddonConfig` (Ausnahme: das Plugin schreibt die Settings einmalig).
- Session-Berichte (Playtest-Reports, UX-Audits) im Addon-Doku-Kern — sie
  gehören in `client/playthroughs/` und tragen den Session-Kontext als
  Archiv-Stempel, nicht als Addon-Doktrin.

---

## 7. Migration Alt → Neu (für Bestands-Projekte)

| Alt (hartkodiert) | Neu (konfigurierbar) |
|---|---|
| `res://scripts/preflight.gd` als Const | `application/mcp/preflight_script` |
| `res://scenes/main_menu/main_menu.tscn` als Const | `application/mcp/main_menu_scene` |
| `"Neues Spiel"` / `"SPEICHERN"` / `"HAUPTMENÜ"` in E2E | `application/mcp/e2e_start_label` / `e2e_save_label` / `e2e_menu_label` |
| `game_view` / `main_menu` als Szenen-Namen | `application/mcp/e2e_world_scene` (+ strukturelle `menu`/`world`-Heuristik) |
| `PlanetField`-Node-Suche | `application/mcp/planets_node` oder `planets_group` |
| `WorkerManager`-Node-Suche | `application/mcp/worker_manager_node` |
| `res://scripts/tools/audio_analyzer.py` | `application/mcp/audio_analyzer_script` |
| Ressourcen-IDs `energy,biomass,...` | `application/mcp/resource_ids` |
| `faction "a"`-Default | `application/mcp/default_faction` (oder Call-Parameter) |
| Tools `game_faction_query`, `game_planet_info`, `game_ship_list`, `game_research_status`, `game_upgrade_list`, `game_dispatch_info`, `game_vault_snapshot`, `game_resources_all` | generisch: `game_entity_query`, `game_entity_info`, `game_state_summary` (+ projektseitige `custom_*`-Tools in `res://mcp_tools/` für Spielfachliches) |
