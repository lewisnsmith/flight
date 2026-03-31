import { spawn } from "node:child_process";
import { parseJsonRpcStream, type JsonRpcMessage } from "./json-rpc.js";
import type { LogEntry } from "./logger.js";

export interface ReplayOptions {
  command: string;
  args: string[];
  dryRun?: boolean;
}

export interface ReplayResult {
  request: LogEntry;
  response?: JsonRpcMessage;
  error?: string;
  dryRun: boolean;
}

/**
 * Find a call entry (client->server request) by call_id prefix match.
 */
export function findCallRequest(entries: LogEntry[], callId: string): LogEntry | null {
  return entries.find(
    (e) =>
      e.direction === "client->server" &&
      (e.call_id === callId || e.call_id.startsWith(callId)),
  ) ?? null;
}

/**
 * Replay a recorded tool call against an upstream MCP server.
 */
export async function replayCall(
  entry: LogEntry,
  options: ReplayOptions,
): Promise<ReplayResult> {
  if (options.dryRun) {
    return { request: entry, dryRun: true };
  }

  const payload = entry.payload as JsonRpcMessage;
  if (!payload || !payload.method) {
    return { request: entry, error: "Entry has no replayable payload (not a request)", dryRun: false };
  }

  return new Promise((resolve) => {
    let resolved = false;
    function resolveOnce(result: ReplayResult) {
      if (resolved) return;
      resolved = true;
      resolve(result);
    }

    const upstream = spawn(options.command, options.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!upstream.stdin || !upstream.stdout) {
      resolveOnce({ request: entry, error: "Failed to open pipes to upstream", dryRun: false });
      return;
    }

    let stderrOutput = "";
    upstream.stderr?.on("data", (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    const timeout = setTimeout(() => {
      upstream.kill();
      resolveOnce({ request: entry, error: "Replay timed out after 30s", dryRun: false });
    }, 30_000);

    // For tools/call, we need to initialize first
    const initRequest: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "flight-replay", version: "1.0.0" },
      },
    };

    const parser = parseJsonRpcStream(upstream.stdout);
    let initDone = false;

    parser.on("message", (msg) => {
      if (!initDone && msg.id === 0) {
        // Initialize response received, send the actual call
        initDone = true;
        // Send initialized notification
        upstream.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        // Send the replay request
        upstream.stdin!.write(JSON.stringify(payload) + "\n");
        return;
      }

      if (initDone && msg.id === payload.id) {
        clearTimeout(timeout);
        upstream.kill();
        resolveOnce({ request: entry, response: msg, dryRun: false });
      }
    });

    parser.on("error", () => {
      // Ignore parse errors from upstream
    });

    upstream.on("error", (err) => {
      clearTimeout(timeout);
      resolveOnce({ request: entry, error: `Spawn error: ${err.message}`, dryRun: false });
    });

    upstream.on("close", (code) => {
      clearTimeout(timeout);
      resolveOnce({
        request: entry,
        error: `Upstream exited before responding (code ${code})${stderrOutput ? `: ${stderrOutput.trim()}` : ""}`,
        dryRun: false,
      });
    });

    // Send initialize
    upstream.stdin.write(JSON.stringify(initRequest) + "\n");
  });
}
