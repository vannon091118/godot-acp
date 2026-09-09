extends RefCounted
class_name McpGameplayTools

## McpGameplayTools — Gameplay domain bridge for MCP agents (PROJEKTAGNOSTISCH).
##
## ENTKOPPELT: Dieses Modul kennt KEIN konkretes Spiel. Es kennt nur zwei
## Dinge: (1) die Konvention, dass ein Projekt einen State-Node anbieten kann
## (`application/mcp/game_state_node`, sonst Autoload/Node "GameState") und
## (2) die konfigurierbaren Brücken-Nodes/Gruppen aus `McpAddonConfig`.
## Alle Spielbegriffe (Fraktionen, Planeten, Forschung, Schiffe) sind KEINE
## hartkodierten Zugriffe mehr — die ersten drei Tools sind generische
## Duck-Typing-Brücken; alles Weitere ist eine optionale, konfigurierbare
## Projekt-Bridge. Fehlt die Konfiguration, antworten die Tools standardisiert
## "not configured" (siehe McpAddonConfig.not_configured).

const CONFIG_SCRIPT := "res://addons/mcp/runtime/core/mcp_addon_config.gd"


# ─── Tool Definitions ───────────────────────────────────────────

static func get_tool_defs() -> Array:
	return [
		_make("game_state_snapshot", "Capture a snapshot of the configured GameState node (calls its snapshot()/snapshot_run() method if present)", {}),
		_make("game_state_restore", "Restore a previously captured snapshot on the configured GameState node", {"snapshot": {"type": "object"}}, ["snapshot"]),
		_make("game_state_summary", "Compact one-shot state overview of the configured GameState node: declared properties + registered groups. Prefer over multiple individual calls.", {}),
		_make("game_entity_query", "Query entities in the configured planets node/group that expose get_id()/get_faction(); optionally filter by id", {"entity_id": {"type": "string", "default": ""}}),
		_make("game_entity_info", "Detailed info about one entity (id, faction, registered properties)", {"entity_id": {"type": "string"}}, ["entity_id"]),
	]


# ─── Dispatch ───────────────────────────────────────────────────

func dispatch_tool(tool_name: String, args: Dictionary) -> Variant:
	match tool_name:
		"game_state_snapshot": return _state_snapshot()
		"game_state_restore": return _state_restore(args.get("snapshot"))
		"game_state_summary": return _state_summary()
		"game_entity_query": return _entity_query(str(args.get("entity_id", "")))
		"game_entity_info": return _entity_info(str(args.get("entity_id", "")))
		_: return {"error": "Unknown gameplay tool: " + tool_name}


# ─── GameState-Brücke (Konvention, kein Spielname) ──────────────

func _get_gs() -> Node:
	var root := _get_root()
	if root == null:
		return null
	# 1. Explizit konfigurierter Node-Pfad gewinnt immer.
	var configured := McpAddonConfig.resolve_configured_node(root, McpAddonConfig.game_state_node())
	if configured != null:
		return configured
	# 2. Dokumentierte Konvention: Autoload/Node "GameState" (best-effort,
	#    projektunabhängig — ein Spiel ohne GameState nutzt diese Brücke nicht).
	var direct := root.get_node_or_null("/root/GameState")
	if direct != null:
		return direct
	return root.find_child("GameState", true, false)


func _get_root() -> Window:
	var ml: Object = Engine.get_main_loop()
	if ml is SceneTree:
		return (ml as SceneTree).root
	return null


func _state_snapshot() -> Dictionary:
	var gs := _get_gs()
	if gs == null:
		return McpAddonConfig.not_configured("game_state", "game_state_node")
	if gs.has_method("snapshot_run"):
		var snapshot: Variant = gs.call("snapshot_run")
		if snapshot != null:
			return {"ok": true, "snapshot": _serialize_resource(snapshot)}
	if gs.has_method("snapshot"):
		var snapshot: Variant = gs.call("snapshot")
		if snapshot != null:
			return {"ok": true, "snapshot": _serialize_value(snapshot)}
	return {"error": "GameState node has no snapshot()/snapshot_run() method"}


func _state_restore(snapshot: Variant) -> Dictionary:
	if snapshot == null:
		return {"error": "snapshot is null"}
	var gs := _get_gs()
	if gs == null:
		return McpAddonConfig.not_configured("game_state", "game_state_node")
	if gs.has_method("restore_run"):
		var restored: bool = gs.call("restore_run", _deserialize_resource(snapshot))
		return {"ok": restored, "restored": restored}
	if gs.has_method("restore"):
		var restored: bool = gs.call("restore", _deserialize_value(snapshot))
		return {"ok": restored, "restored": restored}
	return {"error": "GameState node has no restore()/restore_run() method"}


## Kompakte, generische Zustandsübersicht: deklarierte Properties (Werte, die
## JSON-serialisierbar sind) + Gruppen-Mitgliedschaften. Kein Spielvokabular.
func _state_summary() -> Dictionary:
	var gs := _get_gs()
	if gs == null:
		return McpAddonConfig.not_configured("game_state", "game_state_node")
	var properties: Dictionary = {}
	for prop in gs.get_property_list():
		var prop_name := str(prop.get("name", ""))
		var usage := int(prop.get("usage", 0))
		if prop_name == "" or prop_name.begins_with("_") or prop_name == "script":
			continue
		if not (usage & PROPERTY_USAGE_EDITOR) and not (usage & PROPERTY_USAGE_STORAGE):
			continue
		var value: Variant = gs.get(prop_name)
		properties[prop_name] = _serialize_value(value)
	var groups: Array = []
	for group in gs.get_groups():
		groups.append(String(group))
	return {
		"ok": true,
		"node": str(gs.get_path()),
		"properties": properties,
		"groups": groups,
		"methods": _public_method_names(gs),
	}


func _public_method_names(node: Node) -> Array:
	var methods: Array = []
	var script: Script = node.get_script()
	if script == null:
		return methods
	for m in script.get_script_method_list():
		var method_name := str(m.get("name", ""))
		if method_name.begins_with("_"):
			continue
		methods.append(method_name)
	return methods


# ─── Entity-Brücke (get_id/get_faction-Konvention) ───────────────

func _get_entities() -> Array:
	var entities: Array = []
	var root := _get_root()
	if root == null:
		return entities
	# 1. Konfigurierter Node (z. B. ein Container-Node mit Entity-Kindern).
	var container := McpAddonConfig.resolve_configured_node(root, McpAddonConfig.planets_node())
	if container != null:
		_collect_entities(container, entities)
		if not entities.is_empty():
			return entities
	# 2. Konfigurierte Node-Gruppe (z. B. "planets").
	var group := McpAddonConfig.planets_group()
	if group != "":
		var tree := Engine.get_main_loop() as SceneTree
		if tree != null:
			for node in tree.get_nodes_in_group(group):
				if node is Node and node.has_method("get_id"):
					entities.append(node)
		if not entities.is_empty():
			return entities
	return entities


func _collect_entities(node: Node, results: Array) -> void:
	if node != null and node.has_method("get_id"):
		results.append(node)
	for child in node.get_children():
		_collect_entities(child, results)


func _entity_query(entity_id: String) -> Dictionary:
	var entities := _get_entities()
	if entities.is_empty() and McpAddonConfig.planets_node() == "" and McpAddonConfig.planets_group() == "":
		return McpAddonConfig.not_configured("entities", "planets_node")
	var found: Array = []
	for e in entities:
		var id := _entity_id(e)
		if entity_id == "" or id == entity_id:
			found.append({
				"id": id,
				"faction": _entity_faction(e),
			})
	return {"entities": found, "count": found.size()}


func _entity_info(entity_id: String) -> Dictionary:
	var entities := _get_entities()
	if entities.is_empty() and McpAddonConfig.planets_node() == "" and McpAddonConfig.planets_group() == "":
		return McpAddonConfig.not_configured("entities", "planets_node")
	for e in entities:
		if _entity_id(e) == entity_id:
			var info: Dictionary = {"id": entity_id, "faction": _entity_faction(e)}
			for prop in e.get_property_list():
				var prop_name := str(prop.get("name", ""))
				if prop_name.begins_with("_") or prop_name in ["script", "transform", "position", "scale", "rotation"]:
					continue
				if not (int(prop.get("usage", 0)) & (PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_STORAGE)):
					continue
				info[prop_name] = _serialize_value(e.get(prop_name))
			if e.has_method("get_worker_count"):
				info["workers"] = e.call("get_worker_count")
			if e.has_method("get_build_slot_count"):
				info["build_slots"] = e.call("get_build_slot_count")
			return info
	return {"error": "Entity not found: " + entity_id}


func _entity_id(e: Node) -> String:
	return String(e.call("get_id")) if e.has_method("get_id") else str(e.get_path())


func _entity_faction(e: Node) -> String:
	return String(e.call("get_faction")) if e.has_method("get_faction") else ""


# ─── Helpers ────────────────────────────────────────────────────

func _serialize_value(value: Variant) -> Variant:
	if value is StringName:
		return String(value)
	if value is Vector2:
		return {"x": value.x, "y": value.y}
	if value is Vector3:
		return {"x": value.x, "y": value.y, "z": value.z}
	if value is Color:
		return {"r": value.r, "g": value.g, "b": value.b, "a": value.a}
	if value is Resource:
		return _serialize_resource(value)
	if value is Dictionary:
		var out: Dictionary = {}
		for key in value:
			out[String(key)] = _serialize_value(value[key])
		return out
	if value is Array:
		var arr: Array = []
		for item in value:
			arr.append(_serialize_value(item))
		return arr
	if value is int or value is float or value is bool or value is String or value == null:
		return value
	return str(value)


func _deserialize_value(value: Variant) -> Variant:
	return value


static func _make(name: String, description: String, properties: Dictionary = {}, required: Array = []) -> Dictionary:
	var schema := {"type": "object", "properties": properties}
	if not required.is_empty():
		schema["required"] = required
	return {"name": name, "description": description, "inputSchema": schema}


func _serialize_resource(res: Resource) -> Dictionary:
	if res == null:
		return {}
	var data: Dictionary = {"_class": res.get_class(), "_path": str(res.resource_path)}
	for prop in res.get_property_list():
		var prop_name: String = str(prop.get("name", ""))
		if prop_name == "script" or not (int(prop.get("usage", 0)) & PROPERTY_USAGE_STORAGE):
			continue
		var val: Variant = res.get(prop_name)
		if val is Resource:
			data[prop_name] = _serialize_resource(val)
		else:
			data[prop_name] = _serialize_value(val)
	return data


func _deserialize_resource(data: Variant) -> Variant:
	if data is Dictionary:
		var dict: Dictionary = data
		if dict.has("_class") and dict.has("_path"):
			var path: String = str(dict.get("_path", ""))
			if path != "" and ResourceLoader.exists(path):
				var res: Resource = ResourceLoader.load(path)
				if res != null:
					return res
	return data
