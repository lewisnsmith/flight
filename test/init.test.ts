import { describe, it, expect, afterEach } from "vitest";
import { wrapWithFlight, initClaudeCode, getClaudeCodeConfigPath } from "../src/init.js";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

describe("wrapWithFlight", () => {
  it("wraps a simple server entry", () => {
    const result = wrapWithFlight({
      filesystem: {
        command: "mcp-server-filesystem",
        args: ["--root", "/workspace"],
      },
    });

    expect(result.filesystem.command).toBe("flight");
    expect(result.filesystem.args).toEqual([
      "proxy",
      "--cmd",
      "mcp-server-filesystem",
      "--",
      "--root",
      "/workspace",
    ]);
  });

  it("preserves env vars", () => {
    const result = wrapWithFlight({
      github: {
        command: "mcp-server-github",
        args: [],
        env: { GITHUB_TOKEN: "abc123" },
      },
    });

    expect(result.github.env).toEqual({ GITHUB_TOKEN: "abc123" });
    expect(result.github.command).toBe("flight");
  });

  it("skips already-wrapped servers", () => {
    const result = wrapWithFlight({
      already: {
        command: "flight",
        args: ["proxy", "--cmd", "some-server"],
      },
    });

    expect(result.already.command).toBe("flight");
    expect(result.already.args).toEqual(["proxy", "--cmd", "some-server"]);
  });

  it("handles server with no args", () => {
    const result = wrapWithFlight({
      simple: {
        command: "my-server",
      },
    });

    expect(result.simple.args).toEqual(["proxy", "--cmd", "my-server"]);
  });

  it("wraps multiple servers", () => {
    const result = wrapWithFlight({
      a: { command: "server-a", args: ["--flag"] },
      b: { command: "server-b" },
    });

    expect(Object.keys(result)).toEqual(["a", "b"]);
    expect(result.a.command).toBe("flight");
    expect(result.b.command).toBe("flight");
  });

  it("preserves type field", () => {
    const result = wrapWithFlight({
      myserver: {
        command: "my-mcp-server",
        args: ["--port", "3000"],
        type: "stdio",
      },
    });

    expect(result.myserver.command).toBe("flight");
    expect(result.myserver.type).toBe("stdio");
  });
});

describe("initClaudeCode", () => {
  const testDir = join(tmpdir(), `flight-init-cc-${Date.now()}`);
  const testConfigPath = join(testDir, ".claude.json");

  afterEach(async () => {
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("reads ~/.claude.json and wraps servers", async () => {
    await mkdir(testDir, { recursive: true });
    const config = {
      mcpServers: {
        filesystem: { command: "mcp-fs", args: ["--root", "/"], type: "stdio" },
      },
      globalShortcut: "Ctrl+Space",
    };
    await writeFile(testConfigPath, JSON.stringify(config));

    const origHome = process.env.HOME;
    process.env.HOME = testDir;

    try {
      const result = await initClaudeCode({ scope: "user" });
      expect(result.configFound).toBe(true);
      expect(result.serverCount).toBe(1);
      expect(result.serverNames).toEqual(["filesystem"]);
      expect(result.commands).toBeDefined();
      expect(result.commands![0]).toContain("claude mcp add-json");
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("generates example when no config found", async () => {
    const origHome = process.env.HOME;
    process.env.HOME = join(tmpdir(), `nonexistent-${Date.now()}`);

    try {
      const result = await initClaudeCode({ scope: "user" });
      expect(result.configFound).toBe(false);
      expect(result.serverCount).toBe(1); // example server
      expect(result.serverNames).toEqual(["example-server"]);
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("handles project-scope .mcp.json", async () => {
    await mkdir(testDir, { recursive: true });
    const config = {
      mcpServers: {
        local: { command: "local-mcp", type: "stdio" },
      },
    };
    const mcpPath = join(testDir, ".mcp.json");
    await writeFile(mcpPath, JSON.stringify(config));

    const origCwd = process.cwd;
    process.cwd = () => testDir;

    try {
      const result = await initClaudeCode({ scope: "project" });
      expect(result.configFound).toBe(true);
      expect(result.serverCount).toBe(1);
      expect(result.serverNames).toEqual(["local"]);
      expect(result.commands![0]).toContain("--scope project");
    } finally {
      process.cwd = origCwd;
    }
  });

  it("skips already-wrapped servers in claude-code config", async () => {
    await mkdir(testDir, { recursive: true });
    const config = {
      mcpServers: {
        wrapped: { command: "flight", args: ["proxy", "--cmd", "my-server"], type: "stdio" },
        unwrapped: { command: "other-server", type: "stdio" },
      },
    };
    await writeFile(join(testDir, ".mcp.json"), JSON.stringify(config));

    const origCwd = process.cwd;
    process.cwd = () => testDir;

    try {
      const result = await initClaudeCode({ scope: "project" });
      expect(result.serverCount).toBe(2);

      // Read the snippet to verify
      const snippetContent = await readFile(result.outputPath, "utf-8");
      const snippet = JSON.parse(snippetContent);
      // Already-wrapped should stay as-is
      expect(snippet.mcpServers.wrapped.command).toBe("flight");
      expect(snippet.mcpServers.wrapped.args).toEqual(["proxy", "--cmd", "my-server"]);
      // Unwrapped should be wrapped
      expect(snippet.mcpServers.unwrapped.command).toBe("flight");
    } finally {
      process.cwd = origCwd;
    }
  });
});
