import { spawn, type ChildProcess } from "node:child_process";
import { parseJsonRpcStream } from "./json-rpc.js";
import { createSessionLogger } from "./logger.js";

export interface ProxyOptions {
  command: string;
  args: string[];
  logDir?: string;
}

export async function startProxy(options: ProxyOptions): Promise<void> {
  const logger = await createSessionLogger(options.logDir);

  const upstream: ChildProcess = spawn(options.command, options.args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!upstream.stdin || !upstream.stdout || !upstream.stderr) {
    throw new Error("Failed to open stdio pipes to upstream process");
  }

  // Client → Upstream: forward stdin and log
  const clientParser = parseJsonRpcStream(process.stdin);
  clientParser.on("message", (msg) => {
    logger.log(msg, "client->server");
    const data = JSON.stringify(msg) + "\n";
    upstream.stdin!.write(data);
  });
  clientParser.on("error", (err) => {
    logger.logError("client-parse-error", err.message);
  });

  // Upstream → Client: forward stdout and log
  const upstreamParser = parseJsonRpcStream(upstream.stdout);
  upstreamParser.on("message", (msg) => {
    logger.log(msg, "server->client");
    const data = JSON.stringify(msg) + "\n";
    process.stdout.write(data);
  });
  upstreamParser.on("error", (err) => {
    logger.logError("upstream-parse-error", err.message);
  });

  // Capture upstream stderr
  upstream.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      logger.logError("upstream-stderr", text);
      process.stderr.write(chunk);
    }
  });

  // Handle upstream exit
  upstream.on("close", (code) => {
    logger.close();
    process.exit(code ?? 0);
  });

  upstream.on("error", (err) => {
    logger.logError("upstream-spawn-error", err.message);
    logger.close();
    process.exit(1);
  });

  // Handle client disconnect
  process.stdin.on("end", () => {
    upstream.kill();
  });

  process.on("SIGTERM", () => {
    upstream.kill();
    logger.close();
  });

  process.on("SIGINT", () => {
    upstream.kill();
    logger.close();
  });
}
