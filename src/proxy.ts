import { spawn, type ChildProcess } from "node:child_process";
import { parseJsonRpcStream, type JsonRpcMessage } from "./json-rpc.js";
import { createSessionLogger, type AlertEntry } from "./logger.js";

export interface ProxyOptions {
  command: string;
  args: string[];
  logDir?: string;
  quiet?: boolean;
  noRetry?: boolean;
}

// Read-only tool names safe to auto-retry on error
const SAFE_RETRY_NAMES = new Set([
  "read_file", "read", "get_file_contents",
  "list_dir", "list_directory", "ls",
  "search", "grep", "find_files",
]);

const SAFE_RETRY_PREFIXES = ["get_"];

// Permanent error codes that should never be retried
const PERMANENT_ERROR_CODES = new Set([-32601, -32602, -32600]);

function isReadOnlyTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  if (SAFE_RETRY_NAMES.has(toolName)) return true;
  return SAFE_RETRY_PREFIXES.some((p) => toolName.startsWith(p));
}

function isPermanentError(msg: JsonRpcMessage): boolean {
  if (!msg.error) return false;
  return PERMANENT_ERROR_CODES.has(msg.error.code);
}

function getToolNameFromRequest(msg: JsonRpcMessage): string | undefined {
  if (msg.method === "tools/call" && msg.params && typeof msg.params === "object") {
    return (msg.params as Record<string, unknown>).name as string | undefined;
  }
  return undefined;
}

export async function startProxy(options: ProxyOptions): Promise<void> {
  // Redirect console to stderr to prevent stdout pollution
  console.log = (...args: unknown[]) => { process.stderr.write(args.map(String).join(" ") + "\n"); };
  console.warn = (...args: unknown[]) => { process.stderr.write(args.map(String).join(" ") + "\n"); };
  console.error = (...args: unknown[]) => { process.stderr.write(args.map(String).join(" ") + "\n"); };

  const quiet = options.quiet ?? !process.stdin.isTTY;
  const retryEnabled = !options.noRetry;

  const logger = await createSessionLogger(options.logDir);

  // Wire up alert callback for stderr output
  logger.onAlert = (alert: AlertEntry) => {
    if (quiet) return;
    if (alert.severity === "hallucination") {
      process.stderr.write(
        `\x1b[33m[flight] HALLUCINATION HINT: ${alert.message}\x1b[0m\n`,
      );
    } else if (alert.severity === "loop") {
      process.stderr.write(
        `\x1b[33m[flight] LOOP DETECTED: ${alert.message}\x1b[0m\n`,
      );
    } else if (alert.severity === "error") {
      process.stderr.write(
        `\x1b[31m[flight] TOOL ERROR: ${alert.tool_name ?? alert.method} — ${alert.message}\x1b[0m\n`,
      );
    }
  };

  const upstream: ChildProcess = spawn(options.command, options.args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!upstream.stdin || !upstream.stdout || !upstream.stderr) {
    throw new Error("Failed to open stdio pipes to upstream process");
  }

  // Track pending client requests for retry logic
  const pendingClientRequests = new Map<string | number, JsonRpcMessage>();
  // Track pending retries: id → held error response (forwarded if retry also fails)
  const pendingRetries = new Map<string | number, JsonRpcMessage>();

  // Client → Upstream: forward stdin and log
  const clientParser = parseJsonRpcStream(process.stdin);
  clientParser.on("message", (msg) => {
    logger.log(msg, "client->server");
    if (retryEnabled && msg.id != null) {
      pendingClientRequests.set(msg.id, msg);
    }
    upstream.stdin!.write(JSON.stringify(msg) + "\n");
  });
  clientParser.on("error", (err) => {
    logger.logError("client-parse-error", err.message);
  });

  // Upstream → Client: forward stdout and log
  const upstreamParser = parseJsonRpcStream(upstream.stdout);
  upstreamParser.on("message", (msg) => {
    // Check if this is a response to a pending retry
    if (msg.id != null && pendingRetries.has(msg.id)) {
      const heldError = pendingRetries.get(msg.id)!;
      pendingRetries.delete(msg.id);
      logger.log(msg, "server->client");

      if (msg.error) {
        // Retry also failed — forward original error to client
        process.stdout.write(JSON.stringify(heldError) + "\n");
      } else {
        // Retry succeeded — forward success to client
        process.stdout.write(JSON.stringify(msg) + "\n");
      }
      return;
    }

    // Check if we should auto-retry this failed response
    if (retryEnabled && msg.error && msg.id != null && !isPermanentError(msg)) {
      const originalRequest = pendingClientRequests.get(msg.id);
      if (originalRequest) {
        const toolName = getToolNameFromRequest(originalRequest);
        if (originalRequest.method === "tools/call" && isReadOnlyTool(toolName)) {
          // Log the initial error but hold the response
          logger.log(msg, "server->client");
          pendingClientRequests.delete(msg.id);
          pendingRetries.set(msg.id, msg);

          // Retry after 500ms
          setTimeout(() => {
            if (!upstream.killed && upstream.stdin && !upstream.stdin.destroyed) {
              upstream.stdin.write(JSON.stringify(originalRequest) + "\n");
            } else {
              // Upstream gone — forward held error to client
              const held = pendingRetries.get(originalRequest.id!);
              if (held) {
                pendingRetries.delete(originalRequest.id!);
                process.stdout.write(JSON.stringify(held) + "\n");
              }
            }
          }, 500);
          return;
        }
      }
    }

    // Normal flow
    if (msg.id != null) pendingClientRequests.delete(msg.id);
    logger.log(msg, "server->client");
    process.stdout.write(JSON.stringify(msg) + "\n");
  });
  upstreamParser.on("error", (err) => {
    logger.logError("upstream-parse-error", err.message);
  });

  // Capture upstream stderr
  upstream.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      logger.logError("upstream-stderr", text);
      if (!quiet) {
        process.stderr.write(chunk);
      }
    }
  });

  // Handle upstream exit
  upstream.on("close", async (code) => {
    // Flush held error responses for any pending retries
    for (const heldError of pendingRetries.values()) {
      process.stdout.write(JSON.stringify(heldError) + "\n");
    }
    pendingRetries.clear();
    // Send error responses for any requests that never got a reply
    for (const [id] of pendingClientRequests) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id,
        error: { code: -32000, message: "Upstream process exited" },
      }) + "\n");
    }
    pendingClientRequests.clear();
    await logger.close();
    process.exit(code ?? 0);
  });

  upstream.on("error", async (err) => {
    logger.logError("upstream-spawn-error", err.message);
    await logger.close();
    process.exit(1);
  });

  // Handle client disconnect
  process.stdin.on("end", () => {
    upstream.kill();
  });

  process.on("SIGTERM", () => {
    upstream.kill();
    logger.closeSync();
    process.exit(0);
  });

  process.on("SIGINT", () => {
    upstream.kill();
    logger.closeSync();
    process.exit(0);
  });
}
