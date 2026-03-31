import { readFile, writeFile, copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { confirm } from "@inquirer/prompts";
import { wrapWithFlight } from "./init.js";
import { installHooks, removeHooks } from "./hooks.js";
import { printSetupBanner, printCompletionBanner } from "./art.js";
import { C } from "./shared.js";
import type { McpServerEntry } from "./shared.js";

const SLASH_COMMANDS = [
  {
    filename: "flight.md",
    content: `Run \`flight log audit\` to display a full audit of all tool calls from the current session.

Read the output carefully. Present a concise summary to the user:

1. **Overview** — total calls, duration, error count
2. **Tool breakdown** — which tools were used most, any with errors
3. **Issues found** — list each error with what went wrong and why (if obvious from the output)
4. **Patterns** — anything notable: repeated failures, retries, unusual sequences

If there are errors or suspicious patterns, offer to investigate the specific tool calls or help fix the underlying issues.

If the user asks about a specific tool call, you can run \`flight log tools\` with \`--tool <name>\` to filter, or read the session's \`_tools.jsonl\` file directly from \`~/.flight/logs/\` for full details.
`,
  },
  {
    filename: "flight-log.md",
    content: `Run \`flight log verbose\` to display a comprehensive view of all tool calls from the current session with full input/output payloads.

Read the output carefully and present it to the user. This is the detailed view — show everything:

1. **Overview** — session ID, duration, total calls, error count
2. **Full tool call details** — for each call, present the tool name, timestamp, complete input, complete output, and status
3. **Errors** — highlight any errors with full context so the user can understand exactly what went wrong

If the output is very long, focus on errors and notable calls first, then offer to walk through specific sections.

For a quick summary instead, the user can run \`/flight\`.
`,
  },
] as const;

interface ClaudeCodeConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export interface SetupOptions {
  homeDir?: string;
  settingsPath?: string;
  claudeCodeConfigPath?: string;
}

export interface SetupFeatures {
  hooks: boolean;
  proxy: boolean;
  pd: boolean;
  slashCommands: boolean;
  banner: boolean;
}

export interface SetupResult {
  hooksInstalled: boolean;
  serversWrapped: number;
  serverNames: string[];
  configBackedUp: boolean;
  slashCommandInstalled: boolean;
  pdEnabled: boolean;
  bannerEnabled: boolean;
}

/**
 * Prompt the user for each feature, skipping any that already have a CLI override.
 */
export async function promptFeatures(overrides: Partial<SetupFeatures>): Promise<SetupFeatures> {
  const features: SetupFeatures = {
    hooks: false,
    proxy: false,
    pd: false,
    slashCommands: false,
    banner: false,
  };

  // Hooks
  if (overrides.hooks !== undefined) {
    features.hooks = overrides.hooks;
  } else {
    features.hooks = await confirm({
      message: "Install Claude Code hooks for session recording? (SessionStart, SessionEnd, PostToolUse)",
      default: true,
    });
  }

  // Proxy wrapping
  if (overrides.proxy !== undefined) {
    features.proxy = overrides.proxy;
  } else {
    const hint = features.hooks ? "" : " (Note: hooks are disabled — proxy recording will have limited session tracking)";
    features.proxy = await confirm({
      message: `Wrap MCP servers with Flight proxy for full traffic recording?${hint}`,
      default: true,
    });
  }

  // Progressive disclosure (only if proxy is enabled)
  if (features.proxy) {
    if (overrides.pd !== undefined) {
      features.pd = overrides.pd;
    } else {
      features.pd = await confirm({
        message: "Enable progressive disclosure to compress tool schemas and save tokens?",
        default: true,
      });
    }
  }

  // Slash commands
  if (overrides.slashCommands !== undefined) {
    features.slashCommands = overrides.slashCommands;
  } else {
    features.slashCommands = await confirm({
      message: "Install /flight and /flight-log slash commands in Claude Code?",
      default: true,
    });
  }

  // Banner
  if (overrides.banner !== undefined) {
    features.banner = overrides.banner;
  } else {
    features.banner = await confirm({
      message: "Show pixel art banner when running Flight commands?",
      default: true,
    });
  }

  return features;
}

export async function runSetup(options: SetupOptions = {}, features?: SetupFeatures): Promise<SetupResult> {
  const home = options.homeDir ?? homedir();
  const settingsPath = options.settingsPath ?? join(home, ".claude", "settings.json");
  const configPath = options.claudeCodeConfigPath ?? join(home, ".claude.json");
  const flightDir = join(home, ".flight");

  await mkdir(flightDir, { recursive: true });

  // Default: enable everything (backwards-compatible for programmatic callers)
  const f = features ?? { hooks: true, proxy: true, pd: false, slashCommands: true, banner: true };

  let hooksInstalled = false;
  if (f.hooks) {
    const hookResult = await installHooks(settingsPath);
    hooksInstalled = hookResult.installed;
  }

  let serversWrapped = 0;
  let serverNames: string[] = [];
  let configBackedUp = false;

  if (f.proxy) {
    try {
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw) as ClaudeCodeConfig;

      if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
        const wrapped = wrapWithFlight(config.mcpServers, { pd: f.pd });

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
  }

  // Install /flight and /flight-log slash commands
  let slashCommandInstalled = false;
  if (f.slashCommands) {
    const commandsDir = join(home, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });
    for (const cmd of SLASH_COMMANDS) {
      try {
        const commandPath = join(commandsDir, cmd.filename);
        const existing = await readFile(commandPath, "utf-8").catch(() => null);
        if (existing !== cmd.content) {
          await writeFile(commandPath, cmd.content);
          slashCommandInstalled = true;
        }
      } catch {
        // Best-effort
      }
    }
  }

  // Save banner preference
  if (!f.banner) {
    const configFile = join(flightDir, "config.json");
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(await readFile(configFile, "utf-8"));
    } catch { /* new config */ }
    config.banner = false;
    await writeFile(configFile, JSON.stringify(config, null, 2));
  }

  return {
    hooksInstalled,
    serversWrapped,
    serverNames,
    configBackedUp,
    slashCommandInstalled,
    pdEnabled: f.pd,
    bannerEnabled: f.banner,
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

  // Remove /flight and /flight-log slash commands
  let slashCommandRemoved = false;
  for (const cmd of SLASH_COMMANDS) {
    try {
      await rm(join(home, ".claude", "commands", cmd.filename), { force: true });
      slashCommandRemoved = true;
    } catch {
      // Already gone
    }
  }

  // Remove banner config
  const flightDir = join(home, ".flight");
  try {
    const configFile = join(flightDir, "config.json");
    const config = JSON.parse(await readFile(configFile, "utf-8"));
    delete config.banner;
    await writeFile(configFile, JSON.stringify(config, null, 2));
  } catch { /* no config to clean */ }

  return { hooksRemoved: hookResult.removed, configRestored, slashCommandRemoved };
}

/**
 * Run the full interactive setup wizard.
 */
export async function runSetupWizard(
  cliOverrides: Partial<SetupFeatures>,
  options: SetupOptions = {},
): Promise<void> {
  // Show setup banner
  printSetupBanner();

  console.log(`  ${C.dim}Configure which Flight features to enable:${C.reset}\n`);

  // Prompt for features (skipping any with CLI overrides)
  const features = await promptFeatures(cliOverrides);

  console.log();

  const result = await runSetup(options, features);

  // Print results
  if (features.hooks) {
    if (result.hooksInstalled) {
      console.log(`${C.green}  ✓${C.reset} Installed Claude Code hooks (SessionStart, SessionEnd, PostToolUse)`);
    } else {
      console.log(`${C.yellow}  !${C.reset} Hooks already installed`);
    }
  } else {
    console.log(`${C.dim}  - Hooks: skipped${C.reset}`);
  }

  if (features.proxy) {
    if (result.serversWrapped > 0) {
      console.log(`${C.green}  ✓${C.reset} Wrapped ${result.serversWrapped} MCP server(s): ${result.serverNames.join(", ")}`);
      if (result.configBackedUp) {
        console.log(`    Backup saved to ~/.claude.json.bak`);
      }
    } else if (result.serverNames.length > 0) {
      console.log(`${C.yellow}  !${C.reset} All ${result.serverNames.length} server(s) already wrapped`);
    } else {
      console.log(`${C.yellow}  !${C.reset} No MCP servers found in ~/.claude.json`);
    }
    if (result.pdEnabled) {
      console.log(`${C.green}  ✓${C.reset} Progressive disclosure enabled`);
    }
  } else {
    console.log(`${C.dim}  - Proxy wrapping: skipped${C.reset}`);
  }

  if (features.slashCommands) {
    if (result.slashCommandInstalled) {
      console.log(`${C.green}  ✓${C.reset} Installed /flight and /flight-log slash commands`);
    } else {
      console.log(`${C.yellow}  !${C.reset} /flight and /flight-log slash commands already installed`);
    }
  } else {
    console.log(`${C.dim}  - Slash commands: skipped${C.reset}`);
  }

  if (!features.banner) {
    console.log(`${C.dim}  - Banner: disabled for future commands${C.reset}`);
  }

  console.log();

  // Show completion art
  printCompletionBanner();

  console.log(`  Run ${C.cyan}/flight${C.reset} in Claude Code for a quick session summary.`);
  console.log(`  Run ${C.cyan}/flight-log${C.reset} for a comprehensive view with full payloads.`);
  console.log(`  Run ${C.cyan}flight log tail${C.reset} in another terminal to watch live.\n`);
}
