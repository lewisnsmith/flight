import { readFile, writeFile, copyFile, mkdir, rm } from "node:fs/promises";
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { compressOldSessions, garbageCollect } from "./lifecycle.js";
import { computeSummary, formatSummary } from "./summary.js";
import { readLogEntriesForSession } from "./log-commands.js";

interface HookEntry {
  type: string;
  command: string;
}

interface HookMatcher {
  matcher: string;
  hooks: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: string;
  [key: string]: unknown;
}

export interface ToolCallEntry {
  session_id: string;
  timestamp: string;
  tool_name: string;
  tool_input: unknown;
  tool_output: string | null;
  tool_output_truncated: boolean;
}

const FLIGHT_HOOK_MARKER = "flight hook";

function makeFlightHooks(): Record<string, HookMatcher[]> {
  return {
    SessionStart: [{
      matcher: "",
      hooks: [{
        type: "command",
        command: "flight hook session-start",
      }],
    }],
    SessionEnd: [{
      matcher: "",
      hooks: [{
        type: "command",
        command: "flight hook session-end",
      }],
    }],
    PostToolUse: [{
      matcher: "",
      hooks: [{
        type: "command",
        command: "flight hook post-tool-use",
      }],
    }],
  };
}

function hasFlightHook(matchers: HookMatcher[] | undefined): boolean {
  if (!matchers) return false;
  return matchers.some((m) =>
    m.hooks.some((h) => h.command.includes(FLIGHT_HOOK_MARKER))
  );
}

export async function installHooks(settingsPath: string): Promise<{ installed: boolean; backedUp: boolean }> {
  let settings: ClaudeSettings;
  try {
    const raw = await readFile(settingsPath, "utf-8");
    settings = JSON.parse(raw) as ClaudeSettings;
  } catch {
    settings = {};
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  const flightHooks = makeFlightHooks();
  let installed = false;

  for (const [event, matchers] of Object.entries(flightHooks)) {
    if (!hasFlightHook(settings.hooks[event])) {
      if (!settings.hooks[event]) {
        settings.hooks[event] = [];
      }
      settings.hooks[event].push(...matchers);
      installed = true;
    }
  }

  if (installed) {
    await copyFile(settingsPath, settingsPath + ".bak").catch(() => {});
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  }

  return { installed, backedUp: installed };
}

export async function removeHooks(settingsPath: string): Promise<{ removed: boolean }> {
  let settings: ClaudeSettings;
  try {
    const raw = await readFile(settingsPath, "utf-8");
    settings = JSON.parse(raw) as ClaudeSettings;
  } catch {
    return { removed: false };
  }

  if (!settings.hooks) return { removed: false };

  let removed = false;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(
      (m) => !m.hooks.some((h) => h.command.includes(FLIGHT_HOOK_MARKER))
    );
    if (settings.hooks[event].length < before) removed = true;
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  if (removed) {
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  }

  return { removed };
}

export async function handleSessionStart(stdinJson: string, logDir?: string): Promise<string> {
  let input: HookInput;
  try {
    input = JSON.parse(stdinJson) as HookInput;
  } catch {
    input = {};
  }

  const sessionId = input.session_id ?? `session_${Date.now()}`;
  const dir = logDir ?? join(homedir(), ".flight", "logs");
  await mkdir(dir, { recursive: true });

  const markerPath = join(dir, `.active_session`);
  await writeFile(markerPath, sessionId);

  return `[flight] Session ${sessionId} started`;
}

export async function handleSessionEnd(stdinJson: string, logDir?: string): Promise<string> {
  let input: HookInput;
  try {
    input = JSON.parse(stdinJson) as HookInput;
  } catch {
    input = {};
  }

  const sessionId = input.session_id ?? "unknown";
  const dir = logDir ?? join(homedir(), ".flight", "logs");

  // Remove active session marker
  const markerPath = join(dir, `.active_session`);
  await rm(markerPath, { force: true }).catch(() => {});

  // Generate session summary
  let output = `[flight] Session ${sessionId} ended`;
  try {
    const entries = await readLogEntriesForSession(sessionId);
    if (entries && entries.length > 0) {
      const summary = computeSummary(entries);
      output = `\n${formatSummary(summary)}\n`;
    }
  } catch {
    // Summary is best-effort
  }

  // Auto-compress and garbage collect (fire and forget)
  compressOldSessions(dir).catch(() => {});
  garbageCollect(dir).catch(() => {});

  return output;
}

const TOOL_OUTPUT_MAX = 4096;

export function handlePostToolUseSync(stdinJson: string, logDir?: string): string {
  let input: HookInput;
  try {
    input = JSON.parse(stdinJson) as HookInput;
  } catch {
    return "[flight] PostToolUse: invalid stdin JSON";
  }

  const dir = logDir ?? join(homedir(), ".flight", "logs");
  mkdirSync(dir, { recursive: true });

  // Resolve session ID: active marker > stdin > fallback
  let sessionId = "unknown_" + Date.now();
  try {
    const marker = readFileSync(join(dir, ".active_session"), "utf-8").trim();
    if (marker) sessionId = marker;
  } catch {
    if (input.session_id) sessionId = input.session_id;
  }

  const toolOutput = input.tool_output ?? null;
  const truncated = toolOutput !== null && toolOutput.length > TOOL_OUTPUT_MAX;

  const entry: ToolCallEntry = {
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    tool_name: input.tool_name ?? "unknown",
    tool_input: input.tool_input ?? null,
    tool_output: truncated ? toolOutput!.slice(0, TOOL_OUTPUT_MAX) : toolOutput,
    tool_output_truncated: truncated,
  };

  const filePath = join(dir, `${sessionId}_tools.jsonl`);
  appendFileSync(filePath, JSON.stringify(entry) + "\n");

  return `[flight] Recorded ${entry.tool_name}`;
}
