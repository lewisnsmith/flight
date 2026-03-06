/**
 * Minimal mock MCP server for testing.
 * Reads NDJSON from stdin, responds on stdout.
 * Supports: initialize, tools/list, tools/call
 */

import { createInterface } from "node:readline";

// Track tools that should fail once then succeed (for retry testing)
const failOnceTracker = new Set<string>();

const TOOLS = [
  { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Write a file", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "list_dir", description: "List directory", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
];

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (msg.method === "initialize") {
    respond(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock-mcp", version: "1.0.0" } });
  } else if (msg.method === "notifications/initialized") {
    // No response for notifications
  } else if (msg.method === "tools/list") {
    respond(msg.id, { tools: TOOLS });
  } else if (msg.method === "tools/call") {
    const toolName = msg.params?.name;
    if (toolName === "read_file") {
      const path = msg.params?.arguments?.path ?? "";
      if (path === "/flaky" && !failOnceTracker.has("read_file:/flaky")) {
        // First call to /flaky fails, second succeeds
        failOnceTracker.add("read_file:/flaky");
        respondError(msg.id, -32000, "Temporary read error");
      } else {
        respond(msg.id, { content: [{ type: "text", text: "file contents here: " + path }] });
      }
    } else if (toolName === "write_file") {
      if (msg.params?.arguments?.path === "/forbidden") {
        respondError(msg.id, -32000, "Permission denied");
      } else {
        respond(msg.id, { content: [{ type: "text", text: "ok" }] });
      }
    } else if (toolName === "list_dir") {
      respond(msg.id, { content: [{ type: "text", text: JSON.stringify(["file1.ts", "file2.ts", "dir/"]) }] });
    } else {
      respondError(msg.id, -32601, `Unknown tool: ${toolName}`);
    }
  } else {
    respondError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
});

function respond(id: string | number, result: unknown) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function respondError(id: string | number, code: number, message: string) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}
