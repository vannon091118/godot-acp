#!/usr/bin/env node
/**
 * simulator.mjs — Contract-Test-Ziel: simuliert den Godot-MCP-Server (TCP).
 *
 * Kein Wegwerf-Test: Dies ist der Vertragspartner, gegen den das Backend
 * beweisen muss, dass es OHNE echte Godot-Instanz funktioniert.
 *
 * Verhalten:
 *  - beantwortet initialize / tools/list / ping (MCP-Protokoll)
 *  - tools/call → nach kleiner Latenz ein Ergebnis (fake-ok:<tool>)
 *  - acp/pause_agent | acp/resume_agent | acp/stop_agent | acp/set_goal
 *    → Ack-Notification (godot.command_result) + Zustands-Event
 *  - sendet periodisch godot.event-Notifications (Beobachtungen)
 *  - --flake: trennt nach N Sekunden die Verbindung (Reconnect-Beweis)
 *
 * Start: node simulator.mjs [port] [--flake]
 */
import net from "node:net";

const args = process.argv.slice(2);
const FLAKE = args.includes("--flake");
const PORT = Number(args.find((a) => /^\d+$/.test(a)) || process.env.ACP_GODOT_PORT || 9090);

const TOOLS = [
  { name: "runtime_ux_scan", description: "fake: sichtbare Controls lesen" },
  { name: "runtime_ux_click", description: "fake: Control anklicken" },
  { name: "runtime_ux_find", description: "fake: Control finden" },
  { name: "runtime_freeze", description: "fake: Spielbaum pausieren" },
  { name: "runtime_eval", description: "fake: Ausdruck auswerten" },
  { name: "runtime_autonomy_export", description: "fake: Workspace exportieren" },
];

const server = net.createServer((sock) => {
  let buffer = "";
  let paused = false;
  const eventTimer = setInterval(() => {
    if (paused) return;
    sock.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { event: "observation", detail: `SceneTree sichtbar, ${2 + Math.floor(Math.random() * 5)} Controls` },
    }) + "\n");
  }, 3000);

  sock.on("close", () => clearInterval(eventTimer));

  sock.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const id = msg.id ?? null;

      if (msg.id === "acp-ping" || msg.method === "ping") {
        sock.write(JSON.stringify({ jsonrpc: "2.0", id, result: {} }) + "\n");
        continue;
      }

      // Backend-Systemzustände als Notifications empfangen und bestätigen.
      if (msg.method === "acp/pause_agent") {
        paused = true;
        sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { event: "command_result", detail: "pause ACK" } }) + "\n");
        sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { event: "state", detail: "SIM_PAUSED" } }) + "\n");
        continue;
      }
      if (msg.method === "acp/resume_agent") {
        paused = false;
        sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { event: "command_result", detail: "resume ACK" } }) + "\n");
        continue;
      }
      if (msg.method === "acp/stop_agent" || msg.method === "acp/set_goal") {
        sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { event: "command_result", detail: `${msg.method} ACK` } }) + "\n");
        continue;
      }

      if (msg.method === "initialize") {
        sock.write(JSON.stringify({
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-godot-acp", version: "0.3.0-sim" },
          },
        }) + "\n");
        continue;
      }

      if (msg.method === "tools/list") {
        sock.write(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: TOOLS } }) + "\n");
        continue;
      }

      if (msg.method === "tools/call") {
        const tool = msg.params?.name ?? "?";
        // Vertragsfall: Fehler-Tool meldet einen echten JSON-RPC-Fehler —
        // das Backend muss daraus FAILED machen (kein Hängen, kein fake-ok).
        if (tool === "runtime_failing_tool") {
          setTimeout(() => {
            sock.write(JSON.stringify({
              jsonrpc: "2.0", id,
              error: { code: -32000, message: "simulierte Zielfehler: runtime_failing_tool ist kaputt" },
            }) + "\n");
          }, 60);
          continue;
        }
        // Kleine Latenz: RUNNING-Zustand im Backend wird beobachtbar.
        setTimeout(() => {
          sock.write(JSON.stringify({
            jsonrpc: "2.0", id,
            result: { content: [{ type: "text", text: `fake-ok:${tool}` }] },
          }) + "\n");
        }, 60);
        continue;
      }

      sock.write(JSON.stringify({ jsonrpc: "2.0", id, result: {} }) + "\n");
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fake_godot] lauscht auf :${PORT}${FLAKE ? " (flake: bricht in 8s ab)" : ""}`);
  if (FLAKE) {
    setTimeout(() => {
      console.log("[fake_godot] FLAKE: Verbindung wird gekappt — Reconnect-Beweis folgt.");
      server.close();
      server.unref();
      process.exit(0);
    }, 8000);
  }
});
