/**
 * Mock Filesystem MCP server for Flight Proxy simulation.
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

const TOOLS = [
  {
    name: "read_file",
    description: "Read the contents of a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute file path" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        content: { type: "string", description: "File content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories in a path",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path" } },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description: "Search for files matching a query",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        path: { type: "string", description: "Root path to search from" },
      },
      required: ["query"],
    },
  },
  {
    name: "create_directory",
    description: "Create a new directory",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path to create" } },
      required: ["path"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "File path to delete" } },
      required: ["path"],
    },
  },
  {
    name: "move_file",
    description: "Move or rename a file",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source file path" },
        destination: { type: "string", description: "Destination file path" },
      },
      required: ["source", "destination"],
    },
  },
  {
    name: "get_file_info",
    description: "Get metadata about a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "File path" } },
      required: ["path"],
    },
  },
  {
    name: "read_multiple_files",
    description: "Read contents of multiple files at once",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Array of file paths" },
      },
      required: ["paths"],
    },
  },
  {
    name: "file_exists",
    description: "Check whether a file exists",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "File path to check" } },
      required: ["path"],
    },
  },
];

// --- Realistic canned content generators ---

function generateFileContent(path: string): string {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) {
    return `import { createServer } from "node:http";\n\nexport interface Config {\n  port: number;\n  host: string;\n  debug: boolean;\n}\n\nexport function startServer(config: Config): void {\n  const server = createServer((req, res) => {\n    res.writeHead(200, { "Content-Type": "application/json" });\n    res.end(JSON.stringify({ status: "ok" }));\n  });\n  server.listen(config.port, config.host);\n  console.log(\`Server running on \${config.host}:\${config.port}\`);\n}\n`;
  }
  if (path.endsWith(".json")) {
    return JSON.stringify(
      { name: "example-project", version: "1.0.0", description: "A sample project", main: "index.js", scripts: { build: "tsc", test: "vitest" }, dependencies: { express: "^4.18.2" } },
      null,
      2,
    );
  }
  if (path.endsWith(".md")) {
    return "# Project\n\nThis is the project readme.\n\n## Getting Started\n\n```bash\nnpm install\nnpm run build\n```\n";
  }
  if (path.endsWith(".css")) {
    return "body {\n  margin: 0;\n  font-family: sans-serif;\n}\n\n.container {\n  max-width: 1200px;\n  margin: 0 auto;\n  padding: 1rem;\n}\n";
  }
  return `Contents of ${path}\nLine 2\nLine 3\n`;
}

function generateDirectoryListing(path: string): string[] {
  const base = path.replace(/\/+$/, "").split("/").pop() ?? "root";
  return [
    "src/",
    "test/",
    "node_modules/",
    "package.json",
    "tsconfig.json",
    "README.md",
    ".gitignore",
    `${base}.config.ts`,
    "index.ts",
    "LICENSE",
  ];
}

function generateSearchResults(query: string, rootPath: string): string[] {
  const root = rootPath || "/project";
  return [
    `${root}/src/index.ts`,
    `${root}/src/utils/${query}.ts`,
    `${root}/src/lib/${query}-helper.ts`,
    `${root}/test/${query}.test.ts`,
    `${root}/docs/${query}.md`,
  ];
}

function generateFileInfo(path: string): object {
  const ext = path.split(".").pop() ?? "";
  const typeMap: Record<string, string> = { ts: "TypeScript", js: "JavaScript", json: "JSON", md: "Markdown", css: "CSS" };
  return {
    path,
    size: 1024 + Math.floor(Math.random() * 8192),
    modified: "2026-03-10T14:32:00Z",
    created: "2026-01-15T09:00:00Z",
    type: typeMap[ext] ?? "text",
    permissions: "rw-r--r--",
  };
}

// --- Tool dispatch ---

function handleToolCall(name: string, args: Record<string, unknown>): { result?: unknown; error?: { code: number; message: string } } {
  switch (name) {
    case "read_file": {
      const path = (args.path as string) ?? "";
      return { result: { content: [{ type: "text", text: generateFileContent(path) }] } };
    }
    case "write_file": {
      const path = (args.path as string) ?? "";
      if (path.startsWith("/readonly/")) {
        return { error: { code: -32000, message: `Permission denied: ${path} is read-only` } };
      }
      const content = (args.content as string) ?? "";
      return { result: { content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }] } };
    }
    case "list_directory": {
      const path = (args.path as string) ?? "/";
      return { result: { content: [{ type: "text", text: JSON.stringify(generateDirectoryListing(path)) }] } };
    }
    case "search_files": {
      const query = (args.query as string) ?? "";
      const path = (args.path as string) ?? "/project";
      return { result: { content: [{ type: "text", text: JSON.stringify(generateSearchResults(query, path)) }] } };
    }
    case "create_directory": {
      const path = (args.path as string) ?? "";
      return { result: { content: [{ type: "text", text: `Created directory: ${path}` }] } };
    }
    case "delete_file": {
      const path = (args.path as string) ?? "";
      if (path.startsWith("/protected/")) {
        return { error: { code: -32000, message: `Cannot delete protected file: ${path}` } };
      }
      return { result: { content: [{ type: "text", text: `Deleted: ${path}` }] } };
    }
    case "move_file": {
      const source = (args.source as string) ?? "";
      const destination = (args.destination as string) ?? "";
      return { result: { content: [{ type: "text", text: `Moved ${source} to ${destination}` }] } };
    }
    case "get_file_info": {
      const path = (args.path as string) ?? "";
      return { result: { content: [{ type: "text", text: JSON.stringify(generateFileInfo(path), null, 2) }] } };
    }
    case "read_multiple_files": {
      const paths = (args.paths as string[]) ?? [];
      const results = paths.map((p) => ({ path: p, content: generateFileContent(p) }));
      return { result: { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] } };
    }
    case "file_exists": {
      const path = (args.path as string) ?? "";
      const exists = !path.includes("nonexistent") && !path.includes("missing");
      return { result: { content: [{ type: "text", text: JSON.stringify(exists) }] } };
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
      serverInfo: { name: "mock-fs", version: "1.0.0" },
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
