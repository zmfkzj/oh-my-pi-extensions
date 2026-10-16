// Local JSON-RPC/MCP fixture: a real subprocess/stdio transport, not a GUI or CodeGraph implementation.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [log, server, delay = "60"] = process.argv.slice(2);
const record = event => appendFileSync(log, JSON.stringify({ event, server, pid: process.pid }) + "\n");
const tools = server === "computer_use" ? ["list_desktop", "act"] : ["codegraph_explore"];
record("spawn");
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    record("initialize");
    setTimeout(() => send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: server, version: "test" } }), Number(delay));
  } else if (message.method === "tools/list") {
    send(message.id, { tools: tools.map(name => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) });
  } else if (message.method === "tools/call") {
    record(`call:${message.params.name}`);
    send(message.id, { content: [{ type: "text", text: JSON.stringify({ server, pid: process.pid, args: message.params.arguments }) }] });
  } else if (message.method === "ping") send(message.id, {});
  else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not implemented" } }) + "\n");
}).on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("exit", () => record("exit"));
