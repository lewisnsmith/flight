import { describe, it, expect } from "vitest";
import { computeSummary } from "../src/summary.js";
import type { LogEntry } from "../src/logger.js";

function makeEntry(overrides: Partial<LogEntry>): LogEntry {
  return {
    session_id: "test-session",
    call_id: "call-1",
    timestamp: "2026-03-15T14:22:03.000Z",
    latency_ms: 10,
    direction: "client->server",
    method: "tools/call",
    payload: {},
    pd_active: false,
    ...overrides,
  };
}

describe("computeSummary", () => {
  it("computes call count, errors, hints, and top tools", () => {
    const entries: LogEntry[] = [
      makeEntry({ tool_name: "read_file", direction: "client->server" }),
      makeEntry({ tool_name: "read_file", direction: "server->client", latency_ms: 12 }),
      makeEntry({ tool_name: "read_file", direction: "client->server" }),
      makeEntry({ tool_name: "read_file", direction: "server->client", latency_ms: 8 }),
      makeEntry({ tool_name: "write_file", direction: "client->server" }),
      makeEntry({ tool_name: "write_file", direction: "server->client", error: "Permission denied" }),
      makeEntry({ tool_name: "list_dir", direction: "client->server", hallucination_hint: true }),
      makeEntry({ tool_name: "list_dir", direction: "server->client", latency_ms: 5 }),
    ];

    const summary = computeSummary(entries);

    expect(summary.totalCalls).toBe(8);
    expect(summary.errors).toBe(1);
    expect(summary.hallucinationHints).toBe(1);
    expect(summary.topTools[0]).toEqual({ name: "read_file", count: 4 });
    expect(summary.topTools.length).toBeLessThanOrEqual(5);
  });

  it("computes session duration from first to last timestamp", () => {
    const entries: LogEntry[] = [
      makeEntry({ timestamp: "2026-03-15T14:00:00.000Z" }),
      makeEntry({ timestamp: "2026-03-15T14:14:23.000Z" }),
    ];

    const summary = computeSummary(entries);
    expect(summary.durationMs).toBe(14 * 60 * 1000 + 23 * 1000);
  });

  it("generates timeline string with error markers", () => {
    const entries: LogEntry[] = [
      makeEntry({ direction: "client->server" }),
      makeEntry({ direction: "server->client" }),
      makeEntry({ direction: "client->server" }),
      makeEntry({ direction: "server->client", error: "fail" }),
      makeEntry({ direction: "client->server", hallucination_hint: true }),
      makeEntry({ direction: "server->client" }),
    ];

    const summary = computeSummary(entries);
    expect(summary.timeline).toBeDefined();
    expect(summary.timeline).toContain("x");
  });
});
