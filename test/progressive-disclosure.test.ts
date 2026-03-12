import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPDHandler,
  type ToolSchema,
} from "../src/progressive-disclosure.js";

const sampleTools: ToolSchema[] = [
  {
    name: "read_file",
    description: "Read file contents from the filesystem",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description: "List files in a directory",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description: "Search for files matching a pattern",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
    },
  },
];

describe("PD Handler", () => {
  it("caches tool schemas on loadSchemas", () => {
    const pd = createPDHandler(join(tmpdir(), "no-cache"));
    pd.loadSchemas(sampleTools);

    expect(pd.isActive()).toBe(true);
    expect(pd.getToolCount()).toBe(4);
  });

  it("generates meta-tool schemas for tools/list response", () => {
    const pd = createPDHandler(join(tmpdir(), "no-cache"));
    pd.loadSchemas(sampleTools);

    const metaTools = pd.getMetaToolSchemas();
    expect(metaTools).toHaveLength(2);
    expect(metaTools.map((t) => t.name)).toEqual(["discover_tools", "execute_tool"]);
  });

  it("discover_tools returns matching tools by keyword", () => {
    const pd = createPDHandler(join(tmpdir(), "no-cache"));
    pd.loadSchemas(sampleTools);

    const results = pd.discoverTools("file");
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.some((r) => r.name === "read_file")).toBe(true);
    expect(results.some((r) => r.name === "write_file")).toBe(true);
  });

  it("discover_tools returns empty array for no match", () => {
    const pd = createPDHandler(join(tmpdir(), "no-cache"));
    pd.loadSchemas(sampleTools);

    const results = pd.discoverTools("zzzznonexistent");
    expect(results.length).toBe(0);
  });

  it("resolves real tool name and schema from execute_tool", () => {
    const pd = createPDHandler(join(tmpdir(), "no-cache"));
    pd.loadSchemas(sampleTools);

    const resolved = pd.resolveExecuteTool("read_file", { path: "/test.ts" });
    expect(resolved).not.toBeNull();
    expect(resolved!.toolName).toBe("read_file");
    expect(resolved!.arguments).toEqual({ path: "/test.ts" });
  });

  it("returns null for unknown tool in execute_tool", () => {
    const pd = createPDHandler(join(tmpdir(), "no-cache"));
    pd.loadSchemas(sampleTools);

    const resolved = pd.resolveExecuteTool("nonexistent_tool", {});
    expect(resolved).toBeNull();
  });

  it("estimates token savings", () => {
    // Need enough tools for meta-tools to be smaller than full schemas
    const manyTools: ToolSchema[] = Array.from({ length: 20 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Description for tool number ${i} with extra detail to make it realistic`,
      inputSchema: {
        type: "object",
        properties: { arg1: { type: "string" }, arg2: { type: "number" }, arg3: { type: "boolean" } },
        required: ["arg1"],
      },
    }));
    const pd = createPDHandler(join(tmpdir(), "no-cache"));
    pd.loadSchemas(manyTools);

    const savings = pd.estimateTokenSavings();
    expect(savings.originalTokens).toBeGreaterThan(0);
    expect(savings.reducedTokens).toBeGreaterThan(0);
    expect(savings.savedTokens).toBeGreaterThan(0);
    expect(savings.savedTokens).toBeLessThan(savings.originalTokens);
  });
});
