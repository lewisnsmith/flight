import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installHooks, removeHooks, handleSessionStart, handlePostToolUseSync } from "../src/hooks.js";

describe("installHooks", () => {
  const testDir = join(tmpdir(), `flight-hooks-${Date.now()}`);
  const settingsPath = join(testDir, ".claude", "settings.json");

  afterEach(async () => {
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("installs SessionStart, SessionEnd, and PostToolUse hooks into settings.json", async () => {
    await mkdir(join(testDir, ".claude"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({}));

    await installHooks(settingsPath);

    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.SessionEnd).toBeDefined();
    expect(settings.hooks.PostToolUse).toBeDefined();
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain("flight hook post-tool-use");
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
    const flightHooks = settings.hooks.SessionStart.filter(
      (h: Record<string, unknown>) => JSON.stringify(h).includes("flight")
    );
    expect(flightHooks.length).toBe(1);
  });
});

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

describe("handlePostToolUseSync", () => {
  const testLogDir = join(tmpdir(), `flight-post-tool-${Date.now()}`);

  afterEach(async () => {
    try { await rm(testLogDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("writes correct JSONL to log file", async () => {
    await mkdir(testLogDir, { recursive: true });
    await writeFile(join(testLogDir, ".active_session"), "sess-abc");

    const stdin = JSON.stringify({
      session_id: "sess-abc",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/foo.txt" },
      tool_output: "file contents here",
    });

    const output = handlePostToolUseSync(stdin, testLogDir);
    expect(output).toContain("Read");

    const logContent = await readFile(join(testLogDir, "sess-abc_tools.jsonl"), "utf-8");
    const entry = JSON.parse(logContent.trim());
    expect(entry.session_id).toBe("sess-abc");
    expect(entry.tool_name).toBe("Read");
    expect(entry.tool_input).toEqual({ file_path: "/tmp/foo.txt" });
    expect(entry.tool_output).toBe("file contents here");
    expect(entry.tool_output_truncated).toBe(false);
  });

  it("truncates large tool_output at 4096 chars", async () => {
    await mkdir(testLogDir, { recursive: true });
    await writeFile(join(testLogDir, ".active_session"), "sess-trunc");

    const largeOutput = "x".repeat(8000);
    const stdin = JSON.stringify({
      session_id: "sess-trunc",
      tool_name: "Bash",
      tool_input: { command: "cat big.txt" },
      tool_output: largeOutput,
    });

    handlePostToolUseSync(stdin, testLogDir);

    const logContent = await readFile(join(testLogDir, "sess-trunc_tools.jsonl"), "utf-8");
    const entry = JSON.parse(logContent.trim());
    expect(entry.tool_output.length).toBe(4096);
    expect(entry.tool_output_truncated).toBe(true);
  });

  it("falls back to stdin session_id when no active session marker", async () => {
    await mkdir(testLogDir, { recursive: true });
    // No .active_session file

    const stdin = JSON.stringify({
      session_id: "stdin-sess-id",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/out.txt" },
      tool_output: "ok",
    });

    handlePostToolUseSync(stdin, testLogDir);

    const logContent = await readFile(join(testLogDir, "stdin-sess-id_tools.jsonl"), "utf-8");
    const entry = JSON.parse(logContent.trim());
    expect(entry.session_id).toBe("stdin-sess-id");
  });

  it("handles malformed stdin gracefully", () => {
    const output = handlePostToolUseSync("not valid json", testLogDir);
    expect(output).toContain("invalid stdin JSON");
  });

  it("handles empty stdin gracefully", () => {
    const output = handlePostToolUseSync("", testLogDir);
    expect(output).toContain("invalid stdin JSON");
  });
});
