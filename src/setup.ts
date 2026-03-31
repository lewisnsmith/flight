import { readFile, writeFile, copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { wrapWithFlight } from "./init.js";
import { installHooks, removeHooks } from "./hooks.js";

const SLASH_COMMAND_FILENAME = "flight-log.md";

const SLASH_COMMAND_CONTENT = `Run \`flight log audit\` to display a full audit of all tool calls from the current session.
Also run \`flight stats\` to include token efficiency data.

Read the output carefully. Present a concise summary to the user:

1. **Overview** — total calls, duration, error count, tokens saved (if PD active)
2. **Tool breakdown** — which tools were used most, any with errors
3. **Issues found** — list each error with what went wrong and why (if obvious from the output)
4. **Patterns** — anything notable: repeated failures, retries, unusual sequences

If there are errors or suspicious patterns, offer to investigate the specific tool calls or help fix the underlying issues.

If the user asks about a specific tool call, you can run \`flight log tools\` with \`--tool <name>\` to filter, or read the session's \`_tools.jsonl\` file directly from \`~/.flight/logs/\` for full details.
`;

const SUMMARY_COMMAND_FILENAME = "flight-summary.md";

const SUMMARY_COMMAND_CONTENT = `Run these two commands and combine their output into a single session overview:

1. \`flight log summary\` — session timeline and call breakdown
2. \`flight stats\` — token efficiency data

Present the results as a single concise summary:

**Session Overview**
- Duration, total calls, error count, hallucination hints
- Top tools used (with call counts)
- Timeline visualization (x = error, ! = hallucination hint)
- Token efficiency: tokens saved by schema compression (if PD is active), PD phase

If errors occurred, briefly note which tools failed.
If no sessions are found, explain that sessions are recorded when the flight proxy is running or hooks are installed.
`;

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
  slashCommandInstalled: boolean;
  summaryCommandInstalled: boolean;
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

  // Install /flight-log slash command
  const commandsDir = join(home, ".claude", "commands");
  await mkdir(commandsDir, { recursive: true });
  const commandPath = join(commandsDir, SLASH_COMMAND_FILENAME);
  let slashCommandInstalled = false;
  try {
    const existing = await readFile(commandPath, "utf-8").catch(() => null);
    if (existing !== SLASH_COMMAND_CONTENT) {
      await writeFile(commandPath, SLASH_COMMAND_CONTENT);
      slashCommandInstalled = true;
    }
  } catch {
    // Best-effort
  }

  // Install /flight-summary slash command
  const summaryCommandPath = join(commandsDir, SUMMARY_COMMAND_FILENAME);
  let summaryCommandInstalled = false;
  try {
    const existing = await readFile(summaryCommandPath, "utf-8").catch(() => null);
    if (existing !== SUMMARY_COMMAND_CONTENT) {
      await writeFile(summaryCommandPath, SUMMARY_COMMAND_CONTENT);
      summaryCommandInstalled = true;
    }
  } catch {
    // Best-effort
  }

  return {
    hooksInstalled: hookResult.installed,
    serversWrapped,
    serverNames,
    configBackedUp,
    slashCommandInstalled,
    summaryCommandInstalled,
  };
}

export async function runRemove(options: SetupOptions = {}): Promise<{ hooksRemoved: boolean; configRestored: boolean; slashCommandRemoved: boolean }> {
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

  // Remove /flight-log slash command
  let slashCommandRemoved = false;
  const commandPath = join(home, ".claude", "commands", SLASH_COMMAND_FILENAME);
  try {
    await rm(commandPath, { force: true });
    slashCommandRemoved = true;
  } catch {
    // Already gone
  }

  // Remove /flight-summary slash command
  const summaryCommandPath = join(home, ".claude", "commands", SUMMARY_COMMAND_FILENAME);
  try {
    await rm(summaryCommandPath, { force: true });
  } catch {
    // Already gone
  }

  return { hooksRemoved: hookResult.removed, configRestored, slashCommandRemoved };
}
