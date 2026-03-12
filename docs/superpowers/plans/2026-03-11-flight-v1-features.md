# Flight v1.0 Features Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four features to Flight Proxy — zero-config setup with Claude Code hooks, inline alerts + smart summary, export + auto-cleanup, and progressive disclosure for token savings.

**Architecture:** Each feature is a self-contained module added to the existing STDIO proxy architecture. Features build on each other: setup (Task 1) enables hooks, summary (Task 3) feeds into auto-cleanup (Task 5), and PD (Task 7) uses the stats module (Task 8). All new modules follow existing patterns: pure functions, closure-based state, Vitest tests, Commander.js CLI registration.

**Tech Stack:** Node.js 20+, TypeScript, Vitest, Commander.js, tsup. No new dependencies — everything uses Node.js built-ins (fs, zlib, crypto, readline).

---

## Chunk 1: Zero-Config Setup + Hook Integration

### Task 1: `flight setup` Command

**Files:**
- Create: `src/setup.ts`
- Create: `src/hooks.ts`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Test: `test/setup.test.ts`
- Test: `test/hooks.test.ts`

---

- [ ] **Step 1: Write failing test for `installHooks`**

```typescript
// test/hooks.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installHooks, removeHooks } from "../src/hooks.js";

describe("installHooks", () => {
  const testDir = join(tmpdir(), `flight-hooks-${Date.now()}`);
  const settingsPath = join(testDir, ".claude", "settings.json");

  afterEach(async () => {
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("installs SessionStart and SessionEnd hooks into settings.json", async () => {
    await mkdir(join(testDir, ".claude"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({}));

    await installHooks(settingsPath);

    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.SessionEnd).toBeDefined();
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("flight");
  });

  it("preserves existing settings when installing hooks", async () => {
    await mkdir(join(testDir, ".claude"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ permissions: { allow: ["Read"] } }));

    await installHooks(settingsPath);

    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(settings.permissions.allow).toEqual(["Read"]);
    expect(settings.hooks.SessionStart).toBeDefined();
  });

  it("does not duplicate hooks if already installed", async () => {
    await mkdir(join(testDir, ".claude"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({}));

    await installHooks(settingsPath);
    await installHooks(settingsPath);

    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    // Should only have one SessionStart entry group
    const flightHooks = settings.hooks.SessionStart.filter(
      (h: Record<string, unknown>) => JSON.stringify(h).includes("flight")
    );
    expect(flightHooks.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/hooks.test.ts`
Expected: FAIL — cannot resolve `../src/hooks.js`

- [ ] **Step 3: Implement `installHooks` and `removeHooks`**

```typescript
// src/hooks.ts
import { readFile, writeFile, copyFile } from "node:fs/promises";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/hooks.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for `removeHooks`**

Add to `test/hooks.test.ts`:

```typescript
describe("removeHooks", () => {
  const testDir2 = join(tmpdir(), `flight-hooks-rm-${Date.now()}`);
  const settingsPath2 = join(testDir2, ".claude", "settings.json");

  afterEach(async () => {
    try { await rm(testDir2, { recursive: true }); } catch { /* ignore */ }
  });

  it("removes flight hooks from settings", async () => {
    await mkdir(join(testDir2, ".claude"), { recursive: true });
    await writeFile(settingsPath2, JSON.stringify({}));

    await installHooks(settingsPath2);
    const result = await removeHooks(settingsPath2);

    expect(result.removed).toBe(true);
    const settings = JSON.parse(await readFile(settingsPath2, "utf-8"));
    expect(settings.hooks).toBeUndefined();
  });

  it("returns removed: false when no hooks present", async () => {
    await mkdir(join(testDir2, ".claude"), { recursive: true });
    await writeFile(settingsPath2, JSON.stringify({ permissions: {} }));

    const result = await removeHooks(settingsPath2);
    expect(result.removed).toBe(false);
  });
});
```

- [ ] **Step 6: Run test to verify removeHooks passes**

Run: `npx vitest run test/hooks.test.ts`
Expected: PASS

- [ ] **Step 7: Write failing test for `setup` orchestrator**

```typescript
// test/setup.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSetup } from "../src/setup.js";

describe("runSetup", () => {
  const testDir = join(tmpdir(), `flight-setup-${Date.now()}`);

  afterEach(async () => {
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("wraps MCP servers and installs hooks", async () => {
    const claudeDir = join(testDir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify({}));
    await writeFile(join(testDir, ".claude.json"), JSON.stringify({
      mcpServers: {
        myserver: { command: "my-mcp", args: ["--flag"], type: "stdio" },
      },
    }));

    const result = await runSetup({
      homeDir: testDir,
      settingsPath: join(claudeDir, "settings.json"),
      claudeCodeConfigPath: join(testDir, ".claude.json"),
    });

    expect(result.hooksInstalled).toBe(true);
    expect(result.serversWrapped).toBe(1);

    // Verify MCP config was wrapped
    const config = JSON.parse(await readFile(join(testDir, ".claude.json"), "utf-8"));
    expect(config.mcpServers.myserver.command).toBe("flight");

    // Verify hooks were installed
    const settings = JSON.parse(await readFile(join(claudeDir, "settings.json"), "utf-8"));
    expect(settings.hooks.SessionStart).toBeDefined();
  });

  it("works with no existing MCP config", async () => {
    const claudeDir = join(testDir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify({}));

    const result = await runSetup({
      homeDir: testDir,
      settingsPath: join(claudeDir, "settings.json"),
      claudeCodeConfigPath: join(testDir, ".claude.json"),
    });

    expect(result.hooksInstalled).toBe(true);
    expect(result.serversWrapped).toBe(0);
  });
});
```

- [ ] **Step 8: Implement `runSetup`**

```typescript
// src/setup.ts
import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { wrapWithFlight } from "./init.js";
import { installHooks, removeHooks } from "./hooks.js";

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
}

interface ClaudeCodeConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export interface SetupOptions {
  homeDir?: string;
  settingsPath?: string;
  claudeCodeConfigPath?: string;
}

export interface SetupResult {
  hooksInstalled: boolean;
  serversWrapped: number;
  serverNames: string[];
  configBackedUp: boolean;
}

export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const home = options.homeDir ?? homedir();
  const settingsPath = options.settingsPath ?? join(home, ".claude", "settings.json");
  const configPath = options.claudeCodeConfigPath ?? join(home, ".claude.json");
  const flightDir = join(home, ".flight");

  await mkdir(flightDir, { recursive: true });

  // 1. Install Claude Code hooks
  const hookResult = await installHooks(settingsPath);

  // 2. Wrap MCP server configs
  let serversWrapped = 0;
  let serverNames: string[] = [];
  let configBackedUp = false;

  try {
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as ClaudeCodeConfig;

    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      const wrapped = wrapWithFlight(config.mcpServers);

      // Count how many actually changed
      for (const name of Object.keys(wrapped)) {
        if (wrapped[name].command === "flight" && config.mcpServers[name].command !== "flight") {
          serversWrapped++;
        }
      }

      serverNames = Object.keys(config.mcpServers);

      if (serversWrapped > 0) {
        await copyFile(configPath, configPath + ".bak");
        configBackedUp = true;
        const output: ClaudeCodeConfig = { ...config, mcpServers: wrapped };
        await writeFile(configPath, JSON.stringify(output, null, 2));
      }
    }
  } catch {
    // No config file — that's fine
  }

  return {
    hooksInstalled: hookResult.installed,
    serversWrapped,
    serverNames,
    configBackedUp,
  };
}

export async function runRemove(options: SetupOptions = {}): Promise<{ hooksRemoved: boolean; configRestored: boolean }> {
  const home = options.homeDir ?? homedir();
  const settingsPath = options.settingsPath ?? join(home, ".claude", "settings.json");
  const configPath = options.claudeCodeConfigPath ?? join(home, ".claude.json");

  const hookResult = await removeHooks(settingsPath);

  // Restore MCP config from backup if it exists
  let configRestored = false;
  try {
    const bakPath = configPath + ".bak";
    const backup = await readFile(bakPath, "utf-8");
    await writeFile(configPath, backup);
    configRestored = true;
  } catch {
    // No backup to restore
  }

  return { hooksRemoved: hookResult.removed, configRestored };
}
```

- [ ] **Step 9: Run setup tests to verify they pass**

Run: `npx vitest run test/setup.test.ts`
Expected: PASS

- [ ] **Step 10: Write failing test for hook CLI handlers**

Add to `test/hooks.test.ts`:

```typescript
import { handleSessionStart, handleSessionEnd } from "../src/hooks.js";

describe("hook handlers", () => {
  it("session-start writes session marker", async () => {
    const testLogDir = join(tmpdir(), `flight-hook-start-${Date.now()}`);
    await mkdir(testLogDir, { recursive: true });

    const output = await handleSessionStart(
      JSON.stringify({ session_id: "test-123", cwd: "/tmp" }),
      testLogDir
    );

    expect(output).toContain("test-123");
    await rm(testLogDir, { recursive: true }).catch(() => {});
  });
});
```

- [ ] **Step 11: Implement hook handlers**

Add to `src/hooks.ts`:

```typescript
import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  [key: string]: unknown;
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

  // Write session marker file for correlation
  const markerPath = join(dir, `.active_session`);
  await fsWriteFile(markerPath, sessionId);

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

  // Auto-summary is handled by importing summarySession (added in Task 3)
  // For now, just acknowledge the session ended
  return `[flight] Session ${sessionId} ended`;
}
```

- [ ] **Step 12: Run tests to verify hook handlers pass**

Run: `npx vitest run test/hooks.test.ts`
Expected: PASS

- [ ] **Step 13: Wire `flight setup`, `flight setup --remove`, and `flight hook` commands into CLI**

Add to `src/cli.ts`:

```typescript
// Add imports at top:
import { runSetup, runRemove } from "./setup.js";
import { handleSessionStart, handleSessionEnd } from "./hooks.js";

// Add after init command:

program
  .command("setup")
  .description("Auto-configure Flight with Claude Code (wraps MCP servers + installs hooks)")
  .option("--remove", "Remove Flight hooks and restore original config")
  .action(async (options: { remove?: boolean }) => {
    if (options.remove) {
      const result = await runRemove();
      if (result.hooksRemoved) {
        console.log(`\x1b[32m✓\x1b[0m Removed Flight hooks from Claude Code settings`);
      } else {
        console.log(`\x1b[33m!\x1b[0m No Flight hooks found to remove`);
      }
      if (result.configRestored) {
        console.log(`\x1b[32m✓\x1b[0m Restored original MCP config from backup`);
      }
      return;
    }

    const result = await runSetup();

    if (result.hooksInstalled) {
      console.log(`\x1b[32m✓\x1b[0m Installed Claude Code hooks (SessionStart, SessionEnd)`);
    } else {
      console.log(`\x1b[33m!\x1b[0m Hooks already installed`);
    }

    if (result.serversWrapped > 0) {
      console.log(`\x1b[32m✓\x1b[0m Wrapped ${result.serversWrapped} MCP server(s): ${result.serverNames.join(", ")}`);
      if (result.configBackedUp) {
        console.log(`  Backup saved to ~/.claude.json.bak`);
      }
    } else if (result.serverNames.length > 0) {
      console.log(`\x1b[33m!\x1b[0m All ${result.serverNames.length} server(s) already wrapped`);
    } else {
      console.log(`\x1b[33m!\x1b[0m No MCP servers found in ~/.claude.json`);
    }

    console.log(`\n\x1b[32m✓\x1b[0m Flight is ready. Start a Claude Code session — recording is automatic.`);
    console.log(`  Run \x1b[36mflight log tail\x1b[0m in another terminal to watch live.`);
  });

// Hook subcommands (called by Claude Code hooks, not by users)
const hook = program.command("hook").description("Internal hook handlers (called by Claude Code)").hide();

hook
  .command("session-start")
  .description("Handle SessionStart hook")
  .action(async () => {
    let stdin = "";
    for await (const chunk of process.stdin) {
      stdin += chunk;
    }
    const output = await handleSessionStart(stdin);
    process.stderr.write(output + "\n");
  });

hook
  .command("session-end")
  .description("Handle SessionEnd hook")
  .action(async () => {
    let stdin = "";
    for await (const chunk of process.stdin) {
      stdin += chunk;
    }
    const output = await handleSessionEnd(stdin);
    process.stderr.write(output + "\n");
  });
```

- [ ] **Step 14: Update `src/index.ts` exports**

Add to `src/index.ts`:

```typescript
export { runSetup, runRemove, type SetupResult, type SetupOptions } from "./setup.js";
export { installHooks, removeHooks } from "./hooks.js";
```

- [ ] **Step 15: Run all tests to verify nothing broke**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 16: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: PASS

- [ ] **Step 17: Commit**

```bash
git add src/setup.ts src/hooks.ts src/cli.ts src/index.ts test/setup.test.ts test/hooks.test.ts
git commit -m "feat: add flight setup command with Claude Code hook integration

One-command setup that wraps MCP servers and installs
SessionStart/SessionEnd hooks into Claude Code settings."
```

---

## Chunk 2: Inline Alerts + Loop Detection

### Task 2: Loop Detection in Logger

**Files:**
- Modify: `src/logger.ts`
- Test: `test/loop-detection.test.ts`

---

- [ ] **Step 1: Write failing test for loop detection**

```typescript
// test/loop-detection.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createSessionLogger, type AlertEntry } from "../src/logger.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

describe("loop detection", () => {
  let logDir: string;

  afterEach(async () => {
    if (logDir) {
      try { await rm(logDir, { recursive: true }); } catch { /* ignore */ }
    }
  });

  it("emits loop alert when same tool+args called 5 times within 60s", async () => {
    logDir = join(tmpdir(), `flight-loop-${Date.now()}`);
    const logger = await createSessionLogger(logDir);

    const alerts: AlertEntry[] = [];
    logger.onAlert = (alert) => alerts.push(alert);

    const msg = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/call" as const,
      params: { name: "read_file", arguments: { path: "/same/file.ts" } },
    };

    // Call 5 times with same args
    for (let i = 0; i < 5; i++) {
      logger.log({ ...msg, id: i + 1 }, "client->server");
      // Simulate responses
      logger.log({ jsonrpc: "2.0", id: i + 1, result: { content: [] } }, "server->client");
    }

    await logger.close();

    const loopAlerts = alerts.filter((a) => a.severity === "loop");
    expect(loopAlerts.length).toBeGreaterThanOrEqual(1);
    expect(loopAlerts[0].message).toContain("read_file");
  });

  it("does not emit loop alert for different arguments", async () => {
    logDir = join(tmpdir(), `flight-loop-diff-${Date.now()}`);
    const logger = await createSessionLogger(logDir);

    const alerts: AlertEntry[] = [];
    logger.onAlert = (alert) => alerts.push(alert);

    for (let i = 0; i < 5; i++) {
      const msg = {
        jsonrpc: "2.0" as const,
        id: i + 1,
        method: "tools/call" as const,
        params: { name: "read_file", arguments: { path: `/file${i}.ts` } },
      };
      logger.log(msg, "client->server");
      logger.log({ jsonrpc: "2.0", id: i + 1, result: { content: [] } }, "server->client");
    }

    await logger.close();

    const loopAlerts = alerts.filter((a) => a.severity === "loop");
    expect(loopAlerts.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/loop-detection.test.ts`
Expected: FAIL — `severity: "loop"` not emitted

- [ ] **Step 3: Add loop detection to logger**

Modify `src/logger.ts`:

1. Update `AlertEntry` interface to include `"loop"` severity:
```typescript
export interface AlertEntry {
  timestamp: string;
  severity: "error" | "hallucination" | "loop";
  method: string;
  tool_name?: string;
  message: string;
  session_id: string;
  call_id: string;
}
```

2. Add loop tracking state inside `createSessionLogger`, after the `recentResponses` declaration:
```typescript
// Loop detection: track tool+args hash → timestamps
const LOOP_THRESHOLD = 5;
const LOOP_WINDOW_MS = 60_000;
const loopTracker = new Map<string, number[]>();

function computeArgsHash(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const p = params as Record<string, unknown>;
  return JSON.stringify(p.arguments ?? "");
}

function checkLoop(toolName: string, params: unknown, now: number, callId: string): void {
  const key = `${toolName}:${computeArgsHash(params)}`;
  let timestamps = loopTracker.get(key);
  if (!timestamps) {
    timestamps = [];
    loopTracker.set(key, timestamps);
  }

  timestamps.push(now);
  // Trim old timestamps outside window
  const cutoff = now - LOOP_WINDOW_MS;
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }

  if (timestamps.length >= LOOP_THRESHOLD && timestamps.length === LOOP_THRESHOLD) {
    const alert: AlertEntry = {
      timestamp: new Date(now).toISOString(),
      severity: "loop",
      method: "tools/call",
      tool_name: toolName,
      message: `${toolName} called ${LOOP_THRESHOLD}x with same args in ${LOOP_WINDOW_MS / 1000}s`,
      session_id: sessionId,
      call_id: callId,
    };
    writeAlert(alert);
    if (logger.onAlert) logger.onAlert(alert);
  }
}
```

3. In the `log` method, after hallucination detection for `direction === "client->server"` and `msg.method === "tools/call"`, add:
```typescript
if (toolName) {
  checkLoop(toolName, msg.params, now, callId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/loop-detection.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests to verify nothing broke**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/logger.ts test/loop-detection.test.ts
git commit -m "feat: add loop detection — warns when same tool+args called 5x in 60s"
```

---

### Task 3: Inline Stderr Alerts in Proxy

**Files:**
- Modify: `src/proxy.ts`
- Modify: `src/logger.ts` (already has `onAlert` callback)

---

- [ ] **Step 1: Update proxy `onAlert` handler to include loop alerts**

In `src/proxy.ts`, update the `onAlert` callback to handle the new `"loop"` severity:

```typescript
// Replace existing onAlert in proxy.ts:
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
```

Note: remove the `!quiet` check from the error branch since we now check `quiet` at the top.

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/proxy.ts
git commit -m "feat: add inline stderr alerts for loop detection and unify quiet check"
```

---

### Task 4: Smart Summary Command

**Files:**
- Create: `src/summary.ts`
- Modify: `src/cli.ts`
- Modify: `src/log-commands.ts` (reuse helpers)
- Test: `test/summary.test.ts`

---

- [ ] **Step 1: Write failing test for `computeSummary`**

```typescript
// test/summary.test.ts
import { describe, it, expect } from "vitest";
import { computeSummary } from "../src/summary.js";
import type { LogEntry } from "../src/logger.js";

function makeEntry(overrides: Partial<LogEntry>): LogEntry {
  return {
    session_id: "test-session",
    call_id: "call-1",
    timestamp: "2026-03-15T14:22:03.000Z",
    latency_ms: 10,
    direction: "client->server",
    method: "tools/call",
    payload: {},
    pd_active: false,
    ...overrides,
  };
}

describe("computeSummary", () => {
  it("computes call count, errors, hints, and top tools", () => {
    const entries: LogEntry[] = [
      makeEntry({ tool_name: "read_file", direction: "client->server" }),
      makeEntry({ tool_name: "read_file", direction: "server->client", latency_ms: 12 }),
      makeEntry({ tool_name: "read_file", direction: "client->server" }),
      makeEntry({ tool_name: "read_file", direction: "server->client", latency_ms: 8 }),
      makeEntry({ tool_name: "write_file", direction: "client->server" }),
      makeEntry({ tool_name: "write_file", direction: "server->client", error: "Permission denied" }),
      makeEntry({ tool_name: "list_dir", direction: "client->server", hallucination_hint: true }),
      makeEntry({ tool_name: "list_dir", direction: "server->client", latency_ms: 5 }),
    ];

    const summary = computeSummary(entries);

    expect(summary.totalCalls).toBe(8);
    expect(summary.errors).toBe(1);
    expect(summary.hallucinationHints).toBe(1);
    expect(summary.topTools[0]).toEqual({ name: "read_file", count: 4 });
    expect(summary.topTools.length).toBeLessThanOrEqual(5);
  });

  it("computes session duration from first to last timestamp", () => {
    const entries: LogEntry[] = [
      makeEntry({ timestamp: "2026-03-15T14:00:00.000Z" }),
      makeEntry({ timestamp: "2026-03-15T14:14:23.000Z" }),
    ];

    const summary = computeSummary(entries);
    expect(summary.durationMs).toBe(14 * 60 * 1000 + 23 * 1000);
  });

  it("generates timeline string with error markers", () => {
    const entries: LogEntry[] = [
      makeEntry({ direction: "client->server" }),
      makeEntry({ direction: "server->client" }),
      makeEntry({ direction: "client->server" }),
      makeEntry({ direction: "server->client", error: "fail" }),
      makeEntry({ direction: "client->server", hallucination_hint: true }),
      makeEntry({ direction: "server->client" }),
    ];

    const summary = computeSummary(entries);
    expect(summary.timeline).toBeDefined();
    expect(summary.timeline).toContain("x"); // error marker
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/summary.test.ts`
Expected: FAIL — cannot resolve `../src/summary.js`

- [ ] **Step 3: Implement `computeSummary` and `formatSummary`**

```typescript
// src/summary.ts
import type { LogEntry } from "./logger.js";

export interface SessionSummary {
  sessionId: string;
  totalCalls: number;
  errors: number;
  hallucinationHints: number;
  topTools: Array<{ name: string; count: number }>;
  durationMs: number;
  timeline: string;
}

export function computeSummary(entries: LogEntry[]): SessionSummary {
  const sessionId = entries[0]?.session_id ?? "unknown";
  const errors = entries.filter((e) => e.error).length;
  const hallucinationHints = entries.filter((e) => e.hallucination_hint).length;

  // Top tools by frequency
  const toolCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.tool_name) {
      toolCounts.set(entry.tool_name, (toolCounts.get(entry.tool_name) ?? 0) + 1);
    }
  }
  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // Duration
  let durationMs = 0;
  if (entries.length >= 2) {
    const first = new Date(entries[0].timestamp).getTime();
    const last = new Date(entries[entries.length - 1].timestamp).getTime();
    durationMs = last - first;
  }

  // Timeline: each server->client response is a marker
  const responses = entries.filter((e) => e.direction === "server->client");
  const timelineChars: string[] = [];
  for (const r of responses) {
    if (r.hallucination_hint) {
      timelineChars.push("!");
    } else if (r.error) {
      timelineChars.push("x");
    } else {
      timelineChars.push("=");
    }
  }
  // Compress if too long
  let timeline = timelineChars.join("");
  if (timeline.length > 50) {
    const ratio = Math.ceil(timeline.length / 50);
    const compressed: string[] = [];
    for (let i = 0; i < timeline.length; i += ratio) {
      const chunk = timeline.slice(i, i + ratio);
      if (chunk.includes("!")) compressed.push("!");
      else if (chunk.includes("x")) compressed.push("x");
      else compressed.push("=");
    }
    timeline = compressed.join("");
  }
  timeline = `[${timeline}]`;

  return {
    sessionId,
    totalCalls: entries.length,
    errors,
    hallucinationHints,
    topTools,
    durationMs,
    timeline,
  };
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

export function formatSummary(summary: SessionSummary): string {
  const lines: string[] = [];
  lines.push(`${C.cyan}Session:${C.reset} ${summary.sessionId} (${formatDuration(summary.durationMs)})`);
  lines.push(`  Calls: ${summary.totalCalls}  |  Errors: ${summary.errors > 0 ? C.red + summary.errors + C.reset : "0"}  |  Hallucination hints: ${summary.hallucinationHints > 0 ? C.yellow + summary.hallucinationHints + C.reset : "0"}`);

  if (summary.topTools.length > 0) {
    const toolStr = summary.topTools.map((t) => `${t.name} (${t.count})`).join(", ");
    lines.push(`  Top tools: ${toolStr}`);
  }

  lines.push(`  Timeline: ${summary.timeline}`);
  lines.push(`${C.dim}            x = error, ! = hallucination hint${C.reset}`);

  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/summary.test.ts`
Expected: PASS

- [ ] **Step 5: Wire `flight log summary` command into CLI**

Add to `src/cli.ts` at the top with other imports:

```typescript
import { computeSummary, formatSummary } from "./summary.js";
import { readLogEntriesForSession } from "./log-commands.js";
```

Note: all new imports in `cli.ts` should be static (at the top of the file), not dynamic. This applies to all tasks.

```typescript
log
  .command("summary")
  .argument("[session]", "Session ID (default: most recent)")
  .description("One-screen summary of a session")
  .action(async (session?: string) => {
    const entries = await readLogEntriesForSession(session);
    if (!entries || entries.length === 0) {
      console.log("No session data found.");
      return;
    }
    const summary = computeSummary(entries);
    console.log(formatSummary(summary));
  });
```

Also, export `readLogEntriesForSession` from `log-commands.ts`:

```typescript
// Add to log-commands.ts as a new exported function:
export async function readLogEntriesForSession(sessionId?: string): Promise<LogEntry[] | null> {
  const file = await findSessionFile(sessionId);
  if (!file) return null;
  return readLogEntries(file);
}
```

- [ ] **Step 6: Run all tests and lint**

Run: `npm run check`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/summary.ts src/cli.ts src/log-commands.ts test/summary.test.ts
git commit -m "feat: add flight log summary command for quick session triage"
```

---

## Chunk 3: Export + Auto-Cleanup

### Task 5: CSV/JSONL Export

**Files:**
- Create: `src/export.ts`
- Modify: `src/cli.ts`
- Test: `test/export.test.ts`

---

- [ ] **Step 1: Write failing test for CSV export**

```typescript
// test/export.test.ts
import { describe, it, expect } from "vitest";
import { entriesToCsv, entriesToJsonl } from "../src/export.js";
import type { LogEntry } from "../src/logger.js";

function makeEntry(overrides: Partial<LogEntry>): LogEntry {
  return {
    session_id: "test-session",
    call_id: "call-1",
    timestamp: "2026-03-15T14:22:03.000Z",
    latency_ms: 10,
    direction: "client->server",
    method: "tools/call",
    payload: {},
    pd_active: false,
    ...overrides,
  };
}

describe("entriesToCsv", () => {
  it("produces CSV with header and data rows", () => {
    const entries: LogEntry[] = [
      makeEntry({ tool_name: "read_file", error: undefined }),
      makeEntry({ tool_name: "write_file", error: "Permission denied", hallucination_hint: true }),
    ];

    const csv = entriesToCsv(entries);
    const lines = csv.trim().split("\n");

    expect(lines[0]).toBe("session_id,call_id,timestamp,direction,method,tool_name,latency_ms,error,hallucination_hint,pd_active");
    expect(lines.length).toBe(3); // header + 2 data rows
    expect(lines[2]).toContain("Permission denied");
    expect(lines[2]).toContain("true"); // hallucination_hint
  });

  it("escapes commas and quotes in fields", () => {
    const entries: LogEntry[] = [
      makeEntry({ error: 'Error: "bad, input"' }),
    ];

    const csv = entriesToCsv(entries);
    const lines = csv.trim().split("\n");
    // Field should be quoted and inner quotes doubled
    expect(lines[1]).toContain('"Error: ""bad, input"""');
  });
});

describe("entriesToJsonl", () => {
  it("produces one JSON line per entry without payload", () => {
    const entries: LogEntry[] = [
      makeEntry({ tool_name: "read_file" }),
      makeEntry({ tool_name: "write_file" }),
    ];

    const jsonl = entriesToJsonl(entries);
    const lines = jsonl.trim().split("\n");

    expect(lines.length).toBe(2);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.tool_name).toBe("read_file");
    expect(parsed.payload).toBeUndefined(); // stripped by default
  });

  it("includes payload when requested", () => {
    const entries: LogEntry[] = [
      makeEntry({ tool_name: "read_file", payload: { data: "hello" } }),
    ];

    const jsonl = entriesToJsonl(entries, { includePayload: true });
    const parsed = JSON.parse(jsonl.trim());
    expect(parsed.payload).toEqual({ data: "hello" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/export.test.ts`
Expected: FAIL — cannot resolve `../src/export.js`

- [ ] **Step 3: Implement export module**

```typescript
// src/export.ts
import type { LogEntry } from "./logger.js";

const CSV_COLUMNS = [
  "session_id", "call_id", "timestamp", "direction", "method",
  "tool_name", "latency_ms", "error", "hallucination_hint", "pd_active",
] as const;

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function entriesToCsv(entries: LogEntry[]): string {
  const header = CSV_COLUMNS.join(",");
  const rows = entries.map((entry) => {
    return CSV_COLUMNS.map((col) => {
      const val = entry[col as keyof LogEntry];
      if (val === undefined || val === null) return "";
      return escapeCsvField(String(val));
    }).join(",");
  });
  return [header, ...rows].join("\n") + "\n";
}

export interface JsonlOptions {
  includePayload?: boolean;
}

export function entriesToJsonl(entries: LogEntry[], options?: JsonlOptions): string {
  return entries.map((entry) => {
    const out: Record<string, unknown> = { ...entry };
    if (!options?.includePayload) {
      delete out.payload;
    }
    return JSON.stringify(out);
  }).join("\n") + "\n";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/export.test.ts`
Expected: PASS

- [ ] **Step 5: Wire `flight export` command into CLI**

Add to `src/cli.ts`:

Add static imports at the top of `src/cli.ts` (not dynamic):

```typescript
import { entriesToCsv, entriesToJsonl } from "./export.js";
import { writeFile as fsWriteFile } from "node:fs/promises";
```

```typescript
program
  .command("export")
  .argument("[session]", "Session ID (default: most recent)")
  .requiredOption("--format <format>", "Export format: csv or jsonl")
  .option("--output <path>", "Output file path (default: stdout)")
  .option("--include-payload", "Include full payload in export")
  .option("--tool <name>", "Filter by tool name")
  .option("--errors", "Include only entries with errors")
  .option("--hallucinations", "Include only entries with hallucination hints")
  .description("Export session logs to CSV or JSONL")
  .action(async (session: string | undefined, options: { format: string; output?: string; includePayload?: boolean; tool?: string; errors?: boolean; hallucinations?: boolean }) => {
    let entries = await readLogEntriesForSession(session);

    if (!entries || entries.length === 0) {
      console.error("No session data found.");
      process.exit(1);
    }

    // Apply filters
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

    let output: string;
    if (options.format === "csv") {
      output = entriesToCsv(entries);
    } else if (options.format === "jsonl") {
      output = entriesToJsonl(entries, { includePayload: options.includePayload });
    } else {
      console.error(`Unknown format: ${options.format}. Supported: csv, jsonl`);
      process.exit(1);
    }

    if (options.output) {
      await fsWriteFile(options.output, output);
      console.log(`Exported ${entries.length} entries to ${options.output}`);
    } else {
      process.stdout.write(output);
    }
  });
```

- [ ] **Step 6: Run all tests and lint**

Run: `npm run check`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/export.ts src/cli.ts test/export.test.ts
git commit -m "feat: add flight export command for CSV and JSONL export"
```

---

### Task 6: Log Lifecycle (gc, prune, auto-compress)

**Files:**
- Create: `src/lifecycle.ts`
- Modify: `src/log-commands.ts` (read `.gz` files)
- Modify: `src/cli.ts`
- Modify: `src/hooks.ts` (trigger gc on session end)
- Test: `test/lifecycle.test.ts`

---

- [ ] **Step 1: Write failing test for `compressOldSessions`**

```typescript
// test/lifecycle.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdir, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compressOldSessions, garbageCollect, pruneSessions } from "../src/lifecycle.js";

describe("compressOldSessions", () => {
  const testDir = join(tmpdir(), `flight-lifecycle-${Date.now()}`);

  afterEach(async () => {
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("compresses .jsonl files older than maxAgeMs", async () => {
    await mkdir(testDir, { recursive: true });
    const oldFile = join(testDir, "session_old.jsonl");
    await writeFile(oldFile, '{"test": true}\n');

    // Set mtime to 2 days ago
    const { utimes } = await import("node:fs/promises");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(oldFile, twoDaysAgo, twoDaysAgo);

    const result = await compressOldSessions(testDir, { maxAgeMs: 24 * 60 * 60 * 1000 });

    expect(result.compressed).toBe(1);
    const files = await readdir(testDir);
    expect(files.some((f) => f.endsWith(".jsonl.gz"))).toBe(true);
    expect(files.some((f) => f === "session_old.jsonl")).toBe(false);
  });

  it("does not compress recent files", async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, "session_new.jsonl"), '{"test": true}\n');

    const result = await compressOldSessions(testDir, { maxAgeMs: 24 * 60 * 60 * 1000 });

    expect(result.compressed).toBe(0);
    const files = await readdir(testDir);
    expect(files).toContain("session_new.jsonl");
  });
});

describe("garbageCollect", () => {
  const testDir = join(tmpdir(), `flight-gc-${Date.now()}`);

  afterEach(async () => {
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("deletes oldest sessions when count exceeds maxSessions", async () => {
    await mkdir(testDir, { recursive: true });

    // Create 5 sessions with different mtimes
    for (let i = 0; i < 5; i++) {
      const file = join(testDir, `session_${String(i).padStart(3, "0")}.jsonl`);
      await writeFile(file, `{"i": ${i}}\n`);
      const mtime = new Date(Date.now() - (5 - i) * 1000);
      const { utimes } = await import("node:fs/promises");
      await utimes(file, mtime, mtime);
    }

    const result = await garbageCollect(testDir, { maxSessions: 3 });

    expect(result.deleted).toBe(2);
    const files = await readdir(testDir);
    expect(files.length).toBe(3);
  });
});

describe("pruneSessions", () => {
  const testDir = join(tmpdir(), `flight-prune-${Date.now()}`);

  afterEach(async () => {
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("prunes sessions before a given date", async () => {
    await mkdir(testDir, { recursive: true });

    const oldFile = join(testDir, "session_old.jsonl");
    const newFile = join(testDir, "session_new.jsonl");
    await writeFile(oldFile, '{"test": true}\n');
    await writeFile(newFile, '{"test": true}\n');

    const { utimes } = await import("node:fs/promises");
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    await utimes(oldFile, twoWeeksAgo, twoWeeksAgo);

    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await pruneSessions(testDir, { before: oneWeekAgo });

    expect(result.deleted).toBe(1);
    const files = await readdir(testDir);
    expect(files).toContain("session_new.jsonl");
    expect(files).not.toContain("session_old.jsonl");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lifecycle.test.ts`
Expected: FAIL — cannot resolve `../src/lifecycle.js`

- [ ] **Step 3: Implement lifecycle module**

```typescript
// src/lifecycle.ts
import { readdir, stat, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGzip, createGunzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { homedir } from "node:os";

const DEFAULT_LOG_DIR = join(homedir(), ".flight", "logs");

export interface CompressOptions {
  maxAgeMs?: number; // default: 24 hours
}

export interface GcOptions {
  maxSessions?: number;  // default: 100
  maxBytes?: number;     // default: 2 GB
  dryRun?: boolean;
}

export interface PruneOptions {
  before?: Date;
  keep?: number;
}

export async function compressOldSessions(
  logDir: string = DEFAULT_LOG_DIR,
  options: CompressOptions = {},
): Promise<{ compressed: number }> {
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  let compressed = 0;

  try {
    const files = await readdir(logDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl") && !f.startsWith("."));

    for (const file of jsonlFiles) {
      const filePath = join(logDir, file);
      const s = await stat(filePath);
      if (s.mtimeMs < cutoff) {
        const gzPath = filePath + ".gz";
        await pipeline(
          createReadStream(filePath),
          createGzip(),
          createWriteStream(gzPath),
        );
        await rm(filePath);
        compressed++;
      }
    }
  } catch {
    // Directory may not exist
  }

  return { compressed };
}

async function getSessionFiles(logDir: string): Promise<Array<{ name: string; path: string; mtimeMs: number; size: number }>> {
  try {
    const files = await readdir(logDir);
    const sessionFiles = files.filter((f) => (f.endsWith(".jsonl") || f.endsWith(".jsonl.gz")) && !f.startsWith("."));

    const result = [];
    for (const file of sessionFiles) {
      const filePath = join(logDir, file);
      const s = await stat(filePath);
      result.push({ name: file, path: filePath, mtimeMs: s.mtimeMs, size: s.size });
    }

    // Sort oldest first
    result.sort((a, b) => a.mtimeMs - b.mtimeMs);
    return result;
  } catch {
    return [];
  }
}

export async function garbageCollect(
  logDir: string = DEFAULT_LOG_DIR,
  options: GcOptions = {},
): Promise<{ deleted: number; freedBytes: number; dryRun: boolean }> {
  const maxSessions = options.maxSessions ?? 100;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024; // 2 GB
  const dryRun = options.dryRun ?? false;

  const files = await getSessionFiles(logDir);
  let totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  let deleted = 0;
  let freedBytes = 0;

  // Delete oldest files until within limits
  for (const file of files) {
    const overCount = (files.length - deleted) > maxSessions;
    const overSize = totalBytes > maxBytes;

    if (!overCount && !overSize) break;

    if (!dryRun) {
      await rm(file.path);
    }
    deleted++;
    freedBytes += file.size;
    totalBytes -= file.size;
  }

  return { deleted, freedBytes, dryRun };
}

export async function pruneSessions(
  logDir: string = DEFAULT_LOG_DIR,
  options: PruneOptions = {},
): Promise<{ deleted: number }> {
  const files = await getSessionFiles(logDir);
  let deleted = 0;

  if (options.before) {
    const cutoff = options.before.getTime();
    for (const file of files) {
      if (file.mtimeMs < cutoff) {
        await rm(file.path);
        deleted++;
      }
    }
  }

  if (options.keep !== undefined) {
    // Keep only the N most recent (files are sorted oldest first)
    const toDelete = files.length - options.keep;
    if (toDelete > 0) {
      for (let i = 0; i < toDelete && i < files.length; i++) {
        // Check if already deleted by 'before' filter
        try {
          await stat(files[i].path);
          await rm(files[i].path);
          deleted++;
        } catch {
          // Already deleted
        }
      }
    }
  }

  return { deleted };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lifecycle.test.ts`
Expected: PASS

- [ ] **Step 5: Add gzip reading support to `log-commands.ts`**

Modify `src/log-commands.ts` — update `readLogEntries` to handle `.jsonl.gz`:

```typescript
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";
```

Replace the existing `readLogEntries` function:

```typescript
async function readLogEntries(sessionFile: string): Promise<LogEntry[]> {
  const filePath = join(DEFAULT_LOG_DIR, sessionFile);
  let content: string;

  if (sessionFile.endsWith(".gz")) {
    // Decompress gzipped log
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath).pipe(createGunzip());
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    content = Buffer.concat(chunks).toString("utf-8");
  } else {
    content = await readFile(filePath, "utf-8");
  }

  const entries: LogEntry[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}
```

Also update `getLogFiles` to include `.gz`:

```typescript
async function getLogFiles(): Promise<string[]> {
  try {
    const files = await readdir(DEFAULT_LOG_DIR);
    return files
      .filter((f) => f.endsWith(".jsonl") || f.endsWith(".jsonl.gz"))
      .filter((f) => !f.startsWith("."))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
```

- [ ] **Step 6: Wire `flight log gc` and `flight log prune` into CLI**

Add to `src/cli.ts`:

```typescript
import { compressOldSessions, garbageCollect, pruneSessions } from "./lifecycle.js";
```

Note: `join` and `homedir` are already available from static imports at the top of `cli.ts`. Use them directly — do not use dynamic imports.

```typescript
const LOG_DIR = join(homedir(), ".flight", "logs");

log
  .command("gc")
  .description("Compress old sessions and enforce storage limits")
  .option("--dry-run", "Show what would be cleaned up without doing it")
  .action(async (options: { dryRun?: boolean }) => {
    const compressResult = await compressOldSessions(LOG_DIR);
    if (compressResult.compressed > 0) {
      console.log(`Compressed ${compressResult.compressed} old session(s)`);
    }

    const gcResult = await garbageCollect(LOG_DIR, { dryRun: options.dryRun });
    if (gcResult.deleted > 0) {
      const action = gcResult.dryRun ? "Would delete" : "Deleted";
      const freed = (gcResult.freedBytes / 1024 / 1024).toFixed(1);
      console.log(`${action} ${gcResult.deleted} session(s), freeing ${freed} MB`);
    } else {
      console.log("Storage within limits. Nothing to clean up.");
    }
  });

log
  .command("prune")
  .description("Delete old sessions")
  .option("--before <date>", "Delete sessions before this date (YYYY-MM-DD)")
  .option("--keep <n>", "Keep only the N most recent sessions")
  .action(async (options: { before?: string; keep?: string }) => {
    const pruneOpts: { before?: Date; keep?: number } = {};
    if (options.before) {
      pruneOpts.before = new Date(options.before);
    }
    if (options.keep) {
      pruneOpts.keep = parseInt(options.keep, 10);
    }

    if (!pruneOpts.before && pruneOpts.keep === undefined) {
      console.error("Specify --before <date> or --keep <n>");
      process.exit(1);
    }

    const result = await pruneSessions(LOG_DIR, pruneOpts);
    console.log(`Deleted ${result.deleted} session(s)`);
  });
```

- [ ] **Step 7: Update `handleSessionEnd` in hooks.ts to trigger gc**

In `src/hooks.ts`, update `handleSessionEnd`:

```typescript
import { compressOldSessions, garbageCollect } from "./lifecycle.js";

export async function handleSessionEnd(stdinJson: string, logDir?: string): Promise<string> {
  let input: HookInput;
  try {
    input = JSON.parse(stdinJson) as HookInput;
  } catch {
    input = {};
  }

  const sessionId = input.session_id ?? "unknown";
  const dir = logDir ?? join(homedir(), ".flight", "logs");

  // Auto-compress and gc (fire and forget - don't block session end)
  compressOldSessions(dir).catch(() => {});
  garbageCollect(dir).catch(() => {});

  return `[flight] Session ${sessionId} ended`;
}
```

- [ ] **Step 8: Run all tests and lint**

Run: `npm run check`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/lifecycle.ts src/log-commands.ts src/hooks.ts src/cli.ts test/lifecycle.test.ts
git commit -m "feat: add log lifecycle management — gc, prune, auto-compress, gzip reading"
```

---

## Chunk 4: Progressive Disclosure

### Task 7: PD Schema Cache + Meta-Tools

**Files:**
- Create: `src/progressive-disclosure.ts`
- Modify: `src/proxy.ts`
- Modify: `src/cli.ts` (add `--pd` flag)
- Test: `test/progressive-disclosure.test.ts`

---

- [ ] **Step 1: Write failing test for schema cache**

```typescript
// test/progressive-disclosure.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPDHandler,
  type ToolSchema,
} from "../src/progressive-disclosure.js";

const sampleTools: ToolSchema[] = [
  {
    name: "read_file",
    description: "Read file contents from the filesystem",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description: "List files in a directory",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description: "Search for files matching a pattern",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
    },
  },
];

describe("PD Handler", () => {
  const cacheDir = join(tmpdir(), `flight-pd-${Date.now()}`);

  afterEach(async () => {
    try { await rm(cacheDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("caches tool schemas on loadSchemas", async () => {
    await mkdir(cacheDir, { recursive: true });
    const pd = createPDHandler(cacheDir);
    pd.loadSchemas(sampleTools);

    expect(pd.isActive()).toBe(true);
    expect(pd.getToolCount()).toBe(4);
  });

  it("generates meta-tool schemas for tools/list response", () => {
    const pd = createPDHandler(join(tmpdir(), "no-cache"));
    pd.loadSchemas(sampleTools);

    const metaTools = pd.getMetaToolSchemas();
    expect(metaTools).toHaveLength(2);
    expect(metaTools.map((t) => t.name)).toEqual(["discover_tools", "execute_tool"]);
  });

  it("discover_tools returns matching tools by keyword", () => {
    const pd = createPDHandler(join(tmpdir(), "no-cache"));
    pd.loadSchemas(sampleTools);

    const results = pd.discoverTools("file");
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.some((r) => r.name === "read_file")).toBe(true);
    expect(results.some((r) => r.name === "write_file")).toBe(true);
  });

  it("discover_tools returns empty array for no match", () => {
    const pd = createPDHandler(join(tmpdir(), "no-cache"));
    pd.loadSchemas(sampleTools);

    const results = pd.discoverTools("zzzznonexistent");
    expect(results.length).toBe(0);
  });

  it("resolves real tool name and schema from execute_tool", () => {
    const pd = createPDHandler(join(tmpdir(), "no-cache"));
    pd.loadSchemas(sampleTools);

    const resolved = pd.resolveExecuteTool("read_file", { path: "/test.ts" });
    expect(resolved).not.toBeNull();
    expect(resolved!.toolName).toBe("read_file");
    expect(resolved!.arguments).toEqual({ path: "/test.ts" });
  });

  it("returns null for unknown tool in execute_tool", () => {
    const pd = createPDHandler(join(tmpdir(), "no-cache"));
    pd.loadSchemas(sampleTools);

    const resolved = pd.resolveExecuteTool("nonexistent_tool", {});
    expect(resolved).toBeNull();
  });

  it("estimates token savings", () => {
    const pd = createPDHandler(join(tmpdir(), "no-cache"));
    pd.loadSchemas(sampleTools);

    const savings = pd.estimateTokenSavings();
    expect(savings.originalTokens).toBeGreaterThan(0);
    expect(savings.reducedTokens).toBeGreaterThan(0);
    expect(savings.savedTokens).toBeGreaterThan(0);
    expect(savings.savedTokens).toBeLessThan(savings.originalTokens);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/progressive-disclosure.test.ts`
Expected: FAIL — cannot resolve `../src/progressive-disclosure.js`

- [ ] **Step 3: Implement PD handler**

```typescript
// src/progressive-disclosure.ts

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DiscoverResult {
  name: string;
  description: string;
}

export interface ResolvedTool {
  toolName: string;
  arguments: Record<string, unknown>;
  schema: ToolSchema;
}

export interface TokenSavings {
  originalTokens: number;
  reducedTokens: number;
  savedTokens: number;
}

export interface PDHandler {
  loadSchemas(tools: ToolSchema[]): void;
  isActive(): boolean;
  getToolCount(): number;
  getMetaToolSchemas(): ToolSchema[];
  discoverTools(query: string): DiscoverResult[];
  resolveExecuteTool(toolName: string, args: Record<string, unknown>): ResolvedTool | null;
  estimateTokenSavings(): TokenSavings;
}

function estimateTokens(obj: unknown): number {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

export function createPDHandler(_cacheDir: string): PDHandler {
  const schemas = new Map<string, ToolSchema>();
  let active = false;

  const metaToolSchemas: ToolSchema[] = [
    {
      name: "discover_tools",
      description: "Search available tools by keyword. Returns tool names and descriptions matching the query. Use this to find the right tool before calling execute_tool.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keyword to search tool names and descriptions",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "execute_tool",
      description: "Execute a tool by name with the given arguments. Use discover_tools first to find available tools.",
      inputSchema: {
        type: "object",
        properties: {
          tool_name: {
            type: "string",
            description: "The name of the tool to execute (from discover_tools results)",
          },
          arguments: {
            type: "object",
            description: "Arguments to pass to the tool",
          },
        },
        required: ["tool_name", "arguments"],
      },
    },
  ];

  return {
    loadSchemas(tools: ToolSchema[]) {
      schemas.clear();
      for (const tool of tools) {
        schemas.set(tool.name, tool);
      }
      active = true;
    },

    isActive() {
      return active;
    },

    getToolCount() {
      return schemas.size;
    },

    getMetaToolSchemas() {
      return metaToolSchemas;
    },

    discoverTools(query: string): DiscoverResult[] {
      const q = query.toLowerCase();
      const results: DiscoverResult[] = [];

      for (const tool of schemas.values()) {
        const nameMatch = tool.name.toLowerCase().includes(q);
        const descMatch = tool.description.toLowerCase().includes(q);
        if (nameMatch || descMatch) {
          results.push({ name: tool.name, description: tool.description });
        }
      }

      // Sort: name matches first, then description matches
      results.sort((a, b) => {
        const aName = a.name.toLowerCase().includes(q) ? 0 : 1;
        const bName = b.name.toLowerCase().includes(q) ? 0 : 1;
        return aName - bName;
      });

      return results;
    },

    resolveExecuteTool(toolName: string, args: Record<string, unknown>): ResolvedTool | null {
      const schema = schemas.get(toolName);
      if (!schema) return null;

      return {
        toolName,
        arguments: args,
        schema,
      };
    },

    estimateTokenSavings(): TokenSavings {
      const allSchemas = [...schemas.values()];
      const originalTokens = estimateTokens(allSchemas);
      const reducedTokens = estimateTokens(metaToolSchemas);

      return {
        originalTokens,
        reducedTokens,
        savedTokens: Math.max(0, originalTokens - reducedTokens),
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/progressive-disclosure.test.ts`
Expected: PASS

- [ ] **Step 5: Commit PD handler**

```bash
git add src/progressive-disclosure.ts test/progressive-disclosure.test.ts
git commit -m "feat: add progressive disclosure handler — schema cache, discover_tools, execute_tool"
```

---

### Task 8: Integrate PD into Proxy + Stats Command

**Files:**
- Modify: `src/proxy.ts`
- Create: `src/stats.ts`
- Modify: `src/cli.ts`
- Modify: `src/logger.ts` (add `schema_tokens_saved` to LogEntry)
- Test: `test/stats.test.ts`
- Test: `test/pd-integration.test.ts`

---

- [ ] **Step 1: Add `schema_tokens_saved` field to `LogEntry`**

In `src/logger.ts`, add to the `LogEntry` interface:

```typescript
export interface LogEntry {
  // ... existing fields ...
  schema_tokens_saved?: number;
}
```

- [ ] **Step 2: Write failing test for stats computation**

```typescript
// test/stats.test.ts
import { describe, it, expect } from "vitest";
import { computeStats } from "../src/stats.js";
import type { LogEntry } from "../src/logger.js";

function makeEntry(overrides: Partial<LogEntry>): LogEntry {
  return {
    session_id: "test-session",
    call_id: "call-1",
    timestamp: "2026-03-15T14:22:03.000Z",
    latency_ms: 10,
    direction: "client->server",
    method: "tools/call",
    payload: {},
    pd_active: false,
    ...overrides,
  };
}

describe("computeStats", () => {
  it("computes total token savings from entries", () => {
    const entries: LogEntry[] = [
      makeEntry({ pd_active: true, schema_tokens_saved: 500 }),
      makeEntry({ pd_active: true, schema_tokens_saved: 300 }),
      makeEntry({ pd_active: true, schema_tokens_saved: 0 }),
      makeEntry({ pd_active: false }),
    ];

    const stats = computeStats(entries);
    expect(stats.totalTokensSaved).toBe(800);
    expect(stats.pdActive).toBe(true);
    expect(stats.totalCalls).toBe(4);
  });

  it("reports pdActive false when no PD entries exist", () => {
    const entries: LogEntry[] = [
      makeEntry({ pd_active: false }),
    ];

    const stats = computeStats(entries);
    expect(stats.pdActive).toBe(false);
    expect(stats.totalTokensSaved).toBe(0);
  });
});
```

- [ ] **Step 3: Implement stats module**

```typescript
// src/stats.ts
import type { LogEntry } from "./logger.js";

export interface SessionStats {
  sessionId: string;
  totalCalls: number;
  errors: number;
  pdActive: boolean;
  totalTokensSaved: number;
  toolBreakdown: Array<{ name: string; calls: number; tokensSaved: number }>;
}

export function computeStats(entries: LogEntry[]): SessionStats {
  const sessionId = entries[0]?.session_id ?? "unknown";
  const pdActive = entries.some((e) => e.pd_active);
  const errors = entries.filter((e) => e.error).length;

  let totalTokensSaved = 0;
  const toolMap = new Map<string, { calls: number; tokensSaved: number }>();

  for (const entry of entries) {
    if (entry.schema_tokens_saved) {
      totalTokensSaved += entry.schema_tokens_saved;
    }

    if (entry.tool_name) {
      const existing = toolMap.get(entry.tool_name) ?? { calls: 0, tokensSaved: 0 };
      existing.calls++;
      existing.tokensSaved += entry.schema_tokens_saved ?? 0;
      toolMap.set(entry.tool_name, existing);
    }
  }

  const toolBreakdown = [...toolMap.entries()]
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.tokensSaved - a.tokensSaved);

  return {
    sessionId,
    totalCalls: entries.length,
    errors,
    pdActive,
    totalTokensSaved,
    toolBreakdown,
  };
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};

export function formatStats(stats: SessionStats): string {
  const lines: string[] = [];
  lines.push(`${C.cyan}Session:${C.reset} ${stats.sessionId}`);
  lines.push(`  Total calls: ${stats.totalCalls}  |  Errors: ${stats.errors}`);
  lines.push(`  PD active: ${stats.pdActive ? C.green + "yes" + C.reset : "no"}`);
  lines.push(`  Tokens saved: ~${stats.totalTokensSaved.toLocaleString()}`);

  if (stats.toolBreakdown.length > 0) {
    lines.push(`\n  ${C.dim}Tool breakdown:${C.reset}`);
    for (const tool of stats.toolBreakdown.slice(0, 10)) {
      lines.push(`    ${tool.name}: ${tool.calls} calls, ~${tool.tokensSaved} tokens saved`);
    }
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run stats test**

Run: `npx vitest run test/stats.test.ts`
Expected: PASS

- [ ] **Step 5: Integrate PD into proxy.ts**

Add PD support to `src/proxy.ts`. The key changes:

1. Add `pd` option to `ProxyOptions`:
```typescript
export interface ProxyOptions {
  command: string;
  args: string[];
  logDir?: string;
  quiet?: boolean;
  noRetry?: boolean;
  pd?: boolean;
}
```

2. Import and initialize PD handler inside `startProxy`:
```typescript
import { createPDHandler, type PDHandler, type ToolSchema } from "./progressive-disclosure.js";
```

3. After creating the logger, conditionally create PD handler (use static imports for `join` and `homedir` at the top of the file):
```typescript
const pdEnabled = options.pd ?? false;
let pdHandler: PDHandler | null = null;

if (pdEnabled) {
  const cacheDir = join(homedir(), ".flight", "schemas");
  pdHandler = createPDHandler(cacheDir);
}
```

4. In the upstream parser message handler, intercept `tools/list` responses and `tools/call` requests for meta-tools:

```typescript
// Inside upstreamParser "message" handler, BEFORE the normal flow section:

// PD: intercept tools/list responses
if (pdHandler && msg.result && !msg.error && msg.id != null) {
  const originalRequest = pendingClientRequests.get(msg.id);
  if (originalRequest?.method === "tools/list" && msg.result) {
    const result = msg.result as Record<string, unknown>;
    const tools = result.tools as ToolSchema[] | undefined;
    if (tools && Array.isArray(tools)) {
      pdHandler.loadSchemas(tools);
      // Replace with meta-tools
      const rewritten = {
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: pdHandler.getMetaToolSchemas() },
      };
      pendingClientRequests.delete(msg.id);
      logger.log(rewritten as JsonRpcMessage, "server->client");
      process.stdout.write(JSON.stringify(rewritten) + "\n");
      return;
    }
  }
}
```

5. In the client parser message handler, intercept `discover_tools` and `execute_tool` calls:

```typescript
// Inside clientParser "message" handler, BEFORE forwarding to upstream:

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

  if (toolName === "execute_tool") {
    const args = params.arguments as Record<string, unknown>;
    const realToolName = args?.tool_name as string;
    const realArgs = (args?.arguments ?? {}) as Record<string, unknown>;
    const resolved = pdHandler.resolveExecuteTool(realToolName, realArgs);

    if (!resolved) {
      const errResponse = {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32602, message: `Unknown tool: ${realToolName}. Use discover_tools to find available tools.` },
      };
      logger.log(msg, "client->server");
      logger.log(errResponse as JsonRpcMessage, "server->client");
      process.stdout.write(JSON.stringify(errResponse) + "\n");
      return;
    }

    // Rewrite to real tools/call
    const realRequest: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: msg.id,
      method: "tools/call",
      params: { name: resolved.toolName, arguments: resolved.arguments },
    };
    logger.log(msg, "client->server");
    if (retryEnabled && msg.id != null) {
      pendingClientRequests.set(msg.id, realRequest);
    }
    upstream.stdin!.write(JSON.stringify(realRequest) + "\n");
    return;
  }
}
```

- [ ] **Step 6: Add `--pd` flag to CLI**

In `src/cli.ts`, add to the proxy command:

```typescript
.option("--pd", "Enable progressive disclosure (replace tool schemas with meta-tools)")
  .option("--no-pd", "Disable progressive disclosure (default until validated)")
```

And pass it through:

```typescript
pd: options.pd,
```

- [ ] **Step 7: Wire `flight stats` command**

Add to `src/cli.ts`:

Add static imports at the top of `src/cli.ts`:

```typescript
import { computeStats, computeAggregateStats, formatStats, formatAggregateStats } from "./stats.js";
```

```typescript
program
  .command("stats")
  .argument("[session]", "Session ID (default: most recent, omit for aggregate)")
  .description("Show token savings and call statistics")
  .action(async (session?: string) => {
    if (session) {
      const entries = await readLogEntriesForSession(session);
      if (!entries || entries.length === 0) {
        console.log("No session data found.");
        return;
      }
      const stats = computeStats(entries);
      console.log(formatStats(stats));
    } else {
      // Aggregate mode: summarize across recent sessions
      const { readAllRecentSessions } = await import("./log-commands.js");
      const sessions = await readAllRecentSessions(10);
      if (sessions.length === 0) {
        console.log("No sessions found.");
        return;
      }
      const aggregate = computeAggregateStats(sessions);
      console.log(formatAggregateStats(aggregate));
    }
  });
```

Also add `computeAggregateStats` and `formatAggregateStats` to `src/stats.ts`:

```typescript
export interface AggregateStats {
  sessionCount: number;
  totalCalls: number;
  totalErrors: number;
  totalTokensSaved: number;
  pdSessionCount: number;
}

export function computeAggregateStats(sessions: LogEntry[][]): AggregateStats {
  let totalCalls = 0;
  let totalErrors = 0;
  let totalTokensSaved = 0;
  let pdSessionCount = 0;

  for (const entries of sessions) {
    totalCalls += entries.length;
    totalErrors += entries.filter((e) => e.error).length;
    totalTokensSaved += entries.reduce((sum, e) => sum + (e.schema_tokens_saved ?? 0), 0);
    if (entries.some((e) => e.pd_active)) pdSessionCount++;
  }

  return { sessionCount: sessions.length, totalCalls, totalErrors, totalTokensSaved, pdSessionCount };
}

export function formatAggregateStats(stats: AggregateStats): string {
  const lines: string[] = [];
  lines.push(`${C.cyan}Aggregate stats${C.reset} (${stats.sessionCount} sessions)`);
  lines.push(`  Total calls: ${stats.totalCalls}  |  Errors: ${stats.totalErrors}`);
  lines.push(`  PD sessions: ${stats.pdSessionCount}/${stats.sessionCount}`);
  lines.push(`  Total tokens saved: ~${stats.totalTokensSaved.toLocaleString()}`);
  return lines.join("\n");
}
```

And add `readAllRecentSessions` to `src/log-commands.ts`:

```typescript
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
```

- [ ] **Step 8: Run all tests and lint**

Run: `npm run check`
Expected: PASS

- [ ] **Step 9: Commit PD integration**

```bash
git add src/proxy.ts src/stats.ts src/cli.ts src/logger.ts test/stats.test.ts
git commit -m "feat: integrate progressive disclosure into proxy with stats command

Adds --pd flag to proxy. When active, intercepts tools/list and replaces
with discover_tools + execute_tool meta-tools. Adds flight stats command
for token savings reporting."
```

---

## Chunk 5: Plan Update + Final Integration

### Task 9: Update plan.md + Wire SessionEnd Summary

**Files:**
- Modify: `docs/plan.md`
- Modify: `src/hooks.ts`
- Modify: `src/index.ts`

---

- [ ] **Step 1: Update `handleSessionEnd` to run summary**

In `src/hooks.ts`, update `handleSessionEnd` to generate and output a summary:

```typescript
import { computeSummary, formatSummary } from "./summary.js";
import { readLogEntriesForSession } from "./log-commands.js";

export async function handleSessionEnd(stdinJson: string, logDir?: string): Promise<string> {
  let input: HookInput;
  try {
    input = JSON.parse(stdinJson) as HookInput;
  } catch {
    input = {};
  }

  const sessionId = input.session_id ?? "unknown";
  const dir = logDir ?? join(homedir(), ".flight", "logs");

  // Find and summarize the most recent session (reuse existing helper)
  try {
    const entries = await readLogEntriesForSession();
    if (entries && entries.length > 0) {
      const summary = computeSummary(entries);
      const formatted = formatSummary(summary);
      // Also trigger cleanup
      compressOldSessions(dir).catch(() => {});
      garbageCollect(dir).catch(() => {});
      return `\n${formatted}\n`;
    }
  } catch {
    // Summary is best-effort
  }

  return `[flight] Session ${sessionId} ended`;
}
```

- [ ] **Step 2: Update index.ts with all new exports**

```typescript
// src/index.ts
export { startProxy, type ProxyOptions } from "./proxy.js";
export { type LogEntry, type AlertEntry } from "./logger.js";
export { initClaude, initClaudeCode, getClaudeConfigPath, getClaudeCodeConfigPath, wrapWithFlight } from "./init.js";
export { runSetup, runRemove, type SetupResult, type SetupOptions } from "./setup.js";
export { installHooks, removeHooks } from "./hooks.js";
export { computeSummary, formatSummary, type SessionSummary } from "./summary.js";
export { entriesToCsv, entriesToJsonl } from "./export.js";
export { compressOldSessions, garbageCollect, pruneSessions } from "./lifecycle.js";
export { computeStats, formatStats, type SessionStats } from "./stats.js";
export { createPDHandler, type PDHandler, type ToolSchema } from "./progressive-disclosure.js";
```

- [ ] **Step 3: Update docs/plan.md with Claude Code extension note**

Add to the end of `docs/plan.md`, after the Post-v1.0 Roadmap section:

```markdown
## Future: Claude Code Extension

If Claude Code ships a formal extension/plugin API, Flight could migrate from the current
proxy + hooks architecture to a native extension. This would enable:

- Deeper UI integration (inline panels, status indicators)
- Direct access to Claude's context window for smarter PD
- No MCP config wrapping needed at all

For now, the proxy + Claude Code hooks approach (`flight setup`) is the pragmatic choice
that works with the current Claude Code architecture. The zero-config setup via hooks
(SessionStart/SessionEnd) combined with MCP config wrapping provides the best balance
of integration depth and stability.
```

- [ ] **Step 4: Run all tests and lint**

Run: `npm run check`
Expected: PASS

- [ ] **Step 5: Commit final integration**

```bash
git add src/hooks.ts src/index.ts docs/plan.md
git commit -m "feat: wire session-end summary via hooks, update exports and roadmap"
```

- [ ] **Step 6: Build and verify**

Run: `npm run build`
Expected: Clean build with no errors

- [ ] **Step 7: Manual smoke test**

```bash
# Verify all new commands are registered
flight --help
flight setup --help
flight log summary --help
flight log gc --help
flight log prune --help
flight export --help
flight stats --help
```

- [ ] **Step 8: Final commit — version bump**

Update `package.json` version to `0.2.0`:

```bash
npm version minor --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: bump version to 0.2.0 — setup, summary, export, PD features"
```
