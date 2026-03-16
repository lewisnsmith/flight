#!/usr/bin/env npx tsx
/**
 * Claude API-driven PD validation.
 *
 * Sends real prompts to Claude through the Flight proxy wrapping a mock MCP server.
 * Claude decides which tools to call — this tests whether PD (compression +
 * usage-adaptive filtering) degrades real AI task completion vs direct tool access.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx test/simulate/validate-claude-api.ts
 *
 * Options:
 *   --model <id>       Claude model to use (default: claude-sonnet-4-20250514)
 *   --tasks <n>        Number of tasks per condition (default: 5)
 *   --server <type>    Mock server: fs, git, web (default: fs)
 *   --verbose          Print full Claude responses
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { LogEntry } from "../../src/logger.js";

const MOCK_SERVERS: Record<string, string> = {
  fs: join(import.meta.dirname, "mock-fs-server.ts"),
  git: join(import.meta.dirname, "mock-git-server.ts"),
  web: join(import.meta.dirname, "mock-web-server.ts"),
};
const PROXY_MODULE = join(import.meta.dirname, "..", "..", "src", "proxy.ts");

// ── Tasks for Claude to complete ──────────────────────────────────────

interface Task {
  name: string;
  prompt: string;
  server: "fs" | "git" | "web";
  /** How to check if Claude completed the task */
  successCheck: (toolCalls: ToolCallRecord[]) => boolean;
}

interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  result: string | null;
  error: string | null;
}

/** Get the effective tool name (no wrapper resolution needed with new PD) */
function effectiveTool(c: ToolCallRecord): string {
  return c.tool;
}

const TASKS: Task[] = [
  {
    name: "read-and-summarize",
    prompt: "Read the file at /src/index.ts and tell me what it exports.",
    server: "fs",
    successCheck: (calls) => calls.some((c) => effectiveTool(c) === "read_file" && c.result !== null),
  },
  {
    name: "find-and-read",
    prompt: "Search for files related to 'config' in the project, then read the most relevant one.",
    server: "fs",
    successCheck: (calls) => {
      const searched = calls.some((c) => effectiveTool(c) === "search_files" || effectiveTool(c) === "list_directory");
      const read = calls.some((c) => effectiveTool(c) === "read_file" && c.result !== null);
      return searched && read;
    },
  },
  {
    name: "create-file",
    prompt: "Create a new file at /src/utils/helpers.ts with a function called 'formatDate' that takes a Date and returns an ISO string.",
    server: "fs",
    successCheck: (calls) =>
      calls.some((c) => effectiveTool(c) === "write_file" && c.result !== null && String(c.args.path ?? (c.args.arguments as Record<string, unknown> | undefined)?.path ?? "").includes("helpers")),
  },
  {
    name: "list-and-explore",
    prompt: "List the /src directory, then read the first TypeScript file you find.",
    server: "fs",
    successCheck: (calls) => {
      const listed = calls.some((c) => effectiveTool(c) === "list_directory");
      const read = calls.some((c) => effectiveTool(c) === "read_file" && c.result !== null);
      return listed && read;
    },
  },
  {
    name: "check-existence",
    prompt: "Check if /package.json exists, and if it does, read it and tell me the project name.",
    server: "fs",
    successCheck: (calls) => {
      const checked = calls.some((c) => effectiveTool(c) === "file_exists" || effectiveTool(c) === "read_file");
      const read = calls.some((c) => effectiveTool(c) === "read_file" && c.result !== null);
      return checked && read;
    },
  },
  {
    name: "git-status-check",
    prompt: "Check the git status and tell me what files have been modified.",
    server: "git",
    successCheck: (calls) => calls.some((c) => effectiveTool(c) === "git_status" && c.result !== null),
  },
  {
    name: "git-history",
    prompt: "Show me the last 5 commits in the git log.",
    server: "git",
    successCheck: (calls) => calls.some((c) => effectiveTool(c) === "git_log" && c.result !== null),
  },
  {
    name: "git-diff-review",
    prompt: "Show the current diff and summarize what changed.",
    server: "git",
    successCheck: (calls) => calls.some((c) => effectiveTool(c) === "git_diff" && c.result !== null),
  },
  {
    name: "web-fetch",
    prompt: "Fetch the URL https://api.example.com/data and tell me what it returns.",
    server: "web",
    successCheck: (calls) => calls.some((c) => effectiveTool(c) === "fetch_url" && c.result !== null),
  },
  {
    name: "web-search",
    prompt: "Search the web for 'TypeScript best practices 2024' and summarize the results.",
    server: "web",
    successCheck: (calls) => calls.some((c) => effectiveTool(c) === "search_web" && c.result !== null),
  },
];

// ── Proxy Handle ──────────────────────────────────────────────────────

interface ProxyHandle {
  child: ChildProcess;
  send: (msg: Record<string, unknown>) => void;
  waitForResponse: (id: number, timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => void;
  logDir: string;
}

function spawnProxy(serverType: string, pd: boolean): ProxyHandle {
  const mockServerPath = MOCK_SERVERS[serverType];
  if (!mockServerPath) throw new Error(`Unknown server: ${serverType}`);

  const logDir = join(tmpdir(), `flight-claude-api-${pd ? "pd" : "pt"}-${Date.now()}`);
  const proxyModulePath = PROXY_MODULE.replace(/\\/g, "/");
  const mockPath = mockServerPath.replace(/\\/g, "/");
  const logDirPath = logDir.replace(/\\/g, "/");

  const child = spawn("npx", ["tsx", "-e", `
    import { startProxy } from "${proxyModulePath}";
    startProxy({
      command: "npx",
      args: ["tsx", "${mockPath}"],
      logDir: "${logDirPath}",
      quiet: true,
      pd: ${pd},
    });
  `], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pendingResponses = new Map<number, {
    resolve: (v: Record<string, unknown>) => void;
    reject: (e: Error) => void;
  }>();

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line.trim());
        if (msg.id != null && pendingResponses.has(msg.id)) {
          pendingResponses.get(msg.id)!.resolve(msg);
          pendingResponses.delete(msg.id);
        }
      } catch {
        // ignore
      }
    });
  }

  function send(msg: Record<string, unknown>): void {
    child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  function waitForResponse(id: number, timeoutMs = 15000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingResponses.delete(id);
        reject(new Error(`Timeout waiting for response to id=${id}`));
      }, timeoutMs);

      pendingResponses.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  function close(): void {
    child.stdin!.end();
    child.kill();
  }

  return { child, send, waitForResponse, close, logDir };
}

// ── Claude API Client ─────────────────────────────────────────────────

interface ClaudeMessage {
  role: "user" | "assistant";
  content: unknown;
}

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

async function callClaude(
  messages: ClaudeMessage[],
  tools: ToolDefinition[],
  model: string,
): Promise<{ content: unknown[]; stop_reason: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages,
      tools,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error ${response.status}: ${text}`);
  }

  const data = await response.json() as { content: unknown[]; stop_reason: string };
  return data;
}

// ── Task Runner ───────────────────────────────────────────────────────

interface TaskResult {
  task: string;
  pd: boolean;
  completed: boolean;
  toolCalls: number;
  roundTrips: number;
  error: string | null;
  durationMs: number;
  tokensSaved: number;
}

async function runTask(
  task: Task,
  pd: boolean,
  model: string,
  verbose: boolean,
): Promise<TaskResult> {
  const start = Date.now();
  const proxy = spawnProxy(task.server, pd);
  const toolCalls: ToolCallRecord[] = [];
  let error: string | null = null;
  let roundTrips = 0;

  try {
    // MCP handshake
    let nextId = 1;

    proxy.send({ jsonrpc: "2.0", id: nextId, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-api-validator", version: "1.0" } } });
    await proxy.waitForResponse(nextId++);

    proxy.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    // Get tools list (may be PD meta-tools or real tools)
    proxy.send({ jsonrpc: "2.0", id: nextId, method: "tools/list", params: {} });
    const toolsResponse = await proxy.waitForResponse(nextId++);
    const mcpTools = ((toolsResponse.result as Record<string, unknown>)?.tools ?? []) as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;

    // Convert MCP tools to Claude API tool format
    const claudeTools: ToolDefinition[] = mcpTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));

    if (verbose) {
      process.stderr.write(`  [${pd ? "PD" : "PT"}] Tools available: ${claudeTools.map((t) => t.name).join(", ")}\n`);
    }

    // Agentic loop: prompt Claude, execute tool calls, feed results back
    const messages: ClaudeMessage[] = [
      { role: "user", content: task.prompt },
    ];

    const MAX_ROUNDS = 10;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      roundTrips++;
      const response = await callClaude(messages, claudeTools, model);

      if (verbose) {
        const textBlocks = (response.content as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (textBlocks) process.stderr.write(`  [${pd ? "PD" : "PT"}] Claude: ${textBlocks.slice(0, 200)}\n`);
      }

      // Add assistant response to history
      messages.push({ role: "assistant", content: response.content });

      // Check if Claude wants to use tools
      const toolUseBlocks = (response.content as Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }>)
        .filter((b) => b.type === "tool_use");

      if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
        // Claude is done
        break;
      }

      // Execute each tool call through the proxy
      const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];

      for (const block of toolUseBlocks) {
        const toolName = block.name!;
        const toolArgs = block.input ?? {};

        // Send through MCP proxy
        proxy.send({
          jsonrpc: "2.0",
          id: nextId,
          method: "tools/call",
          params: { name: toolName, arguments: toolArgs },
        });

        const mcpResponse = await proxy.waitForResponse(nextId++, 30000);
        const mcpResult = mcpResponse.result as Record<string, unknown> | undefined;
        const mcpError = mcpResponse.error as { message: string } | undefined;

        const resultText = mcpResult
          ? JSON.stringify((mcpResult.content as Array<{ text: string }>)?.[0]?.text ?? mcpResult)
          : `Error: ${mcpError?.message ?? "Unknown error"}`;

        toolCalls.push({
          tool: toolName,
          args: toolArgs,
          result: mcpResult ? resultText : null,
          error: mcpError?.message ?? null,
        });

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id!,
          content: resultText,
        });

        if (verbose) {
          process.stderr.write(`  [${pd ? "PD" : "PT"}] Tool: ${toolName}(${JSON.stringify(toolArgs).slice(0, 100)}) -> ${resultText.slice(0, 100)}\n`);
        }
      }

      // Feed tool results back to Claude
      messages.push({ role: "user", content: toolResults });
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Read logs for token savings
  let tokensSaved = 0;
  try {
    await new Promise((r) => setTimeout(r, 500));
    proxy.close();
    await new Promise((r) => setTimeout(r, 300));
    const files = await readdir(proxy.logDir);
    const logFile = files.find((f) => f.endsWith(".jsonl"));
    if (logFile) {
      const content = await readFile(join(proxy.logDir, logFile), "utf-8");
      const entries = content.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogEntry);
      tokensSaved = entries.reduce((sum, e) => sum + (e.schema_tokens_saved ?? 0), 0);
    }
  } catch {
    proxy.close();
  }

  const completed = task.successCheck(toolCalls);

  return {
    task: task.name,
    pd,
    completed,
    toolCalls: toolCalls.length,
    roundTrips,
    error,
    durationMs: Date.now() - start,
    tokensSaved,
  };
}

// ── Main ──────────────────────────────────────────────────────────────

function parseArgs(): { model: string; taskCount: number; server: string; verbose: boolean } {
  const args = process.argv.slice(2);
  let model = "claude-sonnet-4-20250514";
  let taskCount = 5;
  let server = "fs";
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) model = args[++i];
    else if (args[i] === "--tasks" && args[i + 1]) taskCount = parseInt(args[++i], 10);
    else if (args[i] === "--server" && args[i + 1]) server = args[++i];
    else if (args[i] === "--verbose") verbose = true;
  }

  return { model, taskCount, server, verbose };
}

async function main() {
  const { model, taskCount, server, verbose } = parseArgs();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    process.stderr.write("Error: ANTHROPIC_API_KEY environment variable not set.\n");
    process.stderr.write("Usage: ANTHROPIC_API_KEY=sk-... npx tsx test/simulate/validate-claude-api.ts\n");
    process.exit(1);
  }

  // Select tasks for the requested server
  const availableTasks = TASKS.filter((t) => t.server === server);
  const selectedTasks = availableTasks.slice(0, taskCount);

  if (selectedTasks.length === 0) {
    process.stderr.write(`No tasks available for server type: ${server}\n`);
    process.exit(1);
  }

  process.stderr.write(`\n=== Claude API PD Validation ===\n`);
  process.stderr.write(`Model: ${model}\n`);
  process.stderr.write(`Server: ${server}\n`);
  process.stderr.write(`Tasks: ${selectedTasks.length}\n\n`);

  const results: TaskResult[] = [];

  // Run each task twice: passthrough then PD
  for (const task of selectedTasks) {
    process.stderr.write(`Task: ${task.name}\n`);

    process.stderr.write(`  Running passthrough...\n`);
    const ptResult = await runTask(task, false, model, verbose);
    results.push(ptResult);
    process.stderr.write(`  -> ${ptResult.completed ? "PASS" : "FAIL"} (${ptResult.toolCalls} calls, ${ptResult.roundTrips} rounds, ${ptResult.durationMs}ms)\n`);

    process.stderr.write(`  Running PD...\n`);
    const pdResult = await runTask(task, true, model, verbose);
    results.push(pdResult);
    process.stderr.write(`  -> ${pdResult.completed ? "PASS" : "FAIL"} (${pdResult.toolCalls} calls, ${pdResult.roundTrips} rounds, ${pdResult.durationMs}ms, ${pdResult.tokensSaved} tokens saved)\n`);

    process.stderr.write("\n");
  }

  // Print comparison table
  const ptResults = results.filter((r) => !r.pd);
  const pdResults = results.filter((r) => r.pd);

  const ptCompleted = ptResults.filter((r) => r.completed).length;
  const pdCompleted = pdResults.filter((r) => r.completed).length;
  const ptRate = (ptCompleted / ptResults.length) * 100;
  const pdRate = (pdCompleted / pdResults.length) * 100;
  const totalTokensSaved = pdResults.reduce((sum, r) => sum + r.tokensSaved, 0);

  process.stdout.write("\n=== Claude API PD Validation Results ===\n\n");

  const header = ["Task".padEnd(25), "PT", "PD", "PT Calls", "PD Calls", "PT Rounds", "PD Rounds", "Tokens Saved"].join(" | ");
  const sep = "-".repeat(header.length);
  process.stdout.write(sep + "\n" + header + "\n" + sep + "\n");

  for (const task of selectedTasks) {
    const pt = ptResults.find((r) => r.task === task.name)!;
    const pd = pdResults.find((r) => r.task === task.name)!;
    process.stdout.write([
      task.name.padEnd(25),
      pt.completed ? "PASS" : "FAIL",
      pd.completed ? "PASS" : "FAIL",
      String(pt.toolCalls).padStart(8),
      String(pd.toolCalls).padStart(8),
      String(pt.roundTrips).padStart(9),
      String(pd.roundTrips).padStart(9),
      String(pd.tokensSaved).padStart(12),
    ].join(" | ") + "\n");
  }

  process.stdout.write(sep + "\n\n");
  process.stdout.write(`Passthrough: ${ptCompleted}/${ptResults.length} completed (${ptRate.toFixed(0)}%)\n`);
  process.stdout.write(`PD:          ${pdCompleted}/${pdResults.length} completed (${pdRate.toFixed(0)}%)\n`);
  process.stdout.write(`Total tokens saved with PD: ${totalTokensSaved}\n\n`);

  // Go/no-go
  const dropPct = ptRate - pdRate;
  if (dropPct > 20) {
    process.stdout.write(`NO-GO: PD completion dropped ${dropPct.toFixed(0)}% vs passthrough (threshold: 20%)\n`);
    process.exit(1);
  } else if (dropPct > 0) {
    process.stdout.write(`CAUTION: PD completion dropped ${dropPct.toFixed(0)}% vs passthrough — monitor closely\n`);
  } else {
    process.stdout.write(`GO: PD completion rate is equal or better than passthrough\n`);
  }

  // Print any errors
  const errors = results.filter((r) => r.error);
  if (errors.length > 0) {
    process.stdout.write("\n--- Errors ---\n");
    for (const r of errors) {
      process.stdout.write(`  ${r.task} (${r.pd ? "PD" : "PT"}): ${r.error}\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
