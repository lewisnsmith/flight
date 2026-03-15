import { describe, it, expect } from "vitest";
import { findCallRequest } from "../src/replay.js";
import type { LogEntry } from "../src/logger.js";

function makeEntry(overrides: Partial<LogEntry>): LogEntry {
  return {
    session_id: "session_test",
    call_id: "abc-123-def",
    timestamp: new Date().toISOString(),
    latency_ms: 0,
    direction: "client->server",
    method: "tools/call",
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/test" } } },
    pd_active: false,
    ...overrides,
  };
}

describe("findCallRequest", () => {
  it("finds by exact call_id", () => {
    const entries = [
      makeEntry({ call_id: "abc-123-def", direction: "client->server" }),
      makeEntry({ call_id: "abc-123-def", direction: "server->client" }),
    ];
    const result = findCallRequest(entries, "abc-123-def");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("client->server");
  });

  it("finds by prefix match", () => {
    const entries = [makeEntry({ call_id: "abc-123-def" })];
    const result = findCallRequest(entries, "abc");
    expect(result).not.toBeNull();
    expect(result!.call_id).toBe("abc-123-def");
  });

  it("returns null when not found", () => {
    const entries = [makeEntry({ call_id: "abc-123-def" })];
    const result = findCallRequest(entries, "xyz");
    expect(result).toBeNull();
  });

  it("only returns client->server entries", () => {
    const entries = [
      makeEntry({ call_id: "abc-123", direction: "server->client" }),
    ];
    const result = findCallRequest(entries, "abc");
    expect(result).toBeNull();
  });
});
