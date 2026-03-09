import { writeFile, appendFile, mkdir, statfs } from "node:fs/promises";
import { appendFileSync } from "node:fs";
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

export interface AlertEntry {
  timestamp: string;
  severity: "error" | "hallucination";
  method: string;
  tool_name?: string;
  message: string;
  session_id: string;
  call_id: string;
}

export interface SessionLogger {
  log(msg: JsonRpcMessage, direction: "client->server" | "server->client"): void;
  logError(source: string, message: string): void;
  close(): Promise<void>;
  closeSync(): void;
  onAlert?: (alert: AlertEntry) => void;
  readonly sessionId: string;
  readonly logPath: string;
}

export interface RedactionOptions {
  redactEnvVars?: string[];
  redactPatterns?: string[];
}

const DEFAULT_LOG_DIR = join(homedir(), ".flight", "logs");
const DEFAULT_ALERT_PATH = join(homedir(), ".flight", "alerts.jsonl");
const FLUSH_INTERVAL_MS = 100;
const MAX_QUEUE_DEPTH = 1000;
const MIN_DISK_SPACE_BYTES = 100 * 1024 * 1024; // 100MB
const MAX_LOG_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const HALLUCINATION_WINDOW_MS = 30_000; // Only flag hallucination hints within 30s of the error

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

function writeAlert(alert: AlertEntry): void {
  // Fire-and-forget append to alerts.jsonl
  appendFile(DEFAULT_ALERT_PATH, JSON.stringify(alert) + "\n").catch(() => {});
}

export function getAlertLogPath(): string {
  return DEFAULT_ALERT_PATH;
}

export async function createSessionLogger(logDir?: string, redactionOptions?: RedactionOptions): Promise<SessionLogger> {
  const dir = logDir ?? DEFAULT_LOG_DIR;
  const redact = buildRedactor(redactionOptions);
  const sessionId = `session_${formatTimestamp(new Date())}_${randomUUID().slice(0, 8)}`;
  const logPath = join(dir, `${sessionId}.jsonl`);

  await mkdir(dir, { recursive: true });

  let loggingEnabled = true;

  // Check disk space via fs.statfs (async, cross-platform)
  try {
    const stats = await statfs(dir);
    const availableBytes = stats.bavail * stats.bsize;
    if (availableBytes < MIN_DISK_SPACE_BYTES) {
      process.stderr.write(
        `[flight] Warning: low disk space (${Math.round(availableBytes / 1024 / 1024)}MB available). Logging disabled.\n`,
      );
      loggingEnabled = false;
    }
  } catch {
    // If statfs fails, proceed with logging enabled
  }

  // Create the log file
  if (loggingEnabled) {
    await writeFile(logPath, "");
  }

  const writeQueue: string[] = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let logSizeBytes = 0;
  let logSizeCapped = false;

  // Track pending requests for latency calculation
  const pendingRequests = new Map<string | number, PendingRequest>();
  // Track recent server responses for hallucination detection (concurrent-safe)
  interface RecentResponse {
    isError: boolean;
    method?: string;
    toolName?: string;
    timestamp: number;
  }
  const recentResponses: RecentResponse[] = [];
  const MAX_RECENT_RESPONSES = 10;

  let flushPromise: Promise<void> | null = null;

  async function flush() {
    if (!loggingEnabled || writeQueue.length === 0) return;
    // If a flush is already in progress, wait for it then flush remaining
    if (flushPromise) {
      await flushPromise;
      if (writeQueue.length === 0) return;
    }
    const batch = writeQueue.splice(0);
    flushPromise = appendFile(logPath, batch.join("")).catch((err) => {
      process.stderr.write(
        `[flight] Warning: failed to write log: ${err instanceof Error ? err.message : err}\n`,
      );
    });
    await flushPromise;
    flushPromise = null;
  }

  if (loggingEnabled) {
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  }

  function enqueue(line: string) {
    if (!loggingEnabled) return;
    if (logSizeCapped) return;
    if (writeQueue.length >= MAX_QUEUE_DEPTH) {
      process.stderr.write("[flight] Warning: log queue full, dropping entry\n");
      return;
    }
    const lineBytes = Buffer.byteLength(line + "\n");
    logSizeBytes += lineBytes;
    if (logSizeBytes > MAX_LOG_SIZE_BYTES) {
      logSizeCapped = true;
      process.stderr.write(`[flight] Warning: session log exceeded ${MAX_LOG_SIZE_BYTES / 1024 / 1024}MB cap. Logging disabled for this session.\n`);
      return;
    }
    writeQueue.push(line + "\n");
  }

  const logger: SessionLogger = {
    sessionId,
    logPath,
    onAlert: undefined,

    log(msg: JsonRpcMessage, direction: "client->server" | "server->client") {
      const now = Date.now();
      const callId = (msg.id != null ? String(msg.id) : randomUUID());
      let latencyMs = 0;
      let hallucinationHint: boolean | undefined;
      const toolName = extractToolName(msg);

      let prevErrorToolName: string | undefined;
      let prevErrorMethod: string | undefined;

      if (direction === "client->server") {
        // Hallucination detection: check if the most recent server response was an error
        // and this new request is for a different tool (not a retry)
        const lastResponse = recentResponses.length > 0
          ? recentResponses[recentResponses.length - 1]
          : undefined;
        if (lastResponse?.isError && (now - lastResponse.timestamp) < HALLUCINATION_WINDOW_MS) {
          prevErrorToolName = lastResponse.toolName;
          prevErrorMethod = lastResponse.method;
          const isRetry = msg.method === lastResponse.method && toolName === lastResponse.toolName;
          if (!isRetry) {
            hallucinationHint = true;
          }
        }

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

        // Track this response in the ordered list
        recentResponses.push({
          isError: !!msg.error,
          method: pending?.method,
          toolName: pending?.toolName,
          timestamp: now,
        });
        if (recentResponses.length > MAX_RECENT_RESPONSES) {
          recentResponses.shift();
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
        error: msg.error?.message ?? (msg.error ? "(no message)" : undefined),
        hallucination_hint: hallucinationHint,
        pd_active: false,
      };

      enqueue(redact(JSON.stringify(entry)));

      // Emit alerts for errors and hallucination hints
      if (direction === "server->client" && msg.error) {
        const alert: AlertEntry = {
          timestamp: entry.timestamp,
          severity: "error",
          method: entry.method,
          tool_name: entry.tool_name,
          message: msg.error.message ?? "(no message)",
          session_id: sessionId,
          call_id: callId,
        };
        writeAlert(alert);
        if (logger.onAlert) logger.onAlert(alert);
      }
      if (hallucinationHint) {
        const alert: AlertEntry = {
          timestamp: entry.timestamp,
          severity: "hallucination",
          method: entry.method,
          tool_name: entry.tool_name,
          message: `Agent proceeded after error on ${prevErrorToolName ?? prevErrorMethod ?? "unknown"} without retrying`,
          session_id: sessionId,
          call_id: callId,
        };
        writeAlert(alert);
        if (logger.onAlert) logger.onAlert(alert);
      }
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

    async close() {
      if (closed) return;
      closed = true;
      if (flushTimer) clearInterval(flushTimer);
      await flush();
    },

    closeSync() {
      if (closed) return;
      closed = true;
      if (flushTimer) clearInterval(flushTimer);
      if (loggingEnabled && writeQueue.length > 0) {
        const batch = writeQueue.splice(0);
        try {
          appendFileSync(logPath, batch.join(""));
        } catch {
          // Best-effort in signal handler
        }
      }
    },
  };

  return logger;
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
