import { Command } from "commander";
import { startProxy } from "./proxy.js";
import { initClaude, getClaudeConfigPath } from "./init.js";
import { listSessions, tailSession, viewSession, filterSessions, inspectCall } from "./log-commands.js";

const program = new Command();

program
  .name("flight")
  .description("MCP flight recorder and token optimizer for AI coding agents")
  .version("0.1.0");

program
  .command("proxy")
  .description("Start the Flight proxy for an upstream MCP server")
  .requiredOption("--cmd <command>", "Upstream MCP server command")
  .argument("[args...]", "Arguments to pass to upstream command")
  .action(async (args: string[], options: { cmd: string }) => {
    await startProxy({
      command: options.cmd,
      args,
    });
  });

program
  .command("init")
  .argument("<target>", 'Target to initialize (e.g. "claude")')
  .option("--apply", "Overwrite config in place (backs up original to .bak)")
  .description("Generate config for a target MCP client")
  .action(async (target: string, options: { apply?: boolean }) => {
    if (target !== "claude") {
      console.error(`Unknown target: ${target}. Supported: claude`);
      process.exit(1);
    }

    const result = await initClaude({ apply: options.apply });

    if (result.configFound) {
      console.log(`\x1b[32m✓\x1b[0m Found existing config: ${getClaudeConfigPath()}`);
      console.log(`\x1b[32m✓\x1b[0m Discovered ${result.serverCount} MCP server(s): ${result.serverNames.join(", ")}`);
    } else {
      console.log(`\x1b[33m!\x1b[0m No existing config found. Generated example snippet.`);
    }

    if (result.applied) {
      console.log(`\x1b[32m✓\x1b[0m Config applied to: ${result.outputPath}`);
      console.log(`  Backup saved to: ${result.outputPath}.bak`);
    } else {
      console.log(`\x1b[32m✓\x1b[0m Wrapped config written to: ${result.outputPath}`);
      console.log(`  Review and merge into your claude_desktop_config.json, or run:`);
      console.log(`  \x1b[36mflight init claude --apply\x1b[0m`);
    }
  });

// --- Log commands ---

const log = program.command("log").description("Inspect recorded sessions");

log
  .command("list")
  .description("List all recorded sessions")
  .action(async () => {
    await listSessions();
  });

log
  .command("tail")
  .option("--session <id>", "Session ID to tail (default: most recent)")
  .description("Live stream a session")
  .action(async (options: { session?: string }) => {
    await tailSession(options.session);
  });

log
  .command("view")
  .argument("<session>", "Session ID to view")
  .description("Paginated timeline of a session")
  .action(async (session: string) => {
    await viewSession(session);
  });

log
  .command("filter")
  .option("--tool <name>", "Filter by tool name")
  .option("--errors", "Show only failed calls")
  .option("--hallucinations", "Show calls with hallucination hints")
  .option("--session <id>", "Session ID (default: most recent)")
  .description("Filter session logs")
  .action(async (options: { tool?: string; errors?: boolean; hallucinations?: boolean; session?: string }) => {
    await filterSessions(options);
  });

log
  .command("inspect")
  .argument("<call-id>", "Call ID to inspect")
  .option("--session <id>", "Session ID to search")
  .description("Pretty-print full request/response for a call")
  .action(async (callId: string, options: { session?: string }) => {
    await inspectCall(callId, options.session);
  });

program.parse();
