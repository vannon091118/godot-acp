# GODOT ACP — Backend (die Autorität + Orchestrator)

Das Backend ist **das Kontrollsystem**. Godot ACP — das Godot-Addon — ist nur
noch der Adapter/Execution-Layer. Diese Rollenverteilung ist bewusst und
endgültig: Das Backend besitzt Wahrheit und Zustände, Godot besitzt Fähigkeit.

## Architekturvertrag

```text
godot-acp/
├── backend/        DIESE Ebene: Autorität + Orchestrator, läuft ohne Godot
│   ├── server.mjs          Target-/Agent-Registry, Command-Bus, SSE, REST,
│   │                       Orchestrator (Beobachtung, Anomalie-Analyse, Work-Orders)
│   ├── contract.mjs        DER eingefrorene Vertrag (Zustände, Kanäle, Wörter)
│   ├── persistence/        append-only JSONL (events/commands/sessions)
│   └── data/               Laufzeitdaten (gitignored)
├── fake_godot/     Contract-Test-Ziel: simuliert Godot vollständig (NUR Tests)
├── dashboard/      React+Vite Frontend (liest NUR die Backend-Wahrheit)
├── cli/            Ink-Terminal-Frontend (dasselbe: SSE + REST, keine Logik)
└── runtime|editor|icons|client|mcp_chains/   das Godot-ACP (Adapter)
```

### Was hier zentral wohnt

```text
Target Registry → Target State      (OFFLINE/CONNECTING/ONLINE/DEGRADED/DISCONNECTED)
Agent Registry  → Agent State       (IDLE/WORKING/WAITING/PAUSE_REQUESTED/PAUSED/BLOCKED/FAILED/STOPPED)
Command Bus     → Command State     (siehe Zustandsmaschine unten)
Event Stream    → SSE /api/events   (React UND Ink abonnieren denselben Strom)
Orchestrator    → Beobachtung/Analyse/Work-Orders (endet nicht)
Persistence     → append-only JSONL (aktueller State IMMER daraus ableitbar)
```

### Adapter-Handshake: "verbunden" ist eine bewiesene Wahrheit

Der Connector setzt ein Ziel erst dann auf ONLINE, wenn der MCP-Handshake
(`initialize` → Antwort) über die TCP-Verbindung gelaufen ist. Ein offener
Port allein ist kein "verbunden". Fällt Godot weg, bleibt das Backend voll
bedienbar (bewiesen im Contract-Test, Schritt 8). Der echte Godot-Server
kennt zudem die Backend-Control-Methoden `acp/pause_agent`,
`acp/resume_agent`, `acp/stop_agent`, `acp/set_goal` und bestätigt sie per
ACK-Notification; während einer Backend-Pause verweigert er jeden Tool-Call
mit strukturierter `BLOCKED`-Antwort.

## Orchestrator: das Backend arbeitet selbstständig

Das Backend endet nicht. Eine Dauerschleife (adaptives Intervall: eng bei
Anomalien/QA/Offline, sonst ruhig) macht drei Dinge — alle über dieselbe
Command-Maschine, keine Parallelarchitektur:

1. **Beobachten & packen:** Sobald der letzte Auftrag erledigt ist, packt der
   Orchestrator eine **Work-Order** mit echter Baseline-Observation aus einem
   echten Ziel-Scan. Ein Agent holt sie per `backend.get_work` /
   `backend.claim_work` ab.
2. **NUR bei Anomalie wird's teuer:** Jeder echte Fehler — FAILED, TIMEOUT
   oder ein Tool-Ergebnis mit `isError`/ERROR-Text — erzeugt eine
   **Anomalie-Entity** und triggert eine **atomare Analyse-Kette**
   (Zustand sichern → Sicht sichern → Text/Audio/Logs). Die Analyse wählt
   ihre Tools **generisch aus den echten Ziel-Capabilities** (tools/list des
   Ziels), nicht aus einer Hardcode-Liste. Jeder Schritt ist ein einzelner
   Call mit Observation; Misserfolge werden dokumentiert, nie erfunden.
3. **Capabilities generisch binden:** Die Ziel-Tools werden per tools/list
   gebunden (73 echte Tools beim realen Godot-Ziel) und dem Agent
   transparent über `tools/list` + `backend.onboard` geliefert.

### Ausführungsreihen: Task rein, Atome kommen raus

Die harte Regel: MCP-Nutzung bedeutet **sichtbares Spielfenster**, und Tasks
werden nicht als Einzel-Klicks ausgeführt, sondern als **atomare
Ausführungsreihen**. Der Agent gibt Absichten ab (`backend.run_sequence` oder
`POST /api/sequences`); das Backend baut daraus die echte Reihenfolge und
**ergänzt automatisch den smooth Maus-Ansatz** (`runtime_mouse_move`,
interpoliert über mehrere Frames) vor jedem Koordinaten-Klick — der Agent muss
niemals selbst einen Ansatz setzen. Ausführung ist **asynchron**: sofort eine
`sequenceId`, Fortschritt via `sequence.progress` (SSE) bzw.
`backend.get_sequence`. Jedes Atom ist ein normaler Command auf dem Bus —
Pause, Blockliste und Freigaben greifen unverändert. Ohne ONLINE-Ziel wird die
Sequenz mit konkreter Ursache abgelehnt (kein Schein-Fortschritt).

### Onboarding ohne Code-Lektüre

`backend.onboard` (via Proxy) bzw. `GET /api/onboard` liefert in einem
Antwortobjekt ALLES für externe Agenten: den Vertrag (alle Zustandsmaschinen),
die Human-Control-Regel (BLOCKED ist Nutzerwille, kein Fehler), die
Worker-Loop-Vorschrift (`get_work → atomarer Call → observe → claim_work`)
und die nächsten Schritte. Kein Studium des Godot-Addons nötig.

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
   (eine Sperre pro scope+value; Duplikate reaktivieren statt stapeln)
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
| `/api/orchestrator` | GET | Orchestrator-Status: Anomalien, Work-Orders, Observations, Capabilities |
| `/api/onboard` | GET | Onboarding-Objekt (Vertrag, Loops, Human-Control, nächste Schritte) |
| `/api/contract` | GET | Eingefrorener Vertrag (Zustände, SSE-Kanäle, Menschen-Wörter) |
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

## Die reale Godot-Strecke (Release-Beweis)

Der Contract-Test gegen den Simulator beweist die Backend-Logik; die **reale
Strecke** wurde zusätzlich mit echtem Godot 4.7.2 geprüft (Testprojekt mit
`addons/mcp` + `McpRuntime`-Autoload, Spiel sichtbar, Server auf :9090):

```text
Echtes Godot ONLINE nach MCP-Handshake (kein Schein-Verbunden)
Agent → Proxy → echtes runtime_ux_scan → echte Controls mit Pfaden/Rects
Human → Pause → echtes acp/pause ACK → Agent-Call BLOCKED → Resume → läuft
Blockliste nur für runtime_eval → geblockt; andere Tools laufen weiter
Unbekanntes Tool → FAILED → Anomalie → automatische Analyse mit ECHTEN
  Godot-Tools (runtime_eval, runtime_screenshot, runtime_vision_worker_ocr,
  runtime_ux_logs) → ANALYZED mit Screenshot-/OCR-/Log-Beweisen
Godot-Kill → DISCONNECTED/CONNECTING → Neustart → ONLINE (Reconnect)
Backend-Neustart → State/Verlauf aus JSONL (118 Commands faltbar)
```

Exit 0 des Contract-Tests = Backend-Logik unabhängig. Die obige reale Liste =
der Godot-Adapter erfüllt denselben Vertrag.

## Ink-Cockpit (cli/)

```bash
cd cli && npm install --registry=https://registry.npmmirror.com
node dashboard.mjs
```

`[p]` Pause/Weiter · `[s]` Stop · `[g]` Ziel · `[y]/[n]` Freigabe · `[q]` Ende.
Ohne TTY/`ink` läuft ein Poll-Modus mit denselben Taten. Die CLI besitzt
keine eigene Zustandslogik — sie spiegelt denselben SSE-Strom wie React und
sendet über denselben REST-Bus.

## Grenzen (ehrlich)

- Screenshot-Bilder bleiben beim Ziel (`user://mcp_context`); das Cockpit zeigt
  deren Metadaten. Bildanzeige: ROADMAP v1.1.
- `McpRunTrace` und `McpAgentActivity` (Godot-Seite) führen weiterhin lokale
  Notfall-/Puffer-Traces — die **offizielle** Run-/Activity-Historie entsteht
  ab jetzt im Backend (events/commands JSONL). Die Godot-Seite meldet
  `godot.event`s; der zentrale Record ist backend-seitig.
