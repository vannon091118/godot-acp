#!/usr/bin/env node
/**
 * fake_godot.mjs — simuliert den Godot-MCP-Server (TCP) für Backend-Tests.
 *
 * Beantwortet jede JSON-RPC-Anfrage mit einer synthetischen Antwort.
 * Start: node test/fake_godot.mjs [port]
 */
import net from "node:net";

const PORT = Number(process.argv[2] || process.env.ACP_GODOT_PORT || 9090);

const REPLIES = {
  initialize: {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "fake-godot-acp", version: "0.0.0-test" },
  },
  "tools/list": { tools: [{ name: "runtime_ux_scan", description: "fake" }] },
};

const server = net.createServer((sock) => {
  let buffer = "";
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
      if (msg.method === "ping") {
        sock.write(JSON.stringify({ jsonrpc: "2.0", id, result: {} }) + "\n");
        continue;
      }
      if (msg.method === "tools/call") {
        sock.write(JSON.stringify({
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: `fake-ok:${msg.params?.name}` }] },
        }) + "\n");
        continue;
      }
      sock.write(JSON.stringify({ jsonrpc: "2.0", id, result: REPLIES[msg.method] ?? {} }) + "\n");
    }
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[fake_godot] lauscht auf :${PORT}`));
