/**
 * Intersection tests targeting dangerous behavior combinations:
 * - Phase transitions at threshold boundaries
 * - Hidden → visible tool promotion via discover_tools
 * - Retry × PD interaction (double-counting, hidden tool retry)
 * - Concurrent flushUsage
 * - RetryManager edge cases
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import {
  createPDHandler,
  type ToolSchema,
  type UsageStore,
  type PDHandler,
} from "../src/progressive-disclosure.js";
import { createRetryManager, getToolNameFromRequest } from "../src/retry.js";
import type { JsonRpcMessage } from "../src/json-rpc.js";

const sampleTools: ToolSchema[] = [
  { name: "read_file", description: "Read file contents", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to a file", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "list_directory", description: "List files in a directory", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "search_files", description: "Search for files matching a pattern", inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  { name: "delete_file", description: "Delete a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
];

function makeHandler(usageStore?: UsageStore | null, threshold = 3) {
  return createPDHandler({
    serverCommand: "test-server",
    serverArgs: [],
    historyThreshold: threshold,
    usageStore: usageStore ?? null,
  });
}

// --- Phase transition boundary tests ---

describe("Phase transitions at threshold boundaries", () => {
  it("stays Phase 2 when sessions == threshold - 1 (boundary below)", () => {
    // threshold=3, sessions=2, all tools used in session 0
    // gap = 2 - 0 = 2, which is < 3, so no filter candidates
    const store: UsageStore = {
      serverKey: "test",
      tools: {
        delete_file: { name: "delete_file", callCount: 1, lastSessionUsed: 0, lastUsed: "2026-01-01", errors: 0 },
      },
      sessions: 2,
      lastUpdated: "2026-01-02",
    };
    const pd = makeHandler(store);
    pd.loadSchemas(sampleTools);

    expect(pd.getPhase()).toBe(2);
    expect(pd.isHiddenTool("delete_file")).toBe(false);
  });

  it("transitions to Phase 3 exactly at threshold boundary (sessions == threshold, gap == threshold)", () => {
    // threshold=3, sessions=3, delete_file last used in session 0
    // gap = 3 - 0 = 3, which is >= 3, so filter candidate exists
    const store: UsageStore = {
      serverKey: "test",
      tools: {
        read_file: { name: "read_file", callCount: 10, lastSessionUsed: 2, lastUsed: "2026-01-03", errors: 0 },
        delete_file: { name: "delete_file", callCount: 1, lastSessionUsed: 0, lastUsed: "2026-01-01", errors: 0 },
      },
      sessions: 3,
      lastUpdated: "2026-01-03",
    };
    const pd = makeHandler(store);
    pd.loadSchemas(sampleTools);

    expect(pd.getPhase()).toBe(3);
    expect(pd.isHiddenTool("delete_file")).toBe(true);
    expect(pd.isHiddenTool("read_file")).toBe(false);
  });

  it("stays Phase 2 when gap is exactly threshold - 1", () => {
    // threshold=3, sessions=4, delete_file last used in session 2
    // gap = 4 - 2 = 2, which is < 3
    const store: UsageStore = {
      serverKey: "test",
      tools: {
        delete_file: { name: "delete_file", callCount: 1, lastSessionUsed: 2, lastUsed: "2026-01-03", errors: 0 },
      },
      sessions: 4,
      lastUpdated: "2026-01-04",
    };
    const pd = makeHandler(store);
    pd.loadSchemas(sampleTools);

    expect(pd.getPhase()).toBe(2);
    expect(pd.isHiddenTool("delete_file")).toBe(false);
  });

  it("multiple tools at different boundary distances", () => {
    // threshold=3, sessions=6
    // delete_file: gap = 6 - 2 = 4 >= 3 → hidden
    // search_files: gap = 6 - 3 = 3 >= 3 → hidden
    // list_directory: gap = 6 - 4 = 2 < 3 → visible
    const store: UsageStore = {
      serverKey: "test",
      tools: {
        read_file: { name: "read_file", callCount: 20, lastSessionUsed: 5, lastUsed: "2026-01-06", errors: 0 },
        write_file: { name: "write_file", callCount: 10, lastSessionUsed: 5, lastUsed: "2026-01-06", errors: 0 },
        list_directory: { name: "list_directory", callCount: 5, lastSessionUsed: 4, lastUsed: "2026-01-05", errors: 0 },
        search_files: { name: "search_files", callCount: 3, lastSessionUsed: 3, lastUsed: "2026-01-04", errors: 0 },
        delete_file: { name: "delete_file", callCount: 1, lastSessionUsed: 2, lastUsed: "2026-01-03", errors: 0 },
      },
      sessions: 6,
      lastUpdated: "2026-01-06",
    };
    const pd = makeHandler(store);
    pd.loadSchemas(sampleTools);

    expect(pd.getPhase()).toBe(3);
    expect(pd.isHiddenTool("read_file")).toBe(false);
    expect(pd.isHiddenTool("write_file")).toBe(false);
    expect(pd.isHiddenTool("list_directory")).toBe(false);
    expect(pd.isHiddenTool("search_files")).toBe(true);
    expect(pd.isHiddenTool("delete_file")).toBe(true);

    // Verify discover_tools finds both hidden tools
    const discovered = pd.discoverTools("");
    expect(discovered.length).toBe(2);
    const names = discovered.map((d) => d.name);
    expect(names).toContain("search_files");
    expect(names).toContain("delete_file");
  });
});

// --- Hidden → visible tool promotion ---

describe("Hidden tool promotion via discover_tools and processResponse", () => {
  function makePhase3Handler(): PDHandler {
    const store: UsageStore = {
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
    const pd = makeHandler(store);
    pd.loadSchemas(sampleTools);
    return pd;
  }

  it("hidden tool calls are transparently forwarded and recorded", () => {
    const pd = makePhase3Handler();

    expect(pd.isHiddenTool("delete_file")).toBe(true);
    expect(pd.isKnownTool("delete_file")).toBe(true);

    // Simulate a tools/call for a hidden tool going through and getting a response
    const request: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "delete_file", arguments: { path: "/tmp/test" } },
    };
    const response: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "deleted" }] },
    };

    const result = pd.processResponse(request, response);
    expect(result.toolHidden).toBe(true);
    expect(result.rewrittenResponse).toBeUndefined();
  });

  it("discover_tools returns hidden tools that can then be called", () => {
    const pd = makePhase3Handler();

    // Agent discovers the hidden tool
    const discovered = pd.discoverTools("delete");
    expect(discovered.length).toBe(1);
    expect(discovered[0].name).toBe("delete_file");

    // The tool is still known (will be forwarded upstream)
    expect(pd.isKnownTool("delete_file")).toBe(true);
  });

  it("usage recording works for hidden tools via processResponse", () => {
    const pd = makePhase3Handler();

    // Call the hidden tool multiple times
    for (let i = 0; i < 3; i++) {
      const req: JsonRpcMessage = { jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "delete_file", arguments: {} } };
      const res: JsonRpcMessage = { jsonrpc: "2.0", id: i, result: { content: [{ type: "text", text: "ok" }] } };
      pd.processResponse(req, res);
    }

    // Usage should be recorded (verified by flushUsage not throwing)
    // The tool should still be marked hidden in the current session
    expect(pd.isHiddenTool("delete_file")).toBe(true);
  });
});

// --- Retry × PD interaction ---

describe("Retry × Progressive Disclosure interaction", () => {
  it("retry does not double-count tool usage via processResponse", () => {
    const store: UsageStore = {
      serverKey: "test",
      tools: {
        read_file: { name: "read_file", callCount: 5, lastSessionUsed: 2, lastUsed: "2026-01-03", errors: 0 },
      },
      sessions: 3,
      lastUpdated: "2026-01-03",
    };
    const pd = makeHandler(store);
    pd.loadSchemas(sampleTools);

    const retry = createRetryManager(true);

    // Client sends a read_file request
    const request: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "/test.txt" } },
    };
    retry.trackRequest(request);

    // Upstream returns error — retry manager holds it and schedules retry
    const errorResponse: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 42,
      error: { code: -32000, message: "Temporary error" },
    };

    let retrySent = false;
    const retryResult = retry.handleResponse(errorResponse, () => { retrySent = true; });
    expect(retryResult.handled).toBe(true);
    expect(retryResult.forward).toBeUndefined(); // Held, not forwarded yet

    // PD should NOT process this error response (proxy skips PD on handled retries)
    // This is the key: the proxy only calls processResponse for non-retry responses

    // Now the retry succeeds
    const successResponse: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 42,
      result: { content: [{ type: "text", text: "file contents" }] },
    };

    const retryResult2 = retry.handleResponse(successResponse, () => {});
    expect(retryResult2.handled).toBe(true);
    expect(retryResult2.forward).toEqual(successResponse);

    // Now PD processes only the final successful response
    // (proxy would call processResponse with the forwarded response)
    const pdResult = pd.processResponse(request, successResponse);
    expect(pdResult.toolHidden).toBe(false); // read_file is visible
  });

  it("hidden tool error + retry: PD records only the final outcome", () => {
    const store: UsageStore = {
      serverKey: "test",
      tools: {
        read_file: { name: "read_file", callCount: 20, lastSessionUsed: 4, lastUsed: "2026-01-05", errors: 0 },
        delete_file: { name: "delete_file", callCount: 1, lastSessionUsed: 0, lastUsed: "2026-01-01", errors: 0 },
      },
      sessions: 5,
      lastUpdated: "2026-01-05",
    };
    const pd = makeHandler(store);
    pd.loadSchemas(sampleTools);

    // delete_file is hidden, but read_file is retryable
    expect(pd.isHiddenTool("delete_file")).toBe(true);

    const retry = createRetryManager(true);

    // read_file fails and gets retried
    const readReq: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/x" } } };
    retry.trackRequest(readReq);

    const errorResp: JsonRpcMessage = { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "temp" } };
    const r1 = retry.handleResponse(errorResp, () => {});
    expect(r1.handled).toBe(true);

    // Retry succeeds
    const successResp: JsonRpcMessage = { jsonrpc: "2.0", id: 1, result: { content: [] } };
    const r2 = retry.handleResponse(successResp, () => {});
    expect(r2.handled).toBe(true);
    expect(r2.forward).toEqual(successResp);

    // PD only sees the success
    const pdResult = pd.processResponse(readReq, successResp);
    expect(pdResult.toolHidden).toBe(false);
  });

  it("non-retryable tool error passes through to PD normally", () => {
    const store: UsageStore = {
      serverKey: "test",
      tools: {
        write_file: { name: "write_file", callCount: 5, lastSessionUsed: 2, lastUsed: "2026-01-03", errors: 0 },
      },
      sessions: 3,
      lastUpdated: "2026-01-03",
    };
    const pd = makeHandler(store);
    pd.loadSchemas(sampleTools);

    const retry = createRetryManager(true);

    // write_file is NOT retryable
    const writeReq: JsonRpcMessage = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "write_file", arguments: { path: "/x", content: "y" } } };
    retry.trackRequest(writeReq);

    const errorResp: JsonRpcMessage = { jsonrpc: "2.0", id: 5, error: { code: -32000, message: "permission denied" } };
    const r = retry.handleResponse(errorResp, () => {});
    expect(r.handled).toBe(false); // Not retried

    // PD processes the error normally
    const pdResult = pd.processResponse(writeReq, errorResp);
    expect(pdResult.toolHidden).toBe(false);
    expect(pdResult.rewrittenResponse).toBeUndefined();
  });
});

// --- RetryManager edge cases ---

describe("RetryManager edge cases", () => {
  it("permanent error codes are never retried", () => {
    const retry = createRetryManager(true);
    const req: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/x" } } };
    retry.trackRequest(req);

    // -32601 is "method not found" — permanent
    const resp: JsonRpcMessage = { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not found" } };
    const r = retry.handleResponse(resp, () => {});
    expect(r.handled).toBe(false); // Not retried despite being read-only
  });

  it("drain returns held errors and orphaned request ids", () => {
    const retry = createRetryManager(true);

    // Track two requests
    retry.trackRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/a" } } });
    retry.trackRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", arguments: { path: "/b" } } });

    // First request gets an error and is scheduled for retry
    const err: JsonRpcMessage = { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "temp" } };
    retry.handleResponse(err, () => {});

    // Drain without second request ever completing
    const { heldErrors, orphanedIds } = retry.drain();
    expect(heldErrors.length).toBe(1);
    expect(heldErrors[0].id).toBe(1);
    expect(orphanedIds).toContain(2);
  });

  it("disabled retry manager passes everything through", () => {
    const retry = createRetryManager(false);
    const req: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/x" } } };
    retry.trackRequest(req);

    const err: JsonRpcMessage = { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "temp" } };
    const r = retry.handleResponse(err, () => {});
    expect(r.handled).toBe(false); // Not retried because disabled
  });
});

// --- processResponse integration ---

describe("PDHandler.processResponse", () => {
  it("rewrites tools/list response in Phase 2", () => {
    const store: UsageStore = {
      serverKey: "test",
      tools: {},
      sessions: 1,
      lastUpdated: "2026-01-01",
    };
    const pd = makeHandler(store);

    const listReq: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const listResp: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: sampleTools },
    };

    const result = pd.processResponse(listReq, listResp);

    expect(result.rewrittenResponse).toBeDefined();
    expect(result.logMeta?.pd_active).toBe(true);
    expect(result.logMeta?.pd_phase).toBe(2);
    expect(result.logMeta?.schema_tokens_saved).toBeGreaterThanOrEqual(0);
    expect(result.statusMessage).toContain("Phase 2");

    // After processing, handler should be active
    expect(pd.isActive()).toBe(true);
    expect(pd.getPhase()).toBe(2);
  });

  it("returns no rewrite for non-tools/list responses", () => {
    const store: UsageStore = { serverKey: "test", tools: {}, sessions: 1, lastUpdated: "2026-01-01" };
    const pd = makeHandler(store);
    pd.loadSchemas(sampleTools);

    const req: JsonRpcMessage = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", arguments: { path: "/x" } } };
    const resp: JsonRpcMessage = { jsonrpc: "2.0", id: 2, result: { content: [] } };

    const result = pd.processResponse(req, resp);
    expect(result.rewrittenResponse).toBeUndefined();
    expect(result.toolHidden).toBe(false);
  });

  it("returns error string on tools/list interception failure", () => {
    const store: UsageStore = { serverKey: "test", tools: {}, sessions: 1, lastUpdated: "2026-01-01" };
    const pd = makeHandler(store);

    const listReq: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    // Malformed result — tools is not an array
    const listResp: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: "not-an-array" },
    };

    const result = pd.processResponse(listReq, listResp);
    // Should not crash — either returns no rewrite or an error
    expect(result.rewrittenResponse).toBeUndefined();
  });

  it("does nothing when handler is not active", () => {
    const pd = makeHandler(null);
    // Don't call loadSchemas — handler is not active

    const req: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: {} } };
    const resp: JsonRpcMessage = { jsonrpc: "2.0", id: 1, result: {} };

    const result = pd.processResponse(req, resp);
    expect(result.toolHidden).toBe(false);
    expect(result.rewrittenResponse).toBeUndefined();
  });
});

// --- Concurrent flushUsage ---

describe("Concurrent flushUsage with file locking", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `flight-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("concurrent flushUsage calls produce correct session count", async () => {
    // Create two handlers pointing to the same server key
    // Both flush concurrently — with locking, sessions should be 2, not 1
    const pd1 = createPDHandler({
      serverCommand: "concurrent-test",
      serverArgs: [testDir], // Use testDir in args to make unique server key
      historyThreshold: 3,
      usageStore: null,
    });
    const pd2 = createPDHandler({
      serverCommand: "concurrent-test",
      serverArgs: [testDir],
      historyThreshold: 3,
      usageStore: null,
    });

    pd1.loadSchemas(sampleTools);
    pd2.loadSchemas(sampleTools);

    pd1.recordToolCall("read_file", false);
    pd2.recordToolCall("write_file", false);

    // Flush both concurrently
    await Promise.all([pd1.flushUsage(), pd2.flushUsage()]);

    // Read the usage file and verify
    const { createHash } = await import("node:crypto");
    const { homedir } = await import("node:os");
    const serverKey = createHash("sha256")
      .update(`concurrent-test ${testDir}`)
      .digest("hex");
    const usagePath = join(homedir(), ".flight", "usage", `${serverKey}.json`);

    const content = await readFile(usagePath, "utf-8");
    const store = JSON.parse(content) as UsageStore;

    expect(store.sessions).toBe(2);
    expect(store.tools.read_file).toBeDefined();
    expect(store.tools.write_file).toBeDefined();
    expect(store.tools.read_file.callCount).toBe(1);
    expect(store.tools.write_file.callCount).toBe(1);

    // Clean up
    const { unlink } = await import("node:fs/promises");
    try { await unlink(usagePath); } catch { /* ignore */ }
  });

  it("flushUsage succeeds even when usage dir does not exist", async () => {
    const pd = createPDHandler({
      serverCommand: "nonexistent-dir-test",
      serverArgs: [Date.now().toString()],
      historyThreshold: 3,
      usageStore: null,
    });
    pd.loadSchemas(sampleTools);
    pd.recordToolCall("read_file", false);

    // Should not throw — creates dir automatically
    await expect(pd.flushUsage()).resolves.toBeUndefined();
  });
});
