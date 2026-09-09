extends RefCounted
class_name McpAddonConfig

## McpAddonConfig — Zentrale Konfigurations-Schicht des Addons (ENTKOPPELUNG).
##
## EIN Ort, der ALLE projektseitigen Einstellungen unter `application/mcp/*`
## liest. Kein Modul im Addon liest ProjectSettings direkt und kein Modul
## trägt projektspezifische Defaults (Szenenpfade, Scriptpfade, Node-Namen
## eines konkreten Spiels). Fehlt eine Einstellung, degradiert das zugehörige
## Feature sauber (leere/funktionserhaltende Antwort statt Absturz) — genau
## wie in MCP_INDEX.md ("Projektagnostische Integration") beschrieben.
##
## Verbindlich:
## - Addon-intern werden Pfade nie hartkodiert; Host-Projekte setzen eigene
##   Werte in ihrer project.godot (siehe ENTKOPPLUNG.md).
## - Neue Einstellung? HIER ergänzen (Getter) + Eintrag in ENTKOPPLUNG.md.

const PREFIX := "application/mcp/"

# ─── Roher Zugriff ────────────────────────────────────────────────

static func get_setting(key: String, fallback: String = "") -> String:
	return str(ProjectSettings.get_setting(PREFIX + key, fallback))


static func has_setting(key: String) -> bool:
	var value := str(ProjectSettings.get_setting(PREFIX + key, ""))
	return value.strip_edges() != ""


# ─── Optional State-/Log-Brücken (Spiel-Projektseite) ─────────────

## Pfad zum GameState-Node (absolut, z. B. "/root/GameState"). Leer = Auto-
## Erkennung über die dokumentierte Konvention (Autoload "GameState").
static func game_state_node() -> String:
	return get_setting("game_state_node")


## Pfad zum EventLog-Node. Leer = Auto-Erkennung (Autoload "EventLog").
static func event_log_node() -> String:
	return get_setting("event_log_node")


## Pfad zum optionalen Projekt-Adapter-Node. Leer = "/root/McpProjectAdapter".
static func project_adapter_node() -> String:
	return get_setting("project_adapter_node")


## Skript-Pfad für die statische GameState-API-Analyse. Leer = Auto-Scan.
static func game_state_script() -> String:
	return get_setting("game_state_script")


# ─── Optional: Headless-Preflight (Chain-Schritt) ─────────────────

## Preflight-Skript des Projekts (z. B. "res://preflight/preflight.gd").
## Leer = der `preflight_constraint`-Chain-Schritt antwortet BLOCKED
## (konfiguriert das Projekt kein Preflight, gibt es nichts zu beweisen).
static func preflight_script() -> String:
	return get_setting("preflight_script")


# ─── Optional: Sichtbarer Playthrough/E2E ────────────────────────

## Start-Szene des sichtbaren Playthrough-Driver (z. B. das Hauptmenü des
## Projekts). Leer = game-abhängige E2E-Szenarien melden SKIPPED.
static func main_menu_scene() -> String:
	return get_setting("main_menu_scene")


## UI-Label der "Spiel starten"-Aktion im Hauptmenü (für E2E-Szenarien).
## Leer = Szenarien, die darauf klicken, melden SKIPPED.
static func e2e_start_label() -> String:
	return get_setting("e2e_start_label")


## Erwarteter Szenen-Name nach dem Spielstart (z. B. "game_view").
## Leer = Szenarien überspringen die Welt-Verifikation.
static func e2e_world_scene() -> String:
	return get_setting("e2e_world_scene")


## UI-Label der Speichern-Aktion im Pausenmenü (E2E). Leer = Sub-Prüfung Skip.
static func e2e_save_label() -> String:
	return get_setting("e2e_save_label")


## UI-Label der Zurück-zum-Menü-Aktion im Pausenmenü (E2E). Leer = Skip.
static func e2e_menu_label() -> String:
	return get_setting("e2e_menu_label")


# ─── Optional: Gameplay-Domain-Bridge (game_*-Tools) ─────────────

## Node mit Planet-/Entity-Objekten (früher hartkodiert "PlanetField").
## Alternativ kann eine Node-Gruppe genutzt werden (planets_group).
## Beide leer = game_planet_info/game_upgrade_list melden "not configured".
static func planets_node() -> String:
	return get_setting("planets_node")


## Node-Gruppe, in der Planet-/Entity-Objekte registriert sind (z. B.
## "planets"). Leer = nur planets_node bzw. die get_id/get_faction-Konvention
## im konfigurierten Node verwenden.
static func planets_group() -> String:
	return get_setting("planets_group")


## Node mit Dispatch-/Worker-Verwaltung (früher hartkodiert "WorkerManager").
## Leer = game_dispatch_info meldet "not configured".
static func worker_manager_node() -> String:
	return get_setting("worker_manager_node")


## Default-Fraktion/-Spieler für kompakten State-Zugriff. Leer = erster
## gefundener Key bzw. explizite Angabe pro Call; nie ein Spielname als Code.
static func default_faction() -> String:
	return get_setting("default_faction")


## Kommagetrennte Ressourcen-IDs des Projekts (z. B. "energy,material").
## Leer = nur die Methoden-Erkennung (get_faction_resource/credits) nutzen.
static func resource_ids() -> PackedStringArray:
	var raw := get_setting("resource_ids")
	var result := PackedStringArray()
	for part in raw.split(",", false):
		var id := part.strip_edges()
		if id != "":
			result.append(id)
	return result


# ─── Optional: Externe Analyse-Worker ────────────────────────────

## Pfad zum Audio-Analyse-Worker des Projekts (Python). Leer = die
## audio_analyze/slice/evidence/compare-Tools melden "not configured".
static func audio_analyzer_script() -> String:
	return get_setting("audio_analyzer_script")


# ─── Addon-intern (NICHT projektspezifisch) ──────────────────────

## Verzeichnis der versionierten Chain-Manifeste. Default liegt IM Addon —
## das ist Addon-Eigentum, kein Projektpfad. Überschreibbar für Projekte,
## die eigene Manifeste pflegen wollen.
static func chain_dir() -> String:
	return get_setting("chain_dir", "res://addons/mcp/mcp_chains")


## Standardisierte "nicht konfiguriert"-Antwort für degradierte Tools.
static func not_configured(capability: String, setting: String) -> Dictionary:
	return {
		"error": "%s not configured — set application/mcp/%s in project.godot" % [capability, setting],
		"available": false,
		"capability": capability,
		"setting": PREFIX + setting,
	}


## Löst einen absoluten Node-Pfad im aktuellen SceneTree auf; nil wenn leer.
static func resolve_configured_node(root: Node, path: String) -> Node:
	if root == null or path.strip_edges() == "" or not path.begins_with("/"):
		return null
	return root.get_node_or_null(NodePath(path.strip_edges()))
