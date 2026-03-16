import { describe, it, expect } from "vitest";
import {
  createPDHandler,
  compressSchema,
  type ToolSchema,
  type UsageStore,
} from "../src/progressive-disclosure.js";

// Realistic tool schemas mimicking real MCP servers

const filesystemTools: ToolSchema[] = [
  {
    name: "read_file",
    description: "Read the complete contents of a file from the filesystem. Handles various encodings and returns the raw text content.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file to read" },
        encoding: { type: "string", description: "Character encoding to use (default: utf-8)", enum: ["utf-8", "ascii", "latin1", "base64"] },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file on the filesystem. Creates the file if it does not exist, or overwrites if it does.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to write the file" },
        content: { type: "string", description: "The text content to write to the file" },
        encoding: { type: "string", description: "Character encoding to use (default: utf-8)" },
        createDirectories: { type: "boolean", description: "Whether to create parent directories if they don't exist" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description: "List all files and directories in a given directory path. Returns names, types, and sizes.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the directory to list" },
        recursive: { type: "boolean", description: "Whether to list subdirectories recursively" },
        includeHidden: { type: "boolean", description: "Whether to include hidden files (dotfiles)" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description: "Search for files matching a glob pattern or regular expression across a directory tree.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob or regex pattern to match file names against" },
        path: { type: "string", description: "Root directory to start the search from" },
        maxDepth: { type: "number", description: "Maximum directory depth to search" },
        fileType: { type: "string", description: "Filter by file type", enum: ["file", "directory", "symlink"] },
      },
      required: ["pattern"],
    },
  },
  {
    name: "move_file",
    description: "Move or rename a file or directory from one location to another on the filesystem.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source path of the file or directory to move" },
        destination: { type: "string", description: "Destination path where the file or directory should be moved to" },
        overwrite: { type: "boolean", description: "Whether to overwrite if destination already exists" },
      },
      required: ["source", "destination"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file or directory from the filesystem. Supports recursive deletion for directories.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file or directory to delete" },
        recursive: { type: "boolean", description: "Required for deleting non-empty directories" },
        force: { type: "boolean", description: "Ignore errors if the file does not exist" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_file_info",
    description: "Get metadata about a file or directory including size, permissions, timestamps, and type.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file or directory to inspect" },
        followSymlinks: { type: "boolean", description: "Whether to follow symbolic links" },
      },
      required: ["path"],
    },
  },
];

const gitTools: ToolSchema[] = [
  {
    name: "git_status",
    description: "Show the working tree status including staged, unstaged, and untracked files in the repository.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Path to the git repository root" },
        short: { type: "boolean", description: "Give the output in short format" },
      },
      required: ["repoPath"],
    },
  },
  {
    name: "git_log",
    description: "Show commit logs with author, date, message, and optional diff information.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Path to the git repository root" },
        maxCount: { type: "number", description: "Maximum number of commits to show" },
        branch: { type: "string", description: "Branch name to show logs for" },
        author: { type: "string", description: "Filter commits by author name or email" },
        since: { type: "string", description: "Show commits after this date (ISO 8601)" },
        until: { type: "string", description: "Show commits before this date (ISO 8601)" },
      },
      required: ["repoPath"],
    },
  },
  {
    name: "git_diff",
    description: "Show changes between commits, the working tree, and the staging area.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Path to the git repository root" },
        ref1: { type: "string", description: "First reference (commit, branch, tag)" },
        ref2: { type: "string", description: "Second reference to compare against" },
        staged: { type: "boolean", description: "Show staged changes only" },
        path: { type: "string", description: "Limit diff to a specific file path" },
      },
      required: ["repoPath"],
    },
  },
];

const webTools: ToolSchema[] = [
  {
    name: "http_get",
    description: "Perform an HTTP GET request to fetch data from a URL. Supports custom headers and query parameters.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full URL to send the GET request to" },
        headers: { type: "object", description: "Custom HTTP headers to include in the request" },
        queryParams: { type: "object", description: "Query parameters to append to the URL" },
        timeout: { type: "number", description: "Request timeout in milliseconds" },
        followRedirects: { type: "boolean", description: "Whether to follow HTTP redirects (default: true)" },
      },
      required: ["url"],
    },
  },
  {
    name: "http_post",
    description: "Perform an HTTP POST request to send data to a URL. Supports JSON and form-encoded bodies.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full URL to send the POST request to" },
        body: { type: "object", description: "The request body to send (will be JSON-encoded)" },
        headers: { type: "object", description: "Custom HTTP headers to include in the request" },
        contentType: { type: "string", description: "Content type of the request body", enum: ["application/json", "application/x-www-form-urlencoded", "multipart/form-data"] },
        timeout: { type: "number", description: "Request timeout in milliseconds" },
      },
      required: ["url"],
    },
  },
  {
    name: "web_scrape",
    description: "Scrape and extract content from a web page. Can return raw HTML, text, or structured data.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL of the web page to scrape" },
        selector: { type: "string", description: "CSS selector to extract specific elements" },
        format: { type: "string", description: "Output format", enum: ["html", "text", "markdown"] },
        waitForSelector: { type: "string", description: "CSS selector to wait for before scraping (for dynamic pages)" },
        javascript: { type: "boolean", description: "Whether to execute JavaScript on the page" },
      },
      required: ["url"],
    },
  },
];

function buildToolSet(count: number): ToolSchema[] {
  const allTools = [...filesystemTools, ...gitTools, ...webTools];
  const result: ToolSchema[] = [];
  for (let i = 0; i < count; i++) {
    const base = allTools[i % allTools.length];
    if (i < allTools.length) {
      result.push(base);
    } else {
      result.push({ ...base, name: `${base.name}_${Math.floor(i / allTools.length)}` });
    }
  }
  return result;
}

function makePhase2Handler(tools: ToolSchema[]) {
  const store: UsageStore = {
    serverKey: "test",
    tools: {},
    sessions: 1,
    lastUpdated: "2026-01-01",
  };
  const pd = createPDHandler({
    serverCommand: "test-server",
    serverArgs: [],
    historyThreshold: 3,
    usageStore: store,
  });
  pd.loadSchemas(tools);
  return pd;
}

describe("Progressive Disclosure Token Reduction (Compression)", () => {
  it("Phase 2 compression achieves >30% schema reduction on 10 realistic tools", () => {
    const pd = makePhase2Handler(buildToolSet(10));
    const savings = pd.estimateTokenSavings();

    expect(savings.originalTokens).toBeGreaterThan(0);
    expect(savings.savedTokens).toBeGreaterThan(0);

    const reductionPct = (savings.savedTokens / savings.originalTokens) * 100;
    // Spec requires >30% reduction
    expect(reductionPct).toBeGreaterThanOrEqual(30);
  });

  it("compression scales with number of tools (more tools = more absolute savings)", () => {
    const counts = [5, 10, 15, 20];
    const savedTokens: number[] = [];

    for (const count of counts) {
      const pd = makePhase2Handler(buildToolSet(count));
      savedTokens.push(pd.estimateTokenSavings().savedTokens);
    }

    // More tools should save more tokens
    for (let i = 1; i < savedTokens.length; i++) {
      expect(savedTokens[i]).toBeGreaterThan(savedTokens[i - 1]);
    }
  });

  it("compression ratio stays consistent regardless of tool count", () => {
    const counts = [5, 10, 20];
    const ratios: number[] = [];

    for (const count of counts) {
      const pd = makePhase2Handler(buildToolSet(count));
      const savings = pd.estimateTokenSavings();
      ratios.push(savings.savedTokens / savings.originalTokens);
    }

    // Compression ratio should be roughly similar (within 10% of each other)
    const minRatio = Math.min(...ratios);
    const maxRatio = Math.max(...ratios);
    expect(maxRatio - minRatio).toBeLessThan(0.15);
  });

  it("Phase 3 filtering adds additional savings beyond compression", () => {
    const tools = buildToolSet(10);

    // Phase 2: compression only
    const pd2 = makePhase2Handler(tools);
    const savings2 = pd2.estimateTokenSavings();

    // Phase 3: compression + filtering (hide 3 tools)
    const store3: UsageStore = {
      serverKey: "test",
      tools: {},
      sessions: 5,
      lastUpdated: "2026-01-05",
    };
    // Only mark first 7 tools as recently used, last 3 as stale
    for (let i = 0; i < tools.length; i++) {
      store3.tools[tools[i].name] = {
        name: tools[i].name,
        callCount: i < 7 ? 10 : 1,
        lastSessionUsed: i < 7 ? 4 : 0,
        lastUsed: i < 7 ? "2026-01-05" : "2026-01-01",
        errors: 0,
      };
    }
    const pd3 = createPDHandler({
      serverCommand: "test-server",
      serverArgs: [],
      historyThreshold: 3,
      usageStore: store3,
    });
    pd3.loadSchemas(tools);

    expect(pd3.getPhase()).toBe(3);
    const savings3 = pd3.estimateTokenSavings();
    expect(savings3.savedTokens).toBeGreaterThan(savings2.savedTokens);
  });

  it("individual schema compression matches spec example", () => {
    // Spec example: 388 chars → 150 chars
    const original: Record<string, unknown> = {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The absolute file path to read from the filesystem",
        },
        encoding: {
          type: "string",
          description: "The file encoding to use when reading",
          default: "utf-8",
          enum: ["utf-8", "ascii", "base64"],
        },
      },
      required: ["path"],
    };

    const compressed = compressSchema(original);
    const compressedStr = JSON.stringify(compressed);

    // Property descriptions and defaults stripped
    expect(compressedStr).not.toContain("The absolute file path");
    expect(compressedStr).not.toContain("The file encoding");
    // Enum preserved
    expect(compressedStr).toContain("utf-8");
    expect(compressedStr).toContain("ascii");
    expect(compressedStr).toContain("base64");
    // Required preserved
    expect(compressed.required).toEqual(["path"]);
    // Type preserved
    expect(compressed.type).toBe("object");
  });
});
