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

  const hookResult = await installHooks(settingsPath);

  let serversWrapped = 0;
  let serverNames: string[] = [];
  let configBackedUp = false;

  try {
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as ClaudeCodeConfig;

    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      const wrapped = wrapWithFlight(config.mcpServers);

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
