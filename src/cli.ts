import { Command } from "commander";
import { createRequire } from "node:module";
import { printBanner } from "./art.js";
import { startProxy } from "./proxy.js";
import { initClaude, initClaudeCode, getClaudeConfigPath, getClaudeCodeConfigPath } from "./init.js";
import { listSessions, tailSession, viewSession, filterSessions, inspectCall, listAlerts, readLogEntriesForSession, readAllRecentSessions, listToolCalls, auditSession, verboseSession } from "./log-commands.js";
import { computeSummary, formatSummary } from "./summary.js";
import { entriesToCsv, entriesToJsonl } from "./export.js";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { runRemove, runSetupWizard } from "./setup.js";
import type { SetupFeatures } from "./setup.js";
import { handleSessionStart, handleSessionEnd, handlePostToolUseSync } from "./hooks.js";
import { compressOldSessions, garbageCollect, pruneSessions } from "./lifecycle.js";
import { computeStats, computeAggregateStats, formatStats, formatAggregateStats } from "./stats.js";
import { findCallRequest, replayCall } from "./replay.js";
import { startCollector } from "./collector.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const program = new Command();

program
  .name("flight")
  .description("Agent observability platform — structured tracing, audit, and replay for AI agent systems")
  .version(pkg.version)
  .option("--no-banner", "Suppress the pixel-art banner");

// Helper: print banner unless --no-banner was passed or env suppresses it
function banner(command: string, opts: { toStderr?: boolean } = {}): void {
  const root = program.opts<{ banner: boolean }>();
  if (root.banner === false) return;
  printBanner(command, opts);
}

// Helper: print deprecation notice and delegate
function deprecated(oldCmd: string, newCmd: string): () => void {
  return () => {
    process.stderr.write(`\x1b[33m[flight] "${oldCmd}" is deprecated. Use "${newCmd}" instead.\x1b[0m\n`);
  };
}

// ============================================================
// Top-level commands (agent-generic)
// ============================================================

program
  .command("proxy")
  .description("Start the Flight proxy for an upstream MCP server")
  .requiredOption("--cmd <command>", "Upstream MCP server command")
  .option("--quiet", "Suppress non-critical stderr output")
  .option("--no-retry", "Disable auto-retry for read-only tool calls")
  .option("--pd", "Enable progressive disclosure (compress schemas, filter unused tools)")
  .option("--pd-history <n>", "Sessions with zero usage before hiding a tool (default: 3)", "3")
  .argument("[args...]", "Arguments to pass to upstream command")
  .action(async (args: string[], options: { cmd: string; quiet?: boolean; retry: boolean; pd?: boolean; pdHistory?: string }) => {
    banner("proxy", { toStderr: true });
    await startProxy({
      command: options.cmd,
      args,
      quiet: options.quiet,
      noRetry: !options.retry,
      pd: options.pd,
      pdHistory: options.pdHistory ? parseInt(options.pdHistory, 10) : undefined,
    });
  });

program
  .command("serve")
  .description("Start the HTTP collector server for ingesting agent logs")
  .option("--port <port>", "Port to listen on", "4242")
  .option("--log-dir <dir>", "Log directory")
  .action(async (options: { port?: string; logDir?: string }) => {
    banner("serve");
    const port = parseInt(options.port ?? "4242", 10);
    const collector = await startCollector({ port, logDir: options.logDir });
    console.log(`\x1b[32m✓\x1b[0m Flight collector listening on http://localhost:${collector.port}`);
    console.log(`  POST /ingest  — send NDJSON log entries`);
    console.log(`  GET  /health  — health check`);
    console.log(`\n\x1b[2mPress Ctrl+C to stop\x1b[0m`);

    const shutdown = async () => {
      console.log(`\n\x1b[33m!\x1b[0m Shutting down...`);
      await collector.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

// ============================================================
// Log commands — inspection, analysis, export, replay
// ============================================================

const log = program.command("log").description("Inspect, analyze, and export recorded sessions");

log
  .command("list")
  .description("List all recorded sessions")
  .action(async () => {
    banner("log list");
    await listSessions();
  });

log
  .command("tail")
  .option("--session <id>", "Session ID to tail (default: most recent)")
  .description("Live stream a session")
  .action(async (options: { session?: string }) => {
    banner("log tail");
    await tailSession(options.session);
  });

log
  .command("view")
  .argument("<session>", "Session ID to view")
  .description("Paginated timeline of a session")
  .action(async (session: string) => {
    banner("log view");
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
    banner("log filter");
    await filterSessions(options);
  });

log
  .command("inspect")
  .argument("<call-id>", "Call ID to inspect")
  .option("--session <id>", "Session ID to search")
  .description("Pretty-print full request/response for a call")
  .action(async (callId: string, options: { session?: string }) => {
    banner("log inspect");
    await inspectCall(callId, options.session);
  });

log
  .command("alerts")
  .option("--limit <n>", "Number of alerts to show", "50")
  .option("--session <id>", "Filter by session ID")
  .description("Show recent alerts across all sessions")
  .action(async (options: { limit?: string; session?: string }) => {
    banner("log alerts");
    await listAlerts({ limit: options.limit ? parseInt(options.limit, 10) : undefined, session: options.session });
  });

log
  .command("summary")
  .argument("[session]", "Session ID (default: most recent)")
  .description("One-screen summary of a session")
  .action(async (session?: string) => {
    banner("log summary");
    const entries = await readLogEntriesForSession(session);
    if (!entries || entries.length === 0) {
      console.log("No session data found.");
      return;
    }
    const summary = computeSummary(entries);
    console.log(formatSummary(summary));
  });

log
  .command("tools")
  .argument("[session]", "Session ID (default: most recent)")
  .option("--tool <name>", "Filter by tool name")
  .option("--limit <n>", "Number of entries to show", "50")
  .description("Show recorded tool calls (built-in + MCP)")
  .action(async (session?: string, options?: { tool?: string; limit?: string }) => {
    banner("log tools");
    await listToolCalls(session, {
      tool: options?.tool,
      limit: options?.limit ? parseInt(options.limit, 10) : undefined,
    });
  });

log
  .command("audit")
  .argument("[session]", "Session ID (default: current active session)")
  .description("Rich audit view of tool calls for a session")
  .action(async (session?: string) => {
    banner("log audit");
    await auditSession(session);
  });

log
  .command("verbose")
  .argument("[session]", "Session ID (default: current active session)")
  .description("Comprehensive view of all tool calls with full input/output payloads")
  .action(async (session?: string) => {
    banner("log verbose");
    await verboseSession(session);
  });

log
  .command("gc")
  .option("--max-sessions <n>", "Maximum sessions to keep", "100")
  .option("--max-bytes <n>", "Maximum total bytes", String(2 * 1024 * 1024 * 1024))
  .option("--compress-after <hours>", "Compress sessions older than N hours", "24")
  .option("--dry-run", "Show what would be deleted without deleting")
  .description("Garbage-collect old session logs")
  .action(async (options: { maxSessions?: string; maxBytes?: string; compressAfter?: string; dryRun?: boolean }) => {
    banner("log gc");
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
    banner("log prune");
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

// --- Moved under log: export, stats, replay ---

log
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
    if (options.output) banner("export");
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

log
  .command("stats")
  .argument("[session]", "Session ID (default: most recent, omit for aggregate)")
  .description("Show token savings and call statistics")
  .action(async (session?: string) => {
    banner("stats");
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

log
  .command("replay")
  .argument("<call-id>", "Call ID to replay (prefix match)")
  .requiredOption("--cmd <command>", "Upstream MCP server command to replay against")
  .option("--dry-run", "Show what would be sent without executing")
  .option("--session <id>", "Session ID to search for the call")
  .argument("[args...]", "Arguments to pass to upstream command")
  .description("Re-execute a recorded tool call against an upstream MCP server")
  .action(async (callId: string, args: string[], options: { cmd: string; dryRun?: boolean; session?: string }) => {
    banner("replay");
    const entries = await readLogEntriesForSession(options.session);
    if (!entries || entries.length === 0) {
      console.error("No session data found.");
      process.exit(1);
    }

    const entry = findCallRequest(entries, callId);
    if (!entry) {
      console.error(`Call not found: ${callId}`);
      process.exit(1);
    }

    if (options.dryRun) {
      console.log("\x1b[33m--- Dry Run ---\x1b[0m");
      console.log(`\x1b[36mCommand:\x1b[0m  ${options.cmd} ${args.join(" ")}`);
      console.log(`\x1b[36mMethod:\x1b[0m   ${entry.method}`);
      if (entry.tool_name) console.log(`\x1b[36mTool:\x1b[0m     ${entry.tool_name}`);
      console.log(`\x1b[36mCall ID:\x1b[0m  ${entry.call_id}`);
      console.log();
      console.log("\x1b[2m--- Request Payload ---\x1b[0m");
      console.log(JSON.stringify(entry.payload, null, 2));
      return;
    }

    console.log(`\x1b[36mReplaying:\x1b[0m ${entry.method}${entry.tool_name ? `/${entry.tool_name}` : ""}`);
    console.log(`\x1b[36mAgainst:\x1b[0m   ${options.cmd} ${args.join(" ")}`);
    console.log();

    const result = await replayCall(entry, {
      command: options.cmd,
      args,
    });

    if (result.error) {
      console.error(`\x1b[31mError:\x1b[0m ${result.error}`);
      process.exit(1);
    }

    if (result.response) {
      if (result.response.error) {
        console.log(`\x1b[31mResult: ERROR\x1b[0m`);
        console.log(JSON.stringify(result.response.error, null, 2));
      } else {
        console.log(`\x1b[32mResult: OK\x1b[0m`);
        console.log(JSON.stringify(result.response.result, null, 2));
      }
    }
  });

// ============================================================
// Claude Code integration commands
// ============================================================

const claude = program.command("claude").description("Claude Code / Claude Desktop integration");

const claudeInit = claude.command("init").description("Configure MCP server wrapping");

claudeInit
  .command("desktop")
  .option("--apply", "Overwrite config in place (backs up original to .bak)")
  .description("Wrap Claude Desktop MCP servers with Flight proxy")
  .action(async (options: { apply?: boolean }) => {
    banner("init");
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
      console.log(`  \x1b[36mflight claude init desktop --apply\x1b[0m`);
    }
  });

claudeInit
  .command("code")
  .option("--apply", "Overwrite config in place (backs up original to .bak)")
  .option("--scope <scope>", "Config scope: user or project", "user")
  .description("Wrap Claude Code MCP servers with Flight proxy")
  .action(async (options: { apply?: boolean; scope?: string }) => {
    banner("init");
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
  });

claude
  .command("setup")
  .description("Interactive setup wizard — configure Flight hooks, proxy, and slash commands")
  .option("--remove", "Remove Flight hooks and restore original config")
  .option("--hooks", "Enable hooks (skip prompt)")
  .option("--no-hooks", "Disable hooks (skip prompt)")
  .option("--proxy", "Enable proxy wrapping (skip prompt)")
  .option("--no-proxy", "Disable proxy wrapping (skip prompt)")
  .option("--pd", "Enable progressive disclosure (skip prompt)")
  .option("--no-pd", "Disable progressive disclosure (skip prompt)")
  .option("--slash-commands", "Enable slash commands (skip prompt)")
  .option("--no-slash-commands", "Disable slash commands (skip prompt)")
  .action(async (options: {
    remove?: boolean;
    hooks?: boolean;
    proxy?: boolean;
    pd?: boolean;
    slashCommands?: boolean;
  }) => {
    if (options.remove) {
      banner("setup");
      const result = await runRemove();
      if (result.hooksRemoved) {
        console.log(`\x1b[32m✓\x1b[0m Removed Flight hooks from Claude Code settings`);
      } else {
        console.log(`\x1b[33m!\x1b[0m No Flight hooks found to remove`);
      }
      if (result.configRestored) {
        console.log(`\x1b[32m✓\x1b[0m Restored original MCP config from backup`);
      }
      if (result.slashCommandRemoved) {
        console.log(`\x1b[32m✓\x1b[0m Removed /flight and /flight-log slash commands`);
      }
      return;
    }

    const overrides: Partial<SetupFeatures> = {};
    if (options.hooks !== undefined) overrides.hooks = options.hooks;
    if (options.proxy !== undefined) overrides.proxy = options.proxy;
    if (options.pd !== undefined) overrides.pd = options.pd;
    if (options.slashCommands !== undefined) overrides.slashCommands = options.slashCommands;

    const root = program.opts<{ banner: boolean }>();
    if (root.banner === false) overrides.banner = false;

    await runSetupWizard(overrides);
  });

const claudeHooks = claude.command("hooks").description("Manage Claude Code hooks");

claudeHooks
  .command("install")
  .description("Install Flight hooks into Claude Code settings")
  .action(async () => {
    banner("hooks");
    const { installHooks } = await import("./hooks.js");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const result = await installHooks(settingsPath);
    if (result.installed) {
      console.log(`\x1b[32m✓\x1b[0m Hooks installed in ${settingsPath}`);
      if (result.backedUp) console.log(`  Backup saved to ${settingsPath}.bak`);
    } else {
      console.log(`\x1b[33m!\x1b[0m Hooks already installed`);
    }
  });

claudeHooks
  .command("remove")
  .description("Remove Flight hooks from Claude Code settings")
  .action(async () => {
    banner("hooks");
    const { removeHooks } = await import("./hooks.js");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const result = await removeHooks(settingsPath);
    if (result.removed) {
      console.log(`\x1b[32m✓\x1b[0m Hooks removed from ${settingsPath}`);
    } else {
      console.log(`\x1b[33m!\x1b[0m No Flight hooks found to remove`);
    }
  });

// ============================================================
// Hook handlers (internal, called by Claude Code hooks system)
// ============================================================

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

hook
  .command("post-tool-use")
  .description("Handle PostToolUse hook")
  .action(async () => {
    let stdin = "";
    for await (const chunk of process.stdin) {
      stdin += chunk;
    }
    const output = handlePostToolUseSync(stdin);
    process.stderr.write(output + "\n");
  });

// ============================================================
// Deprecated aliases — old command paths with deprecation notice
// ============================================================

// flight setup → flight claude setup
program
  .command("setup", { hidden: true })
  .allowUnknownOption()
  .action(async (_options, cmd) => {
    deprecated("flight setup", "flight claude setup")();
    const args = cmd.args;
    const setupCmd = claude.commands.find((c) => c.name() === "setup")!;
    await setupCmd.parseAsync(["node", "flight", ...args]);
  });

// flight init <target> → flight claude init <desktop|code>
program
  .command("init", { hidden: true })
  .argument("[target]")
  .allowUnknownOption()
  .action(async (target: string, _options, cmd) => {
    const newTarget = target === "claude-code" ? "code" : "desktop";
    deprecated(`flight init ${target}`, `flight claude init ${newTarget}`)();
    const initCmd = claudeInit.commands.find((c) => c.name() === newTarget);
    if (initCmd) {
      await initCmd.parseAsync(["node", "flight", ...cmd.args.slice(1)]);
    }
  });

// flight hooks <install|remove> → flight claude hooks <install|remove>
program
  .command("hooks", { hidden: true })
  .argument("[action]")
  .allowUnknownOption()
  .action(async (action: string) => {
    deprecated(`flight hooks ${action}`, `flight claude hooks ${action}`)();
    const hooksCmd = claudeHooks.commands.find((c) => c.name() === action);
    if (hooksCmd) {
      await hooksCmd.parseAsync(["node", "flight"]);
    }
  });

// flight export → flight log export
program
  .command("export", { hidden: true })
  .allowUnknownOption()
  .action(async (_options, cmd) => {
    deprecated("flight export", "flight log export")();
    const exportCmd = log.commands.find((c) => c.name() === "export")!;
    await exportCmd.parseAsync(["node", "flight", ...cmd.args]);
  });

// flight stats → flight log stats
program
  .command("stats", { hidden: true })
  .allowUnknownOption()
  .action(async (_options, cmd) => {
    deprecated("flight stats", "flight log stats")();
    const statsCmd = log.commands.find((c) => c.name() === "stats")!;
    await statsCmd.parseAsync(["node", "flight", ...cmd.args]);
  });

// flight replay → flight log replay
program
  .command("replay", { hidden: true })
  .allowUnknownOption()
  .action(async (_options, cmd) => {
    deprecated("flight replay", "flight log replay")();
    const replayCmd = log.commands.find((c) => c.name() === "replay")!;
    await replayCmd.parseAsync(["node", "flight", ...cmd.args]);
  });

program.parse();
