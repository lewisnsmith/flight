import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installHooks, removeHooks, handleSessionStart } from "../src/hooks.js";

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
