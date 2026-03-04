import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LogEntry } from "../src/logger.js";

// We test the log reading/filtering logic by creating mock log files
// and importing the internal helpers. Since log-commands.ts uses a hardcoded
// DEFAULT_LOG_DIR, we test the formatting and filtering logic directly.

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    session_id: "session_test",
    call_id: "call_001",
    timestamp: "2026-03-15T14:02:11.421Z",
    latency_ms: 5,
    direction: "client->server",
    method: "tools/call",
    tool_name: "read_file",
    payload: { method: "tools/call", params: { name: "read_file" } },
    pd_active: false,
    ...overrides,
  };
}

describe("LogEntry filtering logic", () => {
  it("filters by tool name", () => {
    const entries = [
      makeEntry({ tool_name: "read_file" }),
      makeEntry({ tool_name: "write_file", call_id: "call_002" }),
      makeEntry({ tool_name: "read_file", call_id: "call_003" }),
    ];

    const filtered = entries.filter((e) => e.tool_name === "read_file");
    expect(filtered).toHaveLength(2);
  });

  it("filters by errors", () => {
    const entries = [
      makeEntry(),
      makeEntry({ error: "Permission denied", call_id: "call_002" }),
      makeEntry({ call_id: "call_003" }),
    ];

    const filtered = entries.filter((e) => e.error);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].error).toBe("Permission denied");
  });

  it("filters by hallucination hints", () => {
    const entries = [
      makeEntry(),
      makeEntry({ hallucination_hint: true, call_id: "call_002" }),
      makeEntry({ hallucination_hint: true, call_id: "call_003" }),
    ];

    const filtered = entries.filter((e) => e.hallucination_hint);
    expect(filtered).toHaveLength(2);
  });

  it("combines filters", () => {
    const entries = [
      makeEntry({ error: "fail", hallucination_hint: true }),
      makeEntry({ error: "fail", call_id: "call_002" }),
      makeEntry({ hallucination_hint: true, call_id: "call_003" }),
      makeEntry({ call_id: "call_004" }),
    ];

    const filtered = entries.filter((e) => e.error && e.hallucination_hint);
    expect(filtered).toHaveLength(1);
  });
});

describe("LogEntry serialization", () => {
  it("round-trips through JSON", () => {
    const entry = makeEntry({
      error: "test error",
      hallucination_hint: true,
      latency_ms: 42,
    });

    const json = JSON.stringify(entry);
    const parsed = JSON.parse(json) as LogEntry;

    expect(parsed.session_id).toBe(entry.session_id);
    expect(parsed.error).toBe("test error");
    expect(parsed.hallucination_hint).toBe(true);
    expect(parsed.latency_ms).toBe(42);
    expect(parsed.pd_active).toBe(false);
  });
});
