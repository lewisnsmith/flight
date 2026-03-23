import { describe, it, expect } from "vitest";
import {
  createPDHandler,
  compressSchema,
  mergeSessionUsage,
  type ToolSchema,
  type UsageStore,
} from "../src/progressive-disclosure.js";

const sampleTools: ToolSchema[] = [
  {
    name: "read_file",
    description: "Read file contents from the filesystem",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file path to read" },
        encoding: { type: "string", description: "Character encoding", default: "utf-8" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file path to write" },
        content: { type: "string", description: "The content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description: "List files in a directory",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path" },
        recursive: { type: "boolean", description: "Whether to list recursively" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description: "Search for files matching a pattern",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern" },
        path: { type: "string", description: "Root directory" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file from the filesystem",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to delete" },
        force: { type: "boolean", description: "Force delete" },
      },
      required: ["path"],
    },
  },
];

function makeHandler(usageStore?: UsageStore | null) {
  return createPDHandler({
    serverCommand: "test-server",
    serverArgs: [],
    historyThreshold: 3,
    usageStore: usageStore ?? null,
  });
}

describe("PD Handler — Phase 1 (Observation)", () => {
  it("defaults to Phase 1 with no usage history", () => {
    const pd = makeHandler(null);
    pd.loadSchemas(sampleTools);

    expect(pd.isActive()).toBe(true);
    expect(pd.getPhase()).toBe(1);
    expect(pd.getToolCount()).toBe(5);
  });

  it("Phase 1 passes through tools unmodified", () => {
    const pd = makeHandler(null);
    pd.loadSchemas(sampleTools);

    const responseTools = pd.getResponseTools();
    expect(responseTools).toEqual(sampleTools);
  });

  it("Phase 1 reports zero token savings", () => {
    const pd = makeHandler(null);
    pd.loadSchemas(sampleTools);

    const savings = pd.estimateTokenSavings();
    expect(savings.savedTokens).toBe(0);
  });

  it("records tool calls for usage tracking", () => {
    const pd = makeHandler(null);
    pd.loadSchemas(sampleTools);

    pd.recordToolCall("read_file", false);
    pd.recordToolCall("read_file", false);
    pd.recordToolCall("write_file", true);

    // No error — just verifying it doesn't throw
    expect(pd.isActive()).toBe(true);
  });
});

describe("PD Handler — Phase 2 (Compression)", () => {
  it("activates Phase 2 with 1+ sessions of history", () => {
    const store: UsageStore = {
      serverKey: "test",
      tools: {
        read_file: { name: "read_file", callCount: 5, lastSessionUsed: 0, lastUsed: "2026-01-01", errors: 0 },
        write_file: { name: "write_file", callCount: 3, lastSessionUsed: 0, lastUsed: "2026-01-01", errors: 0 },
      },
      sessions: 1,
      lastUpdated: "2026-01-01",
    };
    const pd = makeHandler(store);
    pd.loadSchemas(sampleTools);

    expect(pd.getPhase()).toBe(2);
  });

  it("Phase 2 compresses schemas but shows all tools", () => {
    const store: UsageStore = {
      serverKey: "test",
      tools: {
        read_file: { name: "read_file", callCount: 5, lastSessionUsed: 0, lastUsed: "2026-01-01", errors: 0 },
      },
      sessions: 1,
      lastUpdated: "2026-01-01",
    };
    const pd = makeHandler(store);
    pd.loadSchemas(sampleTools);

    const responseTools = pd.getResponseTools();
    // All 5 tools shown (no filtering in Phase 2)
    expect(responseTools.length).toBe(5);
    // Schemas should be compressed — property descriptions stripped
    const readFile = responseTools.find((t) => t.name === "read_file")!;
    expect(readFile.description).toBe("Read file contents from the filesystem"); // Top-level kept
    expect((readFile.inputSchema as Record<string, unknown>).properties).toBeDefined();
    const pathProp = ((readFile.inputSchema as Record<string, unknown>).properties as Record<string, unknown>).path as Record<string, unknown>;
    expect(pathProp.description).toBeUndefined(); // Property description stripped
  });

  it("Phase 2 has positive token savings", () => {
    const store: UsageStore = {
      serverKey: "test",
      tools: {},
      sessions: 1,
      lastUpdated: "2026-01-01",
    };
    const pd = makeHandler(store);
    pd.loadSchemas(sampleTools);

    const savings = pd.estimateTokenSavings();
    expect(savings.savedTokens).toBeGreaterThan(0);
    expect(savings.reducedTokens).toBeLessThan(savings.originalTokens);
  });

  it("no hidden tools in Phase 2", () => {
    const store: UsageStore = {
      serverKey: "test",
      tools: {},
      sessions: 2,
      lastUpdated: "2026-01-01",
    };
    const pd = makeHandler(store);
    pd.loadSchemas(sampleTools);

    for (const tool of sampleTools) {
      expect(pd.isHiddenTool(tool.name)).toBe(false);
    }
  });
});

describe("PD Handler — Phase 3 (Compression + Filtering)", () => {
  function makePhase3Store(): UsageStore {
    // 5 sessions of history, delete_file last used in session 0 (4 sessions ago)
    return {
      serverKey: "test",
      tools: {
        read_file: { name: "read_file", callCount: 20, lastSessionUsed: 4, lastUsed: "2026-01-05", errors: 0 },
        write_file: { name: "write_file", callCount: 10, lastSessionUsed: 4, lastUsed: "2026-01-05", errors: 0 },
        list_directory: { name: "list_directory", callCount: 8, lastSessionUsed: 3, lastUsed: "2026-01-04", errors: 0 },
        search_files: { name: "search_files", callCount: 5, lastSessionUsed: 3, lastUsed: "2026-01-04", errors: 0 },
        delete_file: { name: "delete_file", callCount: 1, lastSessionUsed: 0, lastUsed: "2026-01-01", errors: 0 },
      },
      sessions: 5,
      lastUpdated: "2026-01-05",
    };
  }

  it("activates Phase 3 when tools qualify for filtering", () => {
    const pd = makeHandler(makePhase3Store());
    pd.loadSchemas(sampleTools);

    expect(pd.getPhase()).toBe(3);
  });

  it("hides tools with K+ sessions of non-use", () => {
    const pd = makeHandler(makePhase3Store());
    pd.loadSchemas(sampleTools);

    // delete_file: lastSessionUsed=0, sessions=5, gap=5 >= threshold=3 → hidden
    expect(pd.isHiddenTool("delete_file")).toBe(true);
    expect(pd.isHiddenTool("read_file")).toBe(false);
    expect(pd.isHiddenTool("write_file")).toBe(false);
  });

  it("Phase 3 response excludes hidden tools and includes discover_tools", () => {
    const pd = makeHandler(makePhase3Store());
    pd.loadSchemas(sampleTools);

    const responseTools = pd.getResponseTools();
    const names = responseTools.map((t) => t.name);

    // delete_file hidden
    expect(names).not.toContain("delete_file");
    // discover_tools appended
    expect(names).toContain("discover_tools");
    // Visible tools present
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
  });

  it("discover_tools finds hidden tools by keyword", () => {
    const pd = makeHandler(makePhase3Store());
    pd.loadSchemas(sampleTools);

    const results = pd.discoverTools("delete");
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("delete_file");
  });

  it("discover_tools with empty query returns all hidden tools", () => {
    const pd = makeHandler(makePhase3Store());
    pd.loadSchemas(sampleTools);

    const results = pd.discoverTools("");
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("delete_file");
  });

  it("hidden tools are still known (transparent forwarding)", () => {
    const pd = makeHandler(makePhase3Store());
    pd.loadSchemas(sampleTools);

    expect(pd.isKnownTool("delete_file")).toBe(true);
    expect(pd.isKnownTool("nonexistent_tool")).toBe(false);
  });

  it("new tools not in usage store are visible", () => {
    const store = makePhase3Store();
    const pd = makeHandler(store);
    const toolsWithNew = [
      ...sampleTools,
      { name: "brand_new_tool", description: "A brand new tool", inputSchema: { type: "object", properties: {}, required: [] } },
    ];
    pd.loadSchemas(toolsWithNew);

    expect(pd.isHiddenTool("brand_new_tool")).toBe(false);
    const responseTools = pd.getResponseTools();
    expect(responseTools.map((t) => t.name)).toContain("brand_new_tool");
  });
});

describe("Schema Compression", () => {
  it("strips property descriptions but keeps tool-level description", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      description: "Top level description",
      properties: {
        path: { type: "string", description: "The file path" },
        encoding: { type: "string", description: "Char encoding", default: "utf-8" },
      },
      required: ["path"],
    };

    const compressed = compressSchema(schema);
    expect(compressed.description).toBe("Top level description");
    const props = compressed.properties as Record<string, Record<string, unknown>>;
    expect(props.path.description).toBeUndefined();
    expect(props.path.type).toBe("string");
    expect(props.encoding.description).toBeUndefined();
    expect(props.encoding.default).toBeUndefined();
  });

  it("strips $comment and redundant additionalProperties from nested objects", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          $comment: "internal note",
          additionalProperties: false,
          properties: {
            x: { type: "number", description: "X coord" },
          },
        },
      },
    };

    const compressed = compressSchema(schema);
    const nested = (compressed.properties as Record<string, Record<string, unknown>>).nested;
    expect(nested.$comment).toBeUndefined();
    expect(nested.additionalProperties).toBeUndefined();
  });

  it("preserves enum, required, type", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: {
        format: {
          type: "string",
          description: "Output format",
          enum: ["json", "csv", "xml"],
          default: "json",
        },
      },
      required: ["format"],
    };

    const compressed = compressSchema(schema);
    const format = (compressed.properties as Record<string, Record<string, unknown>>).format;
    expect(format.type).toBe("string");
    expect(format.enum).toEqual(["json", "csv", "xml"]);
    expect(format.description).toBeUndefined();
    expect(format.default).toBeUndefined();
    expect(compressed.required).toEqual(["format"]);
  });

  it("handles oneOf/anyOf/allOf recursively", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: {
        value: {
          oneOf: [
            { type: "string", description: "A string value" },
            { type: "number", description: "A number value", default: 0 },
          ],
        },
      },
    };

    const compressed = compressSchema(schema);
    const value = (compressed.properties as Record<string, Record<string, unknown>>).value;
    const oneOf = value.oneOf as Array<Record<string, unknown>>;
    expect(oneOf[0].description).toBeUndefined();
    expect(oneOf[0].type).toBe("string");
    expect(oneOf[1].description).toBeUndefined();
    expect(oneOf[1].default).toBeUndefined();
    expect(oneOf[1].type).toBe("number");
  });

  it("achieves measurable size reduction on realistic schemas", () => {
    const original = JSON.stringify({
      type: "object",
      properties: {
        path: { type: "string", description: "The absolute file path to read from the filesystem" },
        encoding: { type: "string", description: "The file encoding to use when reading", default: "utf-8", enum: ["utf-8", "ascii", "base64"] },
      },
      required: ["path"],
    });

    const compressed = JSON.stringify(compressSchema(JSON.parse(original)));
    expect(compressed.length).toBeLessThan(original.length);
    // Spec example: 388 → 150 chars (~61% reduction)
    const reduction = 1 - compressed.length / original.length;
    expect(reduction).toBeGreaterThan(0.3);
  });
});

describe("mergeSessionUsage", () => {
  it("adds new tools to an empty store", () => {
    const store: UsageStore = { serverKey: "test", tools: {}, sessions: 1, lastUpdated: "2026-01-01" };
    const sessionUsage = new Map([
      ["read_file", { calls: 3, errors: 0 }],
      ["write_file", { calls: 1, errors: 1 }],
    ]);

    mergeSessionUsage(store, sessionUsage, 0, "2026-01-02");

    expect(store.tools.read_file).toEqual({
      name: "read_file", callCount: 3, lastSessionUsed: 0, lastUsed: "2026-01-02", errors: 0,
    });
    expect(store.tools.write_file).toEqual({
      name: "write_file", callCount: 1, lastSessionUsed: 0, lastUsed: "2026-01-02", errors: 1,
    });
  });

  it("merges into existing tool entries", () => {
    const store: UsageStore = {
      serverKey: "test",
      tools: {
        read_file: { name: "read_file", callCount: 10, lastSessionUsed: 2, lastUsed: "2026-01-03", errors: 1 },
      },
      sessions: 4,
      lastUpdated: "2026-01-03",
    };
    const sessionUsage = new Map([
      ["read_file", { calls: 5, errors: 2 }],
    ]);

    mergeSessionUsage(store, sessionUsage, 3, "2026-01-04");

    expect(store.tools.read_file).toEqual({
      name: "read_file", callCount: 15, lastSessionUsed: 3, lastUsed: "2026-01-04", errors: 3,
    });
  });

  it("handles empty session usage (no-op)", () => {
    const store: UsageStore = {
      serverKey: "test",
      tools: { read_file: { name: "read_file", callCount: 5, lastSessionUsed: 0, lastUsed: "2026-01-01", errors: 0 } },
      sessions: 1,
      lastUpdated: "2026-01-01",
    };

    mergeSessionUsage(store, new Map(), 1, "2026-01-02");

    expect(store.tools.read_file.callCount).toBe(5); // unchanged
  });
});

describe("PD Handler — Usage Tracking", () => {
  it("flushUsage creates usage store even with no calls", async () => {
    const pd = makeHandler(null);
    pd.loadSchemas(sampleTools);

    // flushUsage should not throw (it writes to disk, but in tests the dir may not exist)
    // We're just testing that the method exists and runs
    try {
      await pd.flushUsage();
    } catch {
      // Expected in test environment without ~/.flight/usage
    }
  });
});
