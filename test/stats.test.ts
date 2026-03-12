import { describe, it, expect } from "vitest";
import { computeStats, computeAggregateStats } from "../src/stats.js";
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

describe("computeStats", () => {
  it("computes total token savings from entries", () => {
    const entries: LogEntry[] = [
      makeEntry({ pd_active: true, schema_tokens_saved: 500 }),
      makeEntry({ pd_active: true, schema_tokens_saved: 300 }),
      makeEntry({ pd_active: true, schema_tokens_saved: 0 }),
      makeEntry({ pd_active: false }),
    ];

    const stats = computeStats(entries);
    expect(stats.totalTokensSaved).toBe(800);
    expect(stats.pdActive).toBe(true);
    expect(stats.totalCalls).toBe(4);
  });

  it("reports pdActive false when no PD entries exist", () => {
    const entries: LogEntry[] = [
      makeEntry({ pd_active: false }),
    ];

    const stats = computeStats(entries);
    expect(stats.pdActive).toBe(false);
    expect(stats.totalTokensSaved).toBe(0);
  });
});

describe("computeAggregateStats", () => {
  it("aggregates across multiple sessions", () => {
    const sessions: LogEntry[][] = [
      [makeEntry({ pd_active: true, schema_tokens_saved: 100 }), makeEntry({ error: "fail" })],
      [makeEntry({ pd_active: false }), makeEntry({ schema_tokens_saved: 200 })],
    ];

    const agg = computeAggregateStats(sessions);
    expect(agg.sessionCount).toBe(2);
    expect(agg.totalCalls).toBe(4);
    expect(agg.totalErrors).toBe(1);
    expect(agg.totalTokensSaved).toBe(300);
    expect(agg.pdSessionCount).toBe(1);
  });
});
