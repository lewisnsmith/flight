import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { watch } from "node:fs";
import type { LogEntry } from "./logger.js";

const DEFAULT_LOG_DIR = join(homedir(), ".flight", "logs");

// --- Colors ---

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

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
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function sessionIdFromFile(filename: string): string {
  return filename.replace(".jsonl", "").replace(".gz", "");
}

async function readLogEntries(sessionFile: string): Promise<LogEntry[]> {
  const filePath = join(DEFAULT_LOG_DIR, sessionFile);
  const content = await readFile(filePath, "utf-8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
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

  // Watch for new entries
  let lastSize = 0;
  try {
    const s = await stat(filePath);
    lastSize = s.size;
  } catch {
    // ignore
  }

  const watcher = watch(filePath, async () => {
    try {
      const s = await stat(filePath);
      if (s.size <= lastSize) return;

      const content = await readFile(filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      // Only print new lines
      const allEntries = lines.map((l) => JSON.parse(l) as LogEntry);
      const newEntries = allEntries.slice(-Math.max(1, allEntries.length - Math.floor(lastSize / 100)));

      for (const entry of newEntries) {
        console.log(formatEntryLine(entry));
      }
      lastSize = s.size;
    } catch {
      // ignore read errors during active writing
    }
  });

  // Keep alive until Ctrl+C
  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });

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
    entries = entries.filter((e) => e.tool_name === options.tool || e.method.includes(options.tool!));
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
