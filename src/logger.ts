import { writeFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { extractToolName, type JsonRpcMessage } from "./json-rpc.js";

export interface LogEntry {
  session_id: string;
  call_id: string;
  timestamp: string;
  latency_ms: number;
  direction: "client->server" | "server->client";
  method: string;
  tool_name?: string;
  payload: unknown;
  error?: string;
  hallucination_hint?: boolean;
  pd_active: boolean;
}

export interface SessionLogger {
  log(msg: JsonRpcMessage, direction: "client->server" | "server->client"): void;
  logError(source: string, message: string): void;
  close(): void;
  readonly sessionId: string;
  readonly logPath: string;
}

export interface RedactionOptions {
  redactEnvVars?: string[];
  redactPatterns?: string[];
}

const DEFAULT_LOG_DIR = join(homedir(), ".flight", "logs");
const FLUSH_INTERVAL_MS = 100;
const MAX_QUEUE_DEPTH = 1000;
const MIN_DISK_SPACE_BYTES = 100 * 1024 * 1024; // 100MB

interface PendingRequest {
  timestamp: number;
  method: string;
  toolName?: string;
}

function buildRedactor(options?: RedactionOptions): (text: string) => string {
  const patterns: RegExp[] = [];

  if (options?.redactEnvVars) {
    for (const varName of options.redactEnvVars) {
      const value = process.env[varName];
      if (value) {
        patterns.push(new RegExp(escapeRegex(value), "g"));
      }
    }
  }

  if (options?.redactPatterns) {
    for (const pattern of options.redactPatterns) {
      patterns.push(new RegExp(pattern, "g"));
    }
  }

  if (patterns.length === 0) return (text) => text;

  return (text: string) => {
    let result = text;
    for (const re of patterns) {
      result = result.replace(re, "[REDACTED]");
    }
    return result;
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function createSessionLogger(logDir?: string, redactionOptions?: RedactionOptions): Promise<SessionLogger> {
  const dir = logDir ?? DEFAULT_LOG_DIR;
  const redact = buildRedactor(redactionOptions);
  const sessionId = `session_${formatTimestamp(new Date())}`;
  const logPath = join(dir, `${sessionId}.jsonl`);

  await mkdir(dir, { recursive: true });

  let loggingEnabled = true;

  // Check disk space via df
  try {
    const { execSync } = await import("node:child_process");
    const output = execSync(`df -k "${dir}" | tail -1`, { encoding: "utf-8" });
    const parts = output.trim().split(/\s+/);
    const availableKb = parseInt(parts[3], 10);
    if (!isNaN(availableKb) && availableKb * 1024 < MIN_DISK_SPACE_BYTES) {
      process.stderr.write(
        `[flight] Warning: low disk space (${Math.round(availableKb / 1024)}MB available). Logging disabled.\n`,
      );
      loggingEnabled = false;
    }
  } catch {
    // If df fails (e.g. Windows), proceed with logging enabled
  }

  // Create the log file
  if (loggingEnabled) {
    await writeFile(logPath, "");
  }

  const writeQueue: string[] = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  // Track pending requests for latency calculation
  const pendingRequests = new Map<string | number, PendingRequest>();
  // Track last response error for hallucination detection
  let lastResponseWasError = false;
  let lastErrorMethod: string | undefined;
  let lastErrorToolName: string | undefined;

  async function flush() {
    if (!loggingEnabled || writeQueue.length === 0) return;

    const batch = writeQueue.splice(0);
    try {
      await appendFile(logPath, batch.join(""));
    } catch (err) {
      process.stderr.write(
        `[flight] Warning: failed to write log: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }

  if (loggingEnabled) {
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  }

  function enqueue(line: string) {
    if (!loggingEnabled) return;
    if (writeQueue.length >= MAX_QUEUE_DEPTH) {
      process.stderr.write("[flight] Warning: log queue full, dropping entry\n");
      return;
    }
    writeQueue.push(line + "\n");
  }

  return {
    sessionId,
    logPath,

    log(msg: JsonRpcMessage, direction: "client->server" | "server->client") {
      const now = Date.now();
      const callId = (msg.id != null ? String(msg.id) : randomUUID());
      let latencyMs = 0;
      let hallucinationHint: boolean | undefined;
      const toolName = extractToolName(msg);

      if (direction === "client->server") {
        // Hallucination detection: client sent a new request after server returned an error
        // and it's not a retry of the same tool call
        if (lastResponseWasError) {
          const isRetry = msg.method === lastErrorMethod && toolName === lastErrorToolName;
          if (!isRetry) {
            hallucinationHint = true;
          }
        }
        lastResponseWasError = false;
        lastErrorMethod = undefined;

        if (msg.id != null) {
          // Track request for latency
          pendingRequests.set(msg.id, {
            timestamp: now,
            method: msg.method ?? "unknown",
            toolName,
          });
        }
      }

      if (direction === "server->client" && msg.id != null) {
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          latencyMs = now - pending.timestamp;
          pendingRequests.delete(msg.id);
        }

        // Track if this response was an error (and which method/tool it was for)
        if (msg.error) {
          lastResponseWasError = true;
          lastErrorMethod = pending?.method;
          lastErrorToolName = pending?.toolName;
        } else {
          lastResponseWasError = false;
          lastErrorMethod = undefined;
          lastErrorToolName = undefined;
        }
      }

      const entry: LogEntry = {
        session_id: sessionId,
        call_id: callId,
        timestamp: new Date(now).toISOString(),
        latency_ms: latencyMs,
        direction,
        method: msg.method ?? (msg.result !== undefined || msg.error !== undefined ? "response" : "unknown"),
        tool_name: toolName ?? undefined,
        payload: msg,
        error: msg.error?.message,
        hallucination_hint: hallucinationHint,
        pd_active: false,
      };

      enqueue(redact(JSON.stringify(entry)));
    },

    logError(source: string, message: string) {
      const entry: LogEntry = {
        session_id: sessionId,
        call_id: randomUUID(),
        timestamp: new Date().toISOString(),
        latency_ms: 0,
        direction: "server->client",
        method: source,
        payload: { error: message },
        error: message,
        pd_active: false,
      };
      enqueue(redact(JSON.stringify(entry)));
    },

    close() {
      if (closed) return;
      closed = true;
      if (flushTimer) clearInterval(flushTimer);
      // Final synchronous-ish flush
      flush();
    },
  };
}

function formatTimestamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}${m}${d}_${h}${min}${s}`;
}
