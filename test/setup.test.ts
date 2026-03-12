import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSetup, runRemove } from "../src/setup.js";

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

    const config = JSON.parse(await readFile(join(testDir, ".claude.json"), "utf-8"));
    expect(config.mcpServers.myserver.command).toBe("flight");

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

describe("runRemove", () => {
  const testDir = join(tmpdir(), `flight-remove-${Date.now()}`);

  afterEach(async () => {
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("removes hooks and restores config from backup", async () => {
    const claudeDir = join(testDir, ".claude");
    await mkdir(claudeDir, { recursive: true });

    const originalConfig = JSON.stringify({ mcpServers: { myserver: { command: "my-mcp" } } });
    await writeFile(join(testDir, ".claude.json"), originalConfig);
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify({}));

    // Setup first
    await runSetup({
      homeDir: testDir,
      settingsPath: join(claudeDir, "settings.json"),
      claudeCodeConfigPath: join(testDir, ".claude.json"),
    });

    // Then remove
    const result = await runRemove({
      homeDir: testDir,
      settingsPath: join(claudeDir, "settings.json"),
      claudeCodeConfigPath: join(testDir, ".claude.json"),
    });

    expect(result.hooksRemoved).toBe(true);
    expect(result.configRestored).toBe(true);

    // Config should be restored to original
    const restored = await readFile(join(testDir, ".claude.json"), "utf-8");
    expect(JSON.parse(restored).mcpServers.myserver.command).toBe("my-mcp");
  });
});
