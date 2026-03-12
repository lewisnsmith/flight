import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

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
  [key: string]: unknown;
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
  return `[flight] Session ${sessionId} ended`;
}
