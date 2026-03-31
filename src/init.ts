import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
}

interface ClaudeDesktopConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export function getClaudeConfigPath(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return join(home, ".config", "Claude", "claude_desktop_config.json");
  }
}

export function wrapWithFlight(servers: Record<string, McpServerEntry>): Record<string, McpServerEntry> {
  const wrapped: Record<string, McpServerEntry> = {};

  for (const [name, server] of Object.entries(servers)) {
    // Skip if already wrapped (direct invocation or via npx)
    if (server.command === "flight" || server.command === "flight-proxy") {
      wrapped[name] = server;
      continue;
    }
    if (server.args?.[0] === "flight" && server.args?.[1] === "proxy") {
      wrapped[name] = server;
      continue;
    }

    const args = ["proxy", "--pd", "--cmd", server.command];
    if (server.args && server.args.length > 0) {
      args.push("--", ...server.args);
    }

    wrapped[name] = {
      command: "flight",
      args,
      ...(server.env ? { env: server.env } : {}),
      ...(server.type ? { type: server.type } : {}),
    };
  }

  return wrapped;
}

export interface InitResult {
  configFound: boolean;
  serverCount: number;
  serverNames: string[];
  outputPath: string;
  applied: boolean;
  commands?: string[];
}

export interface ClaudeCodeInitOptions {
  apply?: boolean;
  scope?: "user" | "project";
}

export function getClaudeCodeConfigPath(scope: "user" | "project" = "user"): string {
  if (scope === "project") {
    return join(process.cwd(), ".mcp.json");
  }
  return join(homedir(), ".claude.json");
}

export async function initClaudeCode(options: ClaudeCodeInitOptions = {}): Promise<InitResult> {
  const scope = options.scope ?? "user";
  const configPath = getClaudeCodeConfigPath(scope);
  const flightDir = join(homedir(), ".flight");

  await mkdir(flightDir, { recursive: true });

  let config: ClaudeDesktopConfig;
  let configFound = false;

  try {
    const raw = await readFile(configPath, "utf-8");
    config = JSON.parse(raw) as ClaudeDesktopConfig;
    configFound = true;
  } catch {
    config = {
      mcpServers: {
        "example-server": {
          command: "your-mcp-server",
          args: ["--your-flag"],
          type: "stdio",
        },
      },
    };
  }

  const servers = config.mcpServers ?? {};
  const serverNames = Object.keys(servers);
  const wrapped = wrapWithFlight(servers);

  if (options.apply && configFound) {
    // Backup original
    await copyFile(configPath, configPath + ".bak");
    const output: ClaudeDesktopConfig = { ...config, mcpServers: wrapped };
    await writeFile(configPath, JSON.stringify(output, null, 2), "utf-8");

    return {
      configFound,
      serverCount: serverNames.length,
      serverNames,
      outputPath: configPath,
      applied: true,
    };
  }

  // Non-apply mode: print claude mcp add-json commands (only for real configs)
  const commands: string[] = [];
  if (configFound) {
    for (const [name, server] of Object.entries(wrapped)) {
      const json = JSON.stringify(server);
      // Escape single quotes for shell safety: replace ' with '\''
      const escapedJson = json.replace(/'/g, "'\\''");
      const escapedName = name.replace(/'/g, "'\\''");
      const scopeFlag = scope === "project" ? " --scope project" : "";
      commands.push(`claude mcp add-json '${escapedName}' '${escapedJson}'${scopeFlag}`);
    }
  }

  // Also write snippet for reference
  const snippetPath = join(flightDir, `claude_code_config_snippet_${scope}.json`);
  const output: ClaudeDesktopConfig = { ...config, mcpServers: wrapped };
  await writeFile(snippetPath, JSON.stringify(output, null, 2), "utf-8");

  return {
    configFound,
    serverCount: serverNames.length,
    serverNames,
    outputPath: snippetPath,
    applied: false,
    commands,
  };
}

export async function initClaude(options: { apply?: boolean } = {}): Promise<InitResult> {
  const configPath = getClaudeConfigPath();
  const flightDir = join(homedir(), ".flight");
  const snippetPath = join(flightDir, "claude_desktop_config_snippet.json");

  await mkdir(flightDir, { recursive: true });

  let config: ClaudeDesktopConfig;
  let configFound = false;

  try {
    const raw = await readFile(configPath, "utf-8");
    config = JSON.parse(raw) as ClaudeDesktopConfig;
    configFound = true;
  } catch {
    // No existing config — generate example
    config = {
      mcpServers: {
        "example-server": {
          command: "your-mcp-server",
          args: ["--your-flag"],
        },
      },
    };
  }

  const servers = config.mcpServers ?? {};
  const serverNames = Object.keys(servers);
  const wrapped = wrapWithFlight(servers);

  const output: ClaudeDesktopConfig = {
    ...config,
    mcpServers: wrapped,
  };

  const outputJson = JSON.stringify(output, null, 2);

  if (options.apply && configFound) {
    // Backup original
    await copyFile(configPath, configPath + ".bak");
    await writeFile(configPath, outputJson, "utf-8");
    // Also write snippet for reference
    await writeFile(snippetPath, outputJson, "utf-8");

    return {
      configFound,
      serverCount: serverNames.length,
      serverNames,
      outputPath: configPath,
      applied: true,
    };
  }

  // Write snippet only
  await writeFile(snippetPath, outputJson, "utf-8");

  return {
    configFound,
    serverCount: serverNames.length,
    serverNames,
    outputPath: snippetPath,
    applied: false,
  };
}
