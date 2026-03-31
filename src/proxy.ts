import { spawn } from "node:child_process";
import { parseJsonRpcStream, type JsonRpcMessage } from "./json-rpc.js";
import { createSessionLogger, type AlertEntry } from "./logger.js";
import { createPDHandlerWithHistory, type PDHandler } from "./progressive-disclosure.js";
import { createRetryManager } from "./retry.js";
import { C } from "./shared.js";

export interface ProxyOptions {
  command: string;
  args: string[];
  logDir?: string;
  quiet?: boolean;
  noRetry?: boolean;
  pd?: boolean;
  pdHistory?: number;
}

export async function startProxy(options: ProxyOptions): Promise<void> {
  // Redirect console to stderr to prevent stdout pollution
  console.log = (...args: unknown[]) => { process.stderr.write(args.map(String).join(" ") + "\n"); };
  console.warn = (...args: unknown[]) => { process.stderr.write(args.map(String).join(" ") + "\n"); };
  console.error = (...args: unknown[]) => { process.stderr.write(args.map(String).join(" ") + "\n"); };

  const quiet = options.quiet ?? !process.stdin.isTTY;

  const logger = await createSessionLogger(options.logDir);

  // Wire up alert callback for stderr output
  logger.onAlert = (alert: AlertEntry) => {
    if (quiet) return;
    if (alert.severity === "hallucination") {
      process.stderr.write(
        `${C.yellow}[flight] HALLUCINATION HINT: ${alert.message}${C.reset}\n`,
      );
    } else if (alert.severity === "loop") {
      process.stderr.write(
        `${C.yellow}[flight] LOOP DETECTED: ${alert.message}${C.reset}\n`,
      );
    } else if (alert.severity === "error") {
      process.stderr.write(
        `${C.red}[flight] TOOL ERROR: ${alert.tool_name ?? alert.method} — ${alert.message}${C.reset}\n`,
      );
    }
  };

  // Progressive disclosure
  const pdEnabled = options.pd ?? false;
  let pdHandler: PDHandler | null = null;

  if (pdEnabled) {
    pdHandler = await createPDHandlerWithHistory(
      options.command,
      options.args,
      options.pdHistory ?? 3,
    );
  }

  const upstream = spawn(options.command, options.args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!upstream.stdin || !upstream.stdout || !upstream.stderr) {
    throw new Error("Failed to open stdio pipes to upstream process");
  }

  const retry = createRetryManager(!options.noRetry);

  // Client → Upstream: forward stdin and log
  const clientParser = parseJsonRpcStream(process.stdin);
  clientParser.on("message", (msg) => {
    // PD: intercept discover_tools calls (Phase 3 local handler)
    if (pdHandler && pdHandler.isActive() && msg.method === "tools/call" && msg.params) {
      const params = msg.params as Record<string, unknown>;
      const toolName = params.name as string;

      if (toolName === "discover_tools") {
        const args = params.arguments as Record<string, unknown>;
        const query = (args?.query as string) ?? "";
        const results = pdHandler.discoverTools(query);
        const response = {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
          },
        };
        logger.log(msg, "client->server");
        logger.log(response as JsonRpcMessage, "server->client");
        process.stdout.write(JSON.stringify(response) + "\n");
        return;
      }
    }

    logger.log(msg, "client->server");
    retry.trackRequest(msg);
    upstream.stdin!.write(JSON.stringify(msg) + "\n");
  });
  clientParser.on("error", (err) => {
    logger.logError("client-parse-error", err.message);
  });

  // Upstream → Client: forward stdout and log
  const upstreamParser = parseJsonRpcStream(upstream.stdout);
  upstreamParser.on("message", (msg) => {
    // --- Retry handling ---
    const retryResult = retry.handleResponse(msg, (req) => {
      if (!upstream.killed && upstream.stdin && !upstream.stdin.destroyed) {
        upstream.stdin.write(JSON.stringify(req) + "\n");
      } else {
        // Upstream gone — forward held error immediately
        // (drain() will catch any remaining on close)
      }
    });

    if (retryResult.handled) {
      logger.log(msg, "server->client");
      if (retryResult.forward) {
        process.stdout.write(JSON.stringify(retryResult.forward) + "\n");
      }
      return;
    }

    // --- Progressive disclosure response processing ---
    if (pdHandler && msg.id != null) {
      const originalRequest = retry.getOriginalRequest(msg.id);
      const pdResult = pdHandler.processResponse(originalRequest, msg);

      if (pdResult.error) {
        if (!quiet) {
          process.stderr.write(`[flight] Warning: PD falling back to passthrough: ${pdResult.error}\n`);
        }
        logger.logError("pd-fallback", pdResult.error);
        // Fall through to normal flow
      } else if (pdResult.rewrittenResponse) {
        logger.pdActive = true;
        retry.clearRequest(msg.id);
        logger.log(pdResult.rewrittenResponse, "server->client", pdResult.logMeta ? {
          pd_active: pdResult.logMeta.pd_active,
          schema_tokens_saved: pdResult.logMeta.schema_tokens_saved,
          pd_phase: pdResult.logMeta.pd_phase,
        } : undefined);

        if (!quiet && pdResult.statusMessage) {
          process.stderr.write(`[flight] ${pdResult.statusMessage}\n`);
        }

        process.stdout.write(JSON.stringify(pdResult.rewrittenResponse) + "\n");
        return;
      } else if (pdResult.toolHidden) {
        // Tool was hidden — annotate in log but continue normal flow
        retry.clearRequest(msg.id);
        logger.log(msg, "server->client", { pd_tool_hidden: true });
        process.stdout.write(JSON.stringify(msg) + "\n");
        return;
      }
    }

    // --- Normal flow ---
    if (msg.id != null) retry.clearRequest(msg.id);
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
    // Flush PD usage data
    if (pdHandler) {
      try {
        await pdHandler.flushUsage();
      } catch {
        // Disk I/O or lock acquisition failure — best-effort, don't block exit
      }
    }

    // Drain retry state
    const { heldErrors, orphanedIds } = retry.drain();
    for (const heldError of heldErrors) {
      process.stdout.write(JSON.stringify(heldError) + "\n");
    }
    for (const id of orphanedIds) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id,
        error: { code: -32000, message: "Upstream process exited" },
      }) + "\n");
    }

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

  const handleSignal = () => {
    upstream.kill();
    // upstream.on("close") does full async cleanup (PD flush, retry drain, logger close, exit).
    // Safety timeout in case close event never fires.
    const safety = setTimeout(() => {
      if (pdHandler) pdHandler.flushUsageSync();
      logger.closeSync();
      process.exit(0);
    }, 5000);
    safety.unref();
  };

  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
}
