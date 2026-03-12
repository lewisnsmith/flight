import { describe, it, expect } from "vitest";
import { entriesToCsv, entriesToJsonl } from "../src/export.js";
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

describe("entriesToCsv", () => {
  it("produces CSV with header and data rows", () => {
    const entries: LogEntry[] = [
      makeEntry({ tool_name: "read_file", error: undefined }),
      makeEntry({ tool_name: "write_file", error: "Permission denied", hallucination_hint: true }),
    ];

    const csv = entriesToCsv(entries);
    const lines = csv.trim().split("\n");

    expect(lines[0]).toBe("session_id,call_id,timestamp,direction,method,tool_name,latency_ms,error,hallucination_hint,pd_active");
    expect(lines.length).toBe(3);
    expect(lines[2]).toContain("Permission denied");
    expect(lines[2]).toContain("true");
  });

  it("escapes commas and quotes in fields", () => {
    const entries: LogEntry[] = [
      makeEntry({ error: 'Error: "bad, input"' }),
    ];

    const csv = entriesToCsv(entries);
    const lines = csv.trim().split("\n");
    expect(lines[1]).toContain('"Error: ""bad, input"""');
  });
});

describe("entriesToJsonl", () => {
  it("produces one JSON line per entry without payload", () => {
    const entries: LogEntry[] = [
      makeEntry({ tool_name: "read_file" }),
      makeEntry({ tool_name: "write_file" }),
    ];

    const jsonl = entriesToJsonl(entries);
    const lines = jsonl.trim().split("\n");

    expect(lines.length).toBe(2);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.tool_name).toBe("read_file");
    expect(parsed.payload).toBeUndefined();
  });

  it("includes payload when requested", () => {
    const entries: LogEntry[] = [
      makeEntry({ tool_name: "read_file", payload: { data: "hello" } }),
    ];

    const jsonl = entriesToJsonl(entries, { includePayload: true });
    const parsed = JSON.parse(jsonl.trim());
    expect(parsed.payload).toEqual({ data: "hello" });
  });
});
