# GODOT ACP — Backend (die Autorität)

Das Backend ist **das Kontrollsystem**. Godot ACP — das Godot-Addon — ist nur
noch der Adapter/Execution-Layer. Diese Rollenverteilung ist bewusst und
endgültig: Das Backend besitzt Wahrheit und Zustände, Godot besitzt Fähigkeit.

## Architekturvertrag

```text
godot-acp/
├── backend/        DIESE Ebene: Autorität, läuft ohne Godot
│   ├── server.mjs          Target-/Agent-Registry, Command-Bus, SSE, REST
│   ├── persistence/        append-only JSONL (events/commands/sessions)
│   └── data/               Laufzeitdaten (gitignored)
├── fake_godot/     Contract-Test-Ziel: simuliert Godot vollständig
├── dashboard/      React+Vite Frontend (liest NUR die Backend-Wahrheit)
├── cli/            Ink-Terminal-Frontend (dasselbe: SSE + REST, keine Logik)
└── runtime|editor|vision|ux|testing|autonomy|context/   das Godot-ACP (Adapter)
```

### Was hier zentral wohnt

```text
Target Registry → Target State      (godot-01: OFFLINE/CONNECTING/CONNECTED/DEGRADED/RECONNECTING)
Agent Registry  → Agent State       (IDLE/WORKING/PAUSE_REQUESTED/PAUSED/STOP_REQUESTED)
Command Bus     → Command State     (siehe Zustandsmaschine unten)
Event Stream    → SSE /api/events   (React UND Ink abonnieren denselben Strom)
Persistence     → append-only JSONL (aktueller State IMMER daraus ableitbar)
```

### Der Godot-Connector besitzt nichts

Er meldet ausschließlich:

```text
godot.connected · godot.disconnected · godot.state_changed
godot.event · godot.command_result
```

Das Backend entscheidet daraus den eigenen Zustand. Fällt Godot weg, bleibt
das Backend voll bedienbar (bewiesen im Contract-Test, Schritt 8).

## Command-Bus: eine Zustandsmaschine für alle Origins

```text
CREATED → QUEUED → DISPATCHED → RUNNING → COMPLETED
Nebenzustände: WAITING_APPROVAL · REJECTED · BLOCKED · CANCELLED · TIMEOUT · FAILED
Origins: human | agent | system | qa
```

Der Nutzer drückt Pause → `origin=human, type=pause_agent`. Der Agent ruft ein
Tool → `origin=agent, type=runtime_ux_scan`. **Derselbe Bus, dieselbe
Maschine, dieselbe Protokollierung.** Tool-Calls von Agenten durchlaufen vor
dem Dispatch drei echte Prüfungen (kein UI-Theater):

1. **Agent-Zustand** — `PAUSED`/`STOP_REQUESTED` ⇒ `BLOCKED`
2. **Blockliste** — Entities mit `scope/value/reason/active` ⇒ `BLOCKED` mit Grund
3. **Freigabepflicht** — geschützte Tools ⇒ `WAITING_APPROVAL` (60-s-Timeout),
   Entscheidung via `POST /api/approvals/:commandId`

Pausen/Resume/Ziele werden dem Ziel zusätzlich als `acp/*`-Notification
gemeldet; der Adapter bestätigt per ACK (`godot.command_result`). Die
Backend-Autorität hängt davon **nicht** ab.

## REST (Befehle) + SSE (Lagebild)

| Route | Methode | Zweck |
| --- | --- | --- |
| `/api/status` | GET | Kompletter Snapshot (Targets, Agents, Blocks, Approvals, Stats) |
| `/api/targets` · `/api/agents` | GET | Einzelne Registries |
| `/api/commands` | POST | Command einschleusen: `{origin, type, payload}` |
| `/api/agents/:id/pause·resume·stop·goal` | POST | Agent-Steuerung (origin=human) |
| `/api/blocks` | GET/POST | Blockliste (Entities) |
| `/api/blocks/:id/deactivate` | POST | Sperre aufheben |
| `/api/approvals` | GET | Offene Freigaben |
| `/api/approvals/:commandId` | POST | `{approved: true/false}` |
| `/api/replay-proof` | GET | Beweis: State aus JSONL ablesbar |
| `/api/events` | GET | **SSE** — denselben Strom lesen React und Ink |

## Persistenz: append-only zuerst

```text
backend/data/events.jsonl     jeder beobachtete Vorfall
backend/data/commands.jsonl   jede Command-Transition (CREATED → … → terminal)
backend/data/sessions.jsonl   jeder Agent-Zustandsübergang
```

Keine `status.json`/`agent.json`, die gegeneinander kämpfen. Der aktuelle
State ist ein Fold über das Log — `/api/replay-proof` führt den Beweis
ausdrücklich. Nach einem Neustart werden PAUSED-Agenten aus `sessions.jsonl`
wiederhergestellt.

## Start (3 Befehle)

```bash
cd backend
npm run web:build     # Dashboard bauen (einmalig)
npm start             # Backend + Cockpit auf http://localhost:8787
npm test              # Contract-Test OHNE echte Godot-Instanz
```

Ports (ENV): `ACP_BACKEND_PORT=8787` · `ACP_PROXY_PORT=9099` (Agent-Zugang) ·
`ACP_GODOT_PORT=9090` (Ziel). Falls npmjs.org blockiert: `--registry=https://registry.npmmirror.com`.

## Der Contract-Test (fake_godot/)

Kein Wegwerf-Test: `fake_godot/simulator.mjs` ist der Vertragspartner, gegen
den das Backend beweisen muss, dass es **ohne echte Godot-Instanz** direkt
funktioniert. `fake_godot/contract_test.mjs` führt die volle Beweiskette:

```text
Backend → Target CONNECTED (nur Simulator)
Agent → Proxy → Registry WORKING
tools/call → CREATED→QUEUED→DISPATCHED→RUNNING→COMPLETED → Antwort beim Agent
SSE → React/Ink-Strom sieht RUNNING/COMPLETED live
Human → Pause → Backend PAUSED → Simulator-ACK → Agent-Call BLOCKED
Blockliste → Entity mit Grund → gezielte BLOCKED, andere Tools laufen
Approval → WAITING_APPROVAL → Freigabe COMPLETED / Verweigerung BLOCKED
Disconnect → RECONNECTING (Backend bleibt bedienbar) → Reconnect CONNECTED
Replay → State aus JSONL faltbar
```

Exit 0 = der Zyklus läuft. Damit ist die zentrale Frage beantwortet: Ja, das
Backend ist unabhängig.

## Ink-Cockpit (cli/)

```bash
cd cli && npm install ink --registry=https://registry.npmmirror.com
node dashboard.mjs
```

`[p]` Pause/Weiter · `[s]` Stop · `[g]` Ziel · `[t]` Sperren-Ansicht · `[q]` Ende.
Ohne `ink` läuft ein Poll-Modus mit denselben Tasten.

## Grenzen (ehrlich)

- Screenshot-Bilder bleiben beim Ziel (`user://mcp_context`); das Cockpit zeigt
  deren Metadaten. Bildanzeige: ROADMAP v1.1.
- `McpRunTrace` und `McpAgentActivity` (Godot-Seite) führen weiterhin lokale
  Notfall-/Puffer-Traces — die **offizielle** Run-/Activity-Historie entsteht
  ab jetzt im Backend (events/commands JSONL). Die Godot-Seite meldet
  `godot.event`s; der zentrale Record ist backend-seitig.
