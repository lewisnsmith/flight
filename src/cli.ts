import { Command } from "commander";
import { createRequire } from "node:module";
import { startProxy } from "./proxy.js";
import { initClaude, initClaudeCode, getClaudeConfigPath, getClaudeCodeConfigPath } from "./init.js";
import { listSessions, tailSession, viewSession, filterSessions, inspectCall, listAlerts, readLogEntriesForSession, readAllRecentSessions } from "./log-commands.js";
import { computeSummary, formatSummary } from "./summary.js";
import { entriesToCsv, entriesToJsonl } from "./export.js";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { runSetup, runRemove } from "./setup.js";
import { handleSessionStart, handleSessionEnd } from "./hooks.js";
import { compressOldSessions, garbageCollect, pruneSessions } from "./lifecycle.js";
import { computeStats, computeAggregateStats, formatStats, formatAggregateStats } from "./stats.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const program = new Command();

program
  .name("flight")
  .description("MCP flight recorder and token optimizer for AI coding agents")
  .version(pkg.version);

program
  .command("proxy")
  .description("Start the Flight proxy for an upstream MCP server")
  .requiredOption("--cmd <command>", "Upstream MCP server command")
  .option("--quiet", "Suppress non-critical stderr output")
  .option("--no-retry", "Disable auto-retry for read-only tool calls")
  .option("--pd", "Enable progressive disclosure (replace tool schemas with meta-tools)")
  .argument("[args...]", "Arguments to pass to upstream command")
  .action(async (args: string[], options: { cmd: string; quiet?: boolean; retry: boolean; pd?: boolean }) => {
    await startProxy({
      command: options.cmd,
      args,
      quiet: options.quiet,
      noRetry: !options.retry,
      pd: options.pd,
    });
  });

program
  .command("init")
  .argument("<target>", 'Target to initialize ("claude" or "claude-code")')
  .option("--apply", "Overwrite config in place (backs up original to .bak)")
  .option("--scope <scope>", "Config scope for claude-code: user or project", "user")
  .description("Generate config for a target MCP client")
  .action(async (target: string, options: { apply?: boolean; scope?: string }) => {
    if (target === "claude") {
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
    } else if (target === "claude-code") {
      const scope = (options.scope === "project" ? "project" : "user") as "user" | "project";
      const result = await initClaudeCode({ apply: options.apply, scope });
      const configPath = getClaudeCodeConfigPath(scope);

      if (result.configFound) {
        console.log(`\x1b[32m✓\x1b[0m Found existing config: ${configPath}`);
        console.log(`\x1b[32m✓\x1b[0m Discovered ${result.serverCount} MCP server(s): ${result.serverNames.join(", ")}`);
      } else {
        console.log(`\x1b[33m!\x1b[0m No existing config found. Generated example snippet.`);
      }

      if (result.applied) {
        console.log(`\x1b[32m✓\x1b[0m Config applied to: ${result.outputPath}`);
        console.log(`  Backup saved to: ${result.outputPath}.bak`);
      } else {
        console.log(`\x1b[32m✓\x1b[0m Wrapped config written to: ${result.outputPath}`);
        if (result.commands && result.commands.length > 0) {
          console.log(`\n  Or run these commands to add servers individually:\n`);
          for (const cmd of result.commands) {
            console.log(`  \x1b[36m${cmd}\x1b[0m`);
          }
        }
      }
    } else {
      console.error(`Unknown target: ${target}. Supported: claude, claude-code`);
      process.exit(1);
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

log
  .command("alerts")
  .option("--limit <n>", "Number of alerts to show", "50")
  .option("--session <id>", "Filter by session ID")
  .description("Show recent alerts across all sessions")
  .action(async (options: { limit?: string; session?: string }) => {
    await listAlerts({ limit: options.limit ? parseInt(options.limit, 10) : undefined, session: options.session });
  });

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

log
  .command("gc")
  .option("--max-sessions <n>", "Maximum sessions to keep", "100")
  .option("--max-bytes <n>", "Maximum total bytes", String(2 * 1024 * 1024 * 1024))
  .option("--compress-after <hours>", "Compress sessions older than N hours", "24")
  .option("--dry-run", "Show what would be deleted without deleting")
  .description("Garbage-collect old session logs")
  .action(async (options: { maxSessions?: string; maxBytes?: string; compressAfter?: string; dryRun?: boolean }) => {
    const maxAgeMs = (parseInt(options.compressAfter ?? "24", 10)) * 60 * 60 * 1000;
    const compressResult = await compressOldSessions(undefined, { maxAgeMs });
    if (compressResult.compressed > 0) {
      console.log(`\x1b[32m✓\x1b[0m Compressed ${compressResult.compressed} old session(s)`);
    }

    const gcResult = await garbageCollect(undefined, {
      maxSessions: parseInt(options.maxSessions ?? "100", 10),
      maxBytes: parseInt(options.maxBytes ?? String(2 * 1024 * 1024 * 1024), 10),
      dryRun: options.dryRun,
    });

    if (gcResult.dryRun) {
      console.log(`\x1b[33m!\x1b[0m Dry run: would delete ${gcResult.deleted} session(s), freeing ${(gcResult.freedBytes / 1024 / 1024).toFixed(1)} MB`);
    } else if (gcResult.deleted > 0) {
      console.log(`\x1b[32m✓\x1b[0m Deleted ${gcResult.deleted} session(s), freed ${(gcResult.freedBytes / 1024 / 1024).toFixed(1)} MB`);
    } else {
      console.log(`\x1b[32m✓\x1b[0m Nothing to clean up`);
    }
  });

log
  .command("prune")
  .option("--before <date>", "Delete sessions before this date (ISO 8601)")
  .option("--keep <n>", "Keep only the N most recent sessions")
  .description("Prune session logs by date or count")
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
    const result = await pruneSessions(undefined, pruneOpts);
    if (result.deleted > 0) {
      console.log(`\x1b[32m✓\x1b[0m Pruned ${result.deleted} session(s)`);
    } else {
      console.log(`\x1b[32m✓\x1b[0m Nothing to prune`);
    }
  });

// --- Export command ---

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

// --- Stats command ---

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
      const sessions = await readAllRecentSessions(10);
      if (sessions.length === 0) {
        console.log("No sessions found.");
        return;
      }
      const aggregate = computeAggregateStats(sessions);
      console.log(formatAggregateStats(aggregate));
    }
  });

// --- Setup command ---

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

// --- Hook commands (internal, called by Claude Code) ---

const hook = new Command("hook").description("Internal hook handlers (called by Claude Code)");
program.addCommand(hook);

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

program.parse();
