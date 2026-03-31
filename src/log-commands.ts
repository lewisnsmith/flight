import { readdir, readFile, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { watch, createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import type { LogEntry, AlertEntry } from "./logger.js";
import { getAlertLogPath } from "./logger.js";
import type { ToolCallEntry } from "./hooks.js";
import { DEFAULT_LOG_DIR, C } from "./shared.js";
import { formatDuration } from "./summary.js";

function statusColor(entry: LogEntry): string {
  if (entry.hallucination_hint) return C.yellow;
  if (entry.error) return C.red;
  return C.green;
}

function directionArrow(entry: LogEntry): string {
  return entry.direction === "client->server"
    ? `${C.blue}↑${C.reset}`
    : `${C.cyan}↓${C.reset}`;
}

// --- Helpers ---

async function getLogFiles(): Promise<string[]> {
  try {
    const files = await readdir(DEFAULT_LOG_DIR);
    return files
      .filter((f) => (f.endsWith(".jsonl") || f.endsWith(".jsonl.gz")) && !f.includes("_tools."))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function sessionIdFromFile(filename: string): string {
  return filename.replace(".jsonl", "").replace(".gz", "");
}

async function readGzFile(filePath: string): Promise<string> {
  const chunks: Buffer[] = [];
  const collector = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await pipeline(createReadStream(filePath), createGunzip(), collector);
  return Buffer.concat(chunks).toString("utf-8");
}

function parseLogLines(content: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // Skip malformed lines (truncated writes, partial flushes)
    }
  }
  return entries;
}

async function readLogEntries(sessionFile: string): Promise<LogEntry[]> {
  const filePath = join(DEFAULT_LOG_DIR, sessionFile);
  const content = sessionFile.endsWith(".gz")
    ? await readGzFile(filePath)
    : await readFile(filePath, "utf-8");
  return parseLogLines(content);
}

async function findSessionFile(sessionId?: string): Promise<string | null> {
  const files = await getLogFiles();
  if (files.length === 0) return null;

  if (!sessionId) return files[0]; // most recent

  const match = files.find((f) => f.includes(sessionId));
  return match ?? null;
}

function formatTime(timestamp: string): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatEntryLine(entry: LogEntry): string {
  const time = `${C.dim}[${formatTime(entry.timestamp)}]${C.reset}`;
  const arrow = directionArrow(entry);
  const color = statusColor(entry);
  const tool = entry.tool_name ? `/${entry.tool_name}` : "";
  const method = `${entry.method}${tool}`;
  const latency = entry.latency_ms > 0 ? ` ${C.dim}(${entry.latency_ms}ms)${C.reset}` : "";
  const err = entry.error ? ` ${C.red}ERROR: ${entry.error}${C.reset}` : "";
  const hint = entry.hallucination_hint ? ` ${C.yellow}⚠ HALLUCINATION HINT${C.reset}` : "";

  return `${time} ${arrow} ${color}${method}${C.reset}${latency}${err}${hint}`;
}

// --- Public helpers ---

export async function readLogEntriesForSession(sessionId?: string): Promise<LogEntry[] | null> {
  const file = await findSessionFile(sessionId);
  if (!file) return null;
  return readLogEntries(file);
}

export async function readAllRecentSessions(maxSessions: number = 10): Promise<LogEntry[][]> {
  const files = await getLogFiles();
  const sessions: LogEntry[][] = [];
  for (const file of files.slice(0, maxSessions)) {
    try {
      const entries = await readLogEntries(file);
      if (entries.length > 0) sessions.push(entries);
    } catch {
      // Skip unreadable sessions
    }
  }
  return sessions;
}

// --- Commands ---

export async function listSessions(): Promise<void> {
  const files = await getLogFiles();

  if (files.length === 0) {
    console.log("No sessions found. Start a proxy with: flight proxy --cmd <server>");
    return;
  }

  // Header
  console.log(
    `${C.dim}${"Session ID".padEnd(30)} ${"Date".padEnd(20)} ${"Calls".padEnd(8)} ${"Errors".padEnd(8)}${C.reset}`,
  );
  console.log(`${C.dim}${"─".repeat(70)}${C.reset}`);

  for (const file of files) {
    const sessionId = sessionIdFromFile(file);
    try {
      const entries = await readLogEntries(file);
      const fileStat = await stat(join(DEFAULT_LOG_DIR, file));
      const date = fileStat.mtime.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
      const calls = entries.length;
      const errors = entries.filter((e) => e.error).length;
      const errStr = errors > 0 ? `${C.red}${errors}${C.reset}` : `${C.dim}0${C.reset}`;

      console.log(`${sessionId.padEnd(30)} ${date.padEnd(20)} ${String(calls).padEnd(8)} ${errStr}`);
    } catch {
      console.log(`${sessionId.padEnd(30)} ${C.dim}(unreadable)${C.reset}`);
    }
  }
}

export async function tailSession(sessionId?: string): Promise<void> {
  const file = await findSessionFile(sessionId);

  if (!file) {
    console.log("No session found. Start a proxy with: flight proxy --cmd <server>");
    return;
  }

  const filePath = join(DEFAULT_LOG_DIR, file);
  console.log(`${C.green}●${C.reset} Tailing ${sessionIdFromFile(file)} — ${filePath}`);
  console.log(`${C.dim}  Press Ctrl+C to stop${C.reset}\n`);

  // Print existing entries
  try {
    const entries = await readLogEntries(file);
    for (const entry of entries) {
      console.log(formatEntryLine(entry));
    }
  } catch {
    // File might be empty
  }

  // Watch for new entries — track by line count, not byte size
  let lastSize = 0;
  try {
    const s = await stat(filePath);
    lastSize = s.size;
  } catch {
    // ignore
  }

  let partialLine = "";

  const watcher = watch(filePath, async () => {
    try {
      const s = await stat(filePath);
      if (s.size <= lastSize) return;

      // Read only new bytes from the file
      const fd = await open(filePath, "r");
      try {
        const newBytes = Buffer.alloc(s.size - lastSize);
        await fd.read(newBytes, 0, newBytes.length, lastSize);
        const chunk = partialLine + newBytes.toString("utf-8");
        const lines = chunk.split("\n");

        // Last element may be a partial line (no trailing newline yet)
        partialLine = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as LogEntry;
            console.log(formatEntryLine(entry));
          } catch {
            // skip malformed lines during active writing
          }
        }
        lastSize = s.size;
      } finally {
        await fd.close();
      }
    } catch {
      // ignore read errors during active writing
    }
  });

  // Keep alive until terminated
  const cleanup = () => {
    watcher.close();
    process.exit(0);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  await new Promise(() => {}); // block forever
}

export async function viewSession(sessionId: string): Promise<void> {
  const file = await findSessionFile(sessionId);

  if (!file) {
    console.error(`Session not found: ${sessionId}`);
    process.exit(1);
  }

  const entries = await readLogEntries(file);

  console.log(`${C.cyan}Session:${C.reset} ${sessionIdFromFile(file)}`);
  console.log(`${C.cyan}Calls:${C.reset}   ${entries.length}`);
  console.log(`${C.cyan}Errors:${C.reset}  ${entries.filter((e) => e.error).length}`);
  console.log(`${C.cyan}Hints:${C.reset}   ${entries.filter((e) => e.hallucination_hint).length}`);
  console.log();

  for (const entry of entries) {
    console.log(formatEntryLine(entry));
  }
}

export async function filterSessions(options: {
  tool?: string;
  errors?: boolean;
  hallucinations?: boolean;
  session?: string;
}): Promise<void> {
  const file = await findSessionFile(options.session);

  if (!file) {
    console.error("No session found.");
    process.exit(1);
  }

  let entries = await readLogEntries(file);

  if (options.tool) {
    const toolFilter = options.tool;
    entries = entries.filter((e) => e.tool_name === toolFilter || e.method.includes(toolFilter));
  }
  if (options.errors) {
    entries = entries.filter((e) => e.error);
  }
  if (options.hallucinations) {
    entries = entries.filter((e) => e.hallucination_hint);
  }

  if (entries.length === 0) {
    console.log("No matching entries found.");
    return;
  }

  console.log(`${C.dim}Found ${entries.length} matching entries in ${sessionIdFromFile(file)}${C.reset}\n`);

  for (const entry of entries) {
    console.log(formatEntryLine(entry));
  }
}

export async function inspectCall(callId: string, sessionId?: string): Promise<void> {
  const files = sessionId ? [await findSessionFile(sessionId)].filter(Boolean) as string[] : await getLogFiles();

  for (const file of files) {
    const entries = await readLogEntries(file);
    const match = entries.find((e) => e.call_id === callId || e.call_id.startsWith(callId));

    if (match) {
      console.log(`${C.cyan}Session:${C.reset}   ${match.session_id}`);
      console.log(`${C.cyan}Call ID:${C.reset}   ${match.call_id}`);
      console.log(`${C.cyan}Time:${C.reset}      ${match.timestamp}`);
      console.log(`${C.cyan}Direction:${C.reset} ${match.direction}`);
      console.log(`${C.cyan}Method:${C.reset}    ${match.method}`);
      if (match.tool_name) console.log(`${C.cyan}Tool:${C.reset}      ${match.tool_name}`);
      console.log(`${C.cyan}Latency:${C.reset}   ${match.latency_ms}ms`);
      if (match.error) console.log(`${C.red}Error:${C.reset}     ${match.error}`);
      if (match.hallucination_hint) console.log(`${C.yellow}⚠ Hallucination hint${C.reset}`);
      console.log();
      console.log(`${C.dim}--- Payload ---${C.reset}`);
      console.log(JSON.stringify(match.payload, null, 2));
      return;
    }
  }

  console.error(`Call not found: ${callId}`);
  process.exit(1);
}

export async function listAlerts(options: { limit?: number; session?: string } = {}): Promise<void> {
  const alertPath = getAlertLogPath();
  let content: string;

  try {
    content = await readFile(alertPath, "utf-8");
  } catch {
    console.log("No alerts found. Alerts are recorded when tool calls fail or hallucination patterns are detected.");
    return;
  }

  let alerts: AlertEntry[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line) continue;
    try {
      alerts.push(JSON.parse(line) as AlertEntry);
    } catch {
      // Skip malformed lines
    }
  }

  if (options.session) {
    alerts = alerts.filter((a) => a.session_id.includes(options.session!));
  }

  const limit = options.limit ?? 50;
  alerts = alerts.slice(-limit);

  if (alerts.length === 0) {
    console.log("No alerts found.");
    return;
  }

  // Header
  console.log(
    `${C.dim}${"Time".padEnd(12)} ${"Severity".padEnd(15)} ${"Tool/Method".padEnd(25)} ${"Message"}${C.reset}`,
  );
  console.log(`${C.dim}${"─".repeat(80)}${C.reset}`);

  for (const alert of alerts) {
    const time = formatTime(alert.timestamp);
    const sevColor = alert.severity === "hallucination" ? C.yellow : C.red;
    const sev = `${sevColor}${alert.severity}${C.reset}`;
    const tool = alert.tool_name ?? alert.method;
    const msg = alert.message.length > 50 ? alert.message.slice(0, 47) + "..." : alert.message;

    console.log(`${C.dim}${time}${C.reset} ${sev.padEnd(15 + sevColor.length + C.reset.length)} ${tool.padEnd(25)} ${msg}`);
  }

  console.log(`\n${C.dim}Showing ${alerts.length} alert(s)${C.reset}`);
}

// --- Tool call log commands ---

async function getToolLogFiles(): Promise<string[]> {
  try {
    const files = await readdir(DEFAULT_LOG_DIR);
    return files
      .filter((f) => f.endsWith("_tools.jsonl"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export async function readToolCallsForSession(sessionId?: string): Promise<ToolCallEntry[]> {
  const files = await getToolLogFiles();
  if (files.length === 0) return [];

  let targetFile: string | undefined;
  if (sessionId) {
    targetFile = files.find((f) => f.includes(sessionId));
  } else {
    targetFile = files[0]; // most recent
  }

  if (!targetFile) return [];

  try {
    const content = await readFile(join(DEFAULT_LOG_DIR, targetFile), "utf-8");
    const entries: ToolCallEntry[] = [];
    for (const line of content.trim().split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as ToolCallEntry);
      } catch {
        // skip malformed
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export async function listToolCalls(
  sessionId?: string,
  options?: { tool?: string; limit?: number },
): Promise<void> {
  let entries = await readToolCallsForSession(sessionId);

  if (entries.length === 0) {
    console.log("No tool call data found. Tool calls are recorded via the PostToolUse hook.");
    return;
  }

  if (options?.tool) {
    const filter = options.tool;
    entries = entries.filter((e) => e.tool_name === filter || e.tool_name.includes(filter));
  }

  const limit = options?.limit ?? 50;
  if (entries.length > limit) {
    entries = entries.slice(-limit);
  }

  // Header
  console.log(
    `${C.dim}${"Time".padEnd(12)} ${"Tool".padEnd(25)} ${"Input".padEnd(60)} ${"Output"}${C.reset}`,
  );
  console.log(`${C.dim}${"─".repeat(140)}${C.reset}`);

  for (const entry of entries) {
    const time = formatTime(entry.timestamp);
    const tool = entry.tool_name.length > 24 ? entry.tool_name.slice(0, 22) + ".." : entry.tool_name;
    const inputStr = truncateStr(JSON.stringify(entry.tool_input), 58);
    const outputStr = entry.tool_output
      ? truncateStr(entry.tool_output.replace(/\n/g, "\\n"), 38) + (entry.tool_output_truncated ? " [...]" : "")
      : `${C.dim}(none)${C.reset}`;

    console.log(`${C.dim}${time}${C.reset} ${C.cyan}${tool.padEnd(25)}${C.reset} ${inputStr.padEnd(60)} ${outputStr}`);
  }

  console.log(`\n${C.dim}Showing ${entries.length} tool call(s)${C.reset}`);
}

function truncateStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

function isToolError(output: string): boolean {
  return (
    output.includes('"isError":true') ||
    output.includes('"error":') ||
    output.startsWith("Error:") ||
    output.startsWith("error:")
  );
}

// --- Audit command (designed for /flight-log slash command) ---

async function resolveCurrentSessionId(): Promise<string | null> {
  try {
    const markerPath = join(DEFAULT_LOG_DIR, ".active_session");
    const content = await readFile(markerPath, "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

interface AuditStats {
  total: number;
  byTool: Map<string, { count: number; errors: number }>;
  errors: ToolCallEntry[];
  timeline: ToolCallEntry[];
}

function computeAuditStats(entries: ToolCallEntry[]): AuditStats {
  const byTool = new Map<string, { count: number; errors: number }>();
  const errors: ToolCallEntry[] = [];

  for (const entry of entries) {
    const stats = byTool.get(entry.tool_name) ?? { count: 0, errors: 0 };
    stats.count++;
    const output = entry.tool_output ?? "";
    if (isToolError(output)) {
      stats.errors++;
      errors.push(entry);
    }
    byTool.set(entry.tool_name, stats);
  }

  return { total: entries.length, byTool, errors, timeline: entries };
}

export async function auditSession(sessionId?: string): Promise<void> {
  // Resolve session: explicit > active marker > most recent file
  const activeSession = await resolveCurrentSessionId();
  const resolvedId = sessionId ?? activeSession ?? undefined;

  const entries = await readToolCallsForSession(resolvedId);

  if (entries.length === 0) {
    console.log("No tool call data found for this session.");
    console.log("Tool calls are recorded via the PostToolUse hook — make sure Flight is set up.");
    return;
  }

  const sid = entries[0].session_id;
  const stats = computeAuditStats(entries);

  // --- Header ---
  const firstTs = entries[0].timestamp;
  const lastTs = entries[entries.length - 1].timestamp;
  const durationMs = new Date(lastTs).getTime() - new Date(firstTs).getTime();
  const durationStr = formatDuration(durationMs);

  console.log(`${C.cyan}━━━ Flight Audit ━━━${C.reset}`);
  console.log(`${C.cyan}Session:${C.reset}  ${sid}`);
  console.log(`${C.cyan}Duration:${C.reset} ${durationStr} (${formatTime(firstTs)} → ${formatTime(lastTs)})`);
  console.log(`${C.cyan}Calls:${C.reset}    ${stats.total}`);
  console.log(`${C.cyan}Errors:${C.reset}   ${stats.errors.length > 0 ? C.red + stats.errors.length + C.reset : "0"}`);
  console.log();

  // --- Tool breakdown ---
  console.log(`${C.cyan}Tool Breakdown:${C.reset}`);
  const sorted = [...stats.byTool.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [name, s] of sorted) {
    const bar = "█".repeat(Math.min(Math.ceil(s.count / stats.total * 30), 30));
    const errStr = s.errors > 0 ? ` ${C.red}(${s.errors} err)${C.reset}` : "";
    console.log(`  ${C.cyan}${name.padEnd(25)}${C.reset} ${C.dim}${bar}${C.reset} ${s.count}${errStr}`);
  }
  console.log();

  // --- Errors section ---
  if (stats.errors.length > 0) {
    console.log(`${C.red}━━━ Errors (${stats.errors.length}) ━━━${C.reset}`);
    for (const err of stats.errors) {
      const time = formatTime(err.timestamp);
      const inputStr = truncateStr(JSON.stringify(err.tool_input), 80);
      const outputStr = err.tool_output
        ? truncateStr(err.tool_output.replace(/\n/g, "\\n"), 120)
        : "(no output)";
      console.log(`  ${C.dim}${time}${C.reset} ${C.red}${err.tool_name}${C.reset}`);
      console.log(`    ${C.dim}Input:${C.reset}  ${inputStr}`);
      console.log(`    ${C.dim}Output:${C.reset} ${outputStr}`);
      console.log();
    }
  }

  // --- Full timeline ---
  console.log(`${C.cyan}━━━ Timeline (${entries.length} calls) ━━━${C.reset}`);
  console.log(
    `${C.dim}${"#".padStart(4)} ${"Time".padEnd(12)} ${"Tool".padEnd(25)} ${"Input (summary)".padEnd(60)} ${"Status"}${C.reset}`,
  );
  console.log(`${C.dim}${"─".repeat(120)}${C.reset}`);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const time = formatTime(entry.timestamp);
    const tool = entry.tool_name.length > 24 ? entry.tool_name.slice(0, 22) + ".." : entry.tool_name;
    const inputStr = truncateStr(summarizeInput(entry), 58);
    const output = entry.tool_output ?? "";
    const status = isToolError(output)
      ? `${C.red}ERR${C.reset}`
      : `${C.green}OK${C.reset}`;

    console.log(
      `${C.dim}${String(i + 1).padStart(4)}${C.reset} ${C.dim}${time}${C.reset} ${C.cyan}${tool.padEnd(25)}${C.reset} ${inputStr.padEnd(60)} ${status}`,
    );
  }

  console.log();
  console.log(`${C.dim}End of audit. ${stats.total} tool calls, ${stats.errors.length} errors.${C.reset}`);
}

export async function verboseSession(sessionId?: string): Promise<void> {
  const activeSession = await resolveCurrentSessionId();
  const resolvedId = sessionId ?? activeSession ?? undefined;

  const entries = await readToolCallsForSession(resolvedId);

  if (entries.length === 0) {
    console.log("No tool call data found for this session.");
    console.log("Tool calls are recorded via the PostToolUse hook — make sure Flight is set up.");
    return;
  }

  const sid = entries[0].session_id;
  const stats = computeAuditStats(entries);

  // --- Header ---
  const firstTs = entries[0].timestamp;
  const lastTs = entries[entries.length - 1].timestamp;
  const durationMs = new Date(lastTs).getTime() - new Date(firstTs).getTime();
  const durationStr = formatDuration(durationMs);

  console.log(`${C.cyan}━━━ Flight Verbose Log ━━━${C.reset}`);
  console.log(`${C.cyan}Session:${C.reset}  ${sid}`);
  console.log(`${C.cyan}Duration:${C.reset} ${durationStr} (${formatTime(firstTs)} → ${formatTime(lastTs)})`);
  console.log(`${C.cyan}Calls:${C.reset}    ${stats.total}`);
  console.log(`${C.cyan}Errors:${C.reset}   ${stats.errors.length > 0 ? C.red + stats.errors.length + C.reset : "0"}`);
  console.log();

  // --- Full timeline with complete payloads ---
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const time = formatTime(entry.timestamp);
    const output = entry.tool_output ?? "";
    const status = isToolError(output)
      ? `${C.red}ERR${C.reset}`
      : `${C.green}OK${C.reset}`;

    console.log(`${C.cyan}━━━ #${i + 1} [${time}] ${entry.tool_name} ${status} ━━━${C.reset}`);

    // Full input
    console.log(`${C.dim}Input:${C.reset}`);
    if (entry.tool_input !== null && entry.tool_input !== undefined) {
      console.log(typeof entry.tool_input === "string"
        ? entry.tool_input
        : JSON.stringify(entry.tool_input, null, 2));
    } else {
      console.log(`${C.dim}(none)${C.reset}`);
    }

    // Full output
    console.log(`${C.dim}Output:${C.reset}`);
    if (output) {
      console.log(output + (entry.tool_output_truncated ? `\n${C.yellow}[truncated]${C.reset}` : ""));
    } else {
      console.log(`${C.dim}(none)${C.reset}`);
    }

    console.log();
  }

  console.log(`${C.dim}End of verbose log. ${stats.total} tool calls, ${stats.errors.length} errors.${C.reset}`);
}

/** Produce a human-readable summary of tool input */
function summarizeInput(entry: ToolCallEntry): string {
  const input = entry.tool_input;
  if (input === null || input === undefined) return "(none)";
  if (typeof input === "string") return input;
  if (typeof input !== "object") return String(input);

  const obj = input as Record<string, unknown>;

  // Common patterns for Claude Code tools
  if (obj.command && typeof obj.command === "string") {
    return `$ ${obj.command}`;
  }
  if (obj.file_path && typeof obj.file_path === "string") {
    const p = obj.file_path as string;
    // Show just the filename or last path segments
    const parts = p.split("/");
    return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : p;
  }
  if (obj.pattern && typeof obj.pattern === "string") {
    return `/${obj.pattern}/` + (obj.path ? ` in ${truncateStr(String(obj.path), 30)}` : "");
  }
  if (obj.prompt && typeof obj.prompt === "string") {
    return truncateStr(obj.prompt as string, 58);
  }

  // Fallback: stringify
  return truncateStr(JSON.stringify(input), 58);
}
