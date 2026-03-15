/**
 * Mock Git MCP server for Flight Proxy simulation.
 * Reads NDJSON from stdin, responds on stdout.
 * Supports: initialize, tools/list, tools/call
 *
 * Env vars:
 *   MOCK_ERROR_RATE (0-1) — randomly fail with -32000 errors at this rate
 *   MOCK_LATENCY_MS — add artificial delay before responding
 */

import { createInterface } from "node:readline";

const ERROR_RATE = parseFloat(process.env.MOCK_ERROR_RATE ?? "0");
const LATENCY_MS = parseInt(process.env.MOCK_LATENCY_MS ?? "0", 10);

let commitCounter = 0;

const TOOLS = [
  {
    name: "git_status",
    description: "Show the working tree status",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "git_diff",
    description: "Show changes between commits, working tree, etc.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string", description: "Git ref to diff against (e.g. HEAD~1, main)" } },
    },
  },
  {
    name: "git_log",
    description: "Show commit logs",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of commits to show" },
        branch: { type: "string", description: "Branch name" },
      },
    },
  },
  {
    name: "git_commit",
    description: "Record changes to the repository",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "Commit message" } },
      required: ["message"],
    },
  },
  {
    name: "git_branch_list",
    description: "List branches",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "git_checkout",
    description: "Switch branches or restore working tree files",
    inputSchema: {
      type: "object",
      properties: { branch: { type: "string", description: "Branch name to checkout" } },
      required: ["branch"],
    },
  },
  {
    name: "git_add",
    description: "Add file contents to the index",
    inputSchema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "Files to stage" },
      },
      required: ["files"],
    },
  },
  {
    name: "git_stash",
    description: "Stash changes in a dirty working directory",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["push", "pop", "list"], description: "Stash action" },
      },
      required: ["action"],
    },
  },
  {
    name: "git_blame",
    description: "Show what revision and author last modified each line",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        line: { type: "number", description: "Specific line number" },
      },
      required: ["path"],
    },
  },
  {
    name: "git_show",
    description: "Show various types of objects",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string", description: "Git ref to show" } },
      required: ["ref"],
    },
  },
];

// --- Realistic canned responses ---

function fakeHash(): string {
  const chars = "0123456789abcdef";
  let hash = "";
  for (let i = 0; i < 7; i++) hash += chars[Math.floor(Math.random() * 16)];
  return hash;
}

function fullHash(): string {
  const chars = "0123456789abcdef";
  let hash = "";
  for (let i = 0; i < 40; i++) hash += chars[Math.floor(Math.random() * 16)];
  return hash;
}

function handleToolCall(name: string, args: Record<string, unknown>): { result?: unknown; error?: { code: number; message: string } } {
  switch (name) {
    case "git_status": {
      const output = [
        "On branch main",
        "Changes to be committed:",
        "  (use \"git restore --staged <file>...\" to unstage)",
        "\tmodified:   src/index.ts",
        "\tnew file:   src/utils/helpers.ts",
        "",
        "Changes not staged for commit:",
        "  (use \"git add <file>...\" to update what will be committed)",
        "\tmodified:   package.json",
        "\tmodified:   src/config.ts",
        "",
        "Untracked files:",
        "  (use \"git add <file>...\" to include in what will be committed)",
        "\tsrc/new-feature.ts",
        "\ttest/new-feature.test.ts",
      ].join("\n");
      return { result: { content: [{ type: "text", text: output }] } };
    }

    case "git_diff": {
      const ref = (args.ref as string) ?? "HEAD";
      const output = [
        `diff --git a/src/index.ts b/src/index.ts`,
        `index ${fakeHash()}..${fakeHash()} 100644`,
        "--- a/src/index.ts",
        "+++ b/src/index.ts",
        "@@ -10,6 +10,8 @@ import { Config } from './config';",
        " ",
        " export function main() {",
        "   const config = loadConfig();",
        "+  const logger = createLogger(config);",
        "+  logger.info('Application starting');",
        "   const server = createServer(config);",
        "   server.listen();",
        " }",
        "",
        `diff --git a/src/config.ts b/src/config.ts`,
        `index ${fakeHash()}..${fakeHash()} 100644`,
        "--- a/src/config.ts",
        "+++ b/src/config.ts",
        "@@ -5,3 +5,7 @@ export interface Config {",
        "   port: number;",
        "   host: string;",
        "+  logLevel: string;",
        "+  logFile?: string;",
        " }",
      ].join("\n");
      return { result: { content: [{ type: "text", text: `Diff against ${ref}:\n${output}` }] } };
    }

    case "git_log": {
      const count = (args.count as number) ?? 5;
      const branch = (args.branch as string) ?? "main";
      const authors = ["Alice Smith", "Bob Johnson", "Carol Williams"];
      const messages = [
        "feat: add logging infrastructure",
        "fix: resolve connection timeout issue",
        "refactor: extract config parser into module",
        "test: add integration tests for API endpoints",
        "docs: update README with setup instructions",
        "chore: bump dependencies to latest versions",
        "feat: implement retry logic for HTTP client",
        "fix: handle edge case in date parsing",
      ];
      const entries: string[] = [];
      for (let i = 0; i < Math.min(count, messages.length); i++) {
        const daysAgo = i + 1;
        entries.push(
          `commit ${fullHash()}`,
          `Author: ${authors[i % authors.length]} <${authors[i % authors.length].toLowerCase().replace(" ", ".")}@example.com>`,
          `Date:   ${new Date(Date.now() - daysAgo * 86400000).toUTCString()}`,
          "",
          `    ${messages[i]}`,
          "",
        );
      }
      return { result: { content: [{ type: "text", text: `Log for ${branch}:\n${entries.join("\n")}` }] } };
    }

    case "git_commit": {
      const message = (args.message as string) ?? "";
      commitCounter++;
      const hash = fullHash();
      const short = hash.slice(0, 7);
      return {
        result: {
          content: [{ type: "text", text: `[main ${short}] ${message}\n 2 files changed, 15 insertions(+), 3 deletions(-)` }],
        },
      };
    }

    case "git_branch_list": {
      const output = [
        "  develop",
        "  feature/auth",
        "  feature/logging",
        "  fix/timeout-bug",
        "* main",
        "  release/v2.0",
      ].join("\n");
      return { result: { content: [{ type: "text", text: output }] } };
    }

    case "git_checkout": {
      const branch = (args.branch as string) ?? "";
      if (branch === "conflict-branch") {
        return {
          error: {
            code: -32000,
            message: `error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/index.ts\n\tsrc/config.ts\nPlease commit your changes or stash them before you switch branches.\nAborting`,
          },
        };
      }
      return { result: { content: [{ type: "text", text: `Switched to branch '${branch}'` }] } };
    }

    case "git_add": {
      const files = (args.files as string[]) ?? [];
      return { result: { content: [{ type: "text", text: `Added ${files.length} file(s) to staging area:\n${files.map((f) => `  ${f}`).join("\n")}` }] } };
    }

    case "git_stash": {
      const action = (args.action as string) ?? "list";
      switch (action) {
        case "push":
          return { result: { content: [{ type: "text", text: "Saved working directory and index state WIP on main: a3e7c95 feat: add lifecycle management" }] } };
        case "pop":
          return { result: { content: [{ type: "text", text: "On branch main\nChanges not staged for commit:\n\tmodified:   src/index.ts\n\tmodified:   src/config.ts\nDropped refs/stash@{0} (abc1234567890)" }] } };
        case "list":
          return { result: { content: [{ type: "text", text: "stash@{0}: WIP on main: a3e7c95 feat: add lifecycle management\nstash@{1}: WIP on develop: 5f4993d feat: add export command" }] } };
        default:
          return { error: { code: -32000, message: `Unknown stash action: ${action}` } };
      }
    }

    case "git_blame": {
      const path = (args.path as string) ?? "";
      const line = args.line as number | undefined;
      const authors = ["Alice Smith", "Bob Johnson", "Carol Williams"];
      const lines: string[] = [];
      const startLine = line ?? 1;
      const count = line ? 1 : 10;
      for (let i = 0; i < count; i++) {
        const lineNum = startLine + i;
        const author = authors[i % authors.length];
        lines.push(`${fakeHash()} (${author.padEnd(15)} 2026-03-${String(10 - (i % 5)).padStart(2, "0")} ${lineNum.toString().padStart(3)}) const x = ${i};`);
      }
      return { result: { content: [{ type: "text", text: `Blame for ${path}:\n${lines.join("\n")}` }] } };
    }

    case "git_show": {
      const ref = (args.ref as string) ?? "HEAD";
      const hash = fullHash();
      const output = [
        `commit ${hash}`,
        "Author: Alice Smith <alice.smith@example.com>",
        `Date:   ${new Date().toUTCString()}`,
        "",
        "    feat: add logging infrastructure",
        "",
        `diff --git a/src/logger.ts b/src/logger.ts`,
        "new file mode 100644",
        `index 0000000..${fakeHash()}`,
        "--- /dev/null",
        "+++ b/src/logger.ts",
        "@@ -0,0 +1,12 @@",
        "+export type LogLevel = 'debug' | 'info' | 'warn' | 'error';",
        "+",
        "+export function createLogger(level: LogLevel = 'info') {",
        "+  return {",
        "+    debug: (msg: string) => level === 'debug' && console.log(`[DEBUG] ${msg}`),",
        "+    info: (msg: string) => console.log(`[INFO] ${msg}`),",
        "+    warn: (msg: string) => console.warn(`[WARN] ${msg}`),",
        "+    error: (msg: string) => console.error(`[ERROR] ${msg}`),",
        "+  };",
        "+}",
      ].join("\n");
      return { result: { content: [{ type: "text", text: `Showing ${ref}:\n${output}` }] } };
    }

    default:
      return { error: { code: -32601, message: `Unknown tool: ${name}` } };
  }
}

// --- JSON-RPC helpers ---

function respond(id: string | number, result: unknown) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function respondError(id: string | number, code: number, message: string) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}

function shouldInjectError(): boolean {
  return ERROR_RATE > 0 && Math.random() < ERROR_RATE;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Main ---

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (LATENCY_MS > 0) {
    await delay(LATENCY_MS);
  }

  if (msg.method === "initialize") {
    respond(msg.id as string | number, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "mock-git", version: "1.0.0" },
    });
  } else if (msg.method === "notifications/initialized") {
    // No response for notifications
  } else if (msg.method === "tools/list") {
    respond(msg.id as string | number, { tools: TOOLS });
  } else if (msg.method === "tools/call") {
    const toolName = (msg.params as Record<string, unknown>)?.name as string;
    const args = ((msg.params as Record<string, unknown>)?.arguments as Record<string, unknown>) ?? {};
    const id = msg.id as string | number;

    if (shouldInjectError()) {
      respondError(id, -32000, `Injected error (MOCK_ERROR_RATE=${ERROR_RATE}) for tool: ${toolName}`);
      return;
    }

    const outcome = handleToolCall(toolName, args);
    if (outcome.error) {
      respondError(id, outcome.error.code, outcome.error.message);
    } else {
      respond(id, outcome.result);
    }
  } else {
    respondError(msg.id as string | number, -32601, `Method not found: ${msg.method}`);
  }
});
