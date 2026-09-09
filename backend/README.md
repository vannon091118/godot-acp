# GODOT ACP — Backend & Cockpit

Das Backend ist die **zentrale Steuerebene** für Agent-Playthroughs. Es läuft
komplett ohne Godot — Godot ist hier nur ein Client, der sich per TCP meldet.

## Warum es das gibt

Ohne Backend gilt: Der Agent redet direkt mit dem Spiel, und der Nutzer guckt
zu — oder Vertrauenspersonen lesen später Protokolle. Mit Backend gilt: Jede
Agent-Aktion läuft durch einen Proxy, den **du** kontrollierst. Pausieren,
Werkzeuge sperren, Ziele geben, Freigaben entscheiden — alles im Dashboard,
ohne ein Wort im Agent-Chat zu verlieren.

## Architektur in einem Satz

```
Godot-MCP (:9090)  ←—  Backend (:8787 Web/REST/SSE, :9099 Agent-Proxy)  ←—  Agent & Dashboard
```

- **Target-State lebt im Backend.** Läuft Godot? Weiß das Backend — auch wenn
  Godot nichts mehr sagt (Ping-Timeout → `DEGRADED`).
- **Der Agent verbindet sich NUR mit dem Proxy** (`:9099`) und glaubt, er
  spreche mit Godot. Tatsächlich entscheidet das Backend je Call:
  - `PAUSED` (Nutzer) → Ablehnung `-32003`
  - Tool auf der Blockliste (Nutzer) → Ablehnung `-32003`
  - Freigabepflichtig (z. B. `runtime_autonomy_export`, `runtime_eval`) →
    wartet auf deinen Klick im Dashboard, 60 s Zeitlimit
  - sonst → Durchleitung an Godot
- **Command-Bus mit `origin`:** Jede Aktion ist ein Command
  (`human` / `system` / `agent`) und landet in `~/.godot-acp/commands.jsonl`.
- **Events** werden als JSONL persistiert (`~/.godot-acp/events.jsonl`) und
  live per SSE (`/api/events`) an alle Dashboards gestreamt.

## Start (3 Befehle)

```bash
cd backend
npm install --registry=https://registry.npmmirror.com   # falls npmjs.org blockiert ist
npm run web:build      # Dashboard bauen (einmalig)
npm start              # Backend + Dashboard auf http://localhost:8787
```

Danach: Dashboard im Browser öffnen, Spiel starten (Godot-MCP auf `:9090`),
und wenn ein Agent arbeitet, dessen MCP-Verbindung auf `localhost:9099`
(Proxy) zeigen lassen statt auf `:9090`. Fertig — du siehst alles live.

**Test ohne Godot:** `npm test` startet einen Godot-Simulator
(`test/fake_godot.mjs`) und beweist Durchleitung, Pause, Blockliste,
Approval-Flow und Ziel-Setzung (Exit 0 = alle Beweise erbracht).

## REST-API (für eigene Clients, Ink-CLI, Skripte)

| Route | Methode | Zweck |
| --- | --- | --- |
| `/api/state` | GET | Kompletter Snapshot (Target, Session, Blockliste, Stats) |
| `/api/events` | GET | SSE-Live-Stream (State + Events + Approvals) |
| `/api/commands` | POST | Command einschleusen: `{ "type": "...", "payload": {...} }` |
| `/api/tools` | GET | Tool-Liste von Godot (für die Blocklisten-Auswahl) |
| `/api/approvals` | GET | Offene Freigaben |
| `/api/approvals/:tool` | POST | Freigabe entscheiden: `{ "approved": true/false }` |
| `/api/evidence` | GET | Letzte Intercept-/Command-Events |

### Commands (Auszug)

| type | payload | Wirkung |
| --- | --- | --- |
| `session.pause` / `session.resume` | — | Agent anhalten / weiterlaufen lassen |
| `session.stop` | — | Session beenden |
| `session.goal` | `{ "goal": "..." }` | Ziel setzen (ändert *woran*, nicht *wie*) |
| `session.controls` | `{ "enabled": false }` | Nutzer-Steuerung global verriegeln |
| `tools.block` / `tools.unblock` | `{ "tools": ["runtime_eval"] }` | Werkzeuge sperren/freigeben |
| `godot.reconnect` | — | Target-Verbindung neu aufbauen |

## Terminal-Cockpit (Ink)

```bash
cd backend
npm install ink --registry=https://registry.npmmirror.com
node cli/dashboard.mjs
```

Tasten: `[p]` Pause/Weiter · `[s]` Stop · `[g]` Ziel tippen · `[t]` Werkzeuge
sperren · `[r]` Neu verbinden · `[q]` Beenden.

## Grenzen (ehrlich)

- Screenshots/Beweise bleiben beim Spiel (`user://mcp_context`); das Dashboard
  zeigt aktuell deren *Metadaten* im Feed, nicht die Bilder. Bildanzeige ist
 Roadmap (v1.1).
- Das Backend reguliert den Agenten über **Protokollantworten**, nicht über
  Magie: Ein pausierter Agent sieht eine klare Fehlermeldung und kann
  selbst entscheiden, wie er darauf reagiert. Wer im Chat „übertreibt",
  dem hilft auch kein Proxy.
- Die Godot-Seite muss nichts von alledem wissen — das ist der Punkt.
