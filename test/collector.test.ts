import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { startCollector } from "../src/collector.js";
import type { LogEntry } from "../src/logger.js";

const testDir = join(tmpdir(), `flight-collector-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
let testPort = 14242 + Math.floor(Math.random() * 1000);

afterEach(async () => {
  try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
});

function post(port: number, path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "localhost", port, path, method: "POST", headers: { "Content-Type": "application/x-ndjson" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "localhost", port, path, method: "GET" }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("HTTP Collector", () => {
  it("serves health endpoint", async () => {
    const port = testPort++;
    const collector = await startCollector({ port, logDir: testDir });
    try {
      const res = await get(port, "/health");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("ok");
      expect(typeof body.sessions).toBe("number");
    } finally {
      await collector.close();
    }
  });

  it("ingests valid NDJSON entries", async () => {
    const port = testPort++;
    const collector = await startCollector({ port, logDir: testDir });
    try {
      const entries = [
        { session_id: "test-session-1", timestamp: "2026-04-01T10:00:00Z", event_type: "tool_call", method: "read_file" },
        { session_id: "test-session-1", timestamp: "2026-04-01T10:00:01Z", event_type: "tool_result", method: "response" },
      ];
      const body = entries.map((e) => JSON.stringify(e)).join("\n");
      const res = await post(port, "/ingest", body);

      expect(res.status).toBe(200);
      const result = JSON.parse(res.body);
      expect(result.accepted).toBe(2);
      expect(result.rejected).toBe(0);

      // Verify file was written
      const content = await readFile(join(testDir, "test-session-1.jsonl"), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
      const parsed = JSON.parse(lines[0]) as LogEntry;
      expect(parsed.session_id).toBe("test-session-1");
    } finally {
      await collector.close();
    }
  });

  it("routes entries to separate session files", async () => {
    const port = testPort++;
    const collector = await startCollector({ port, logDir: testDir });
    try {
      const entries = [
        { session_id: "session-a", timestamp: "2026-04-01T10:00:00Z", event_type: "tool_call" },
        { session_id: "session-b", timestamp: "2026-04-01T10:00:00Z", event_type: "tool_call" },
        { session_id: "session-a", timestamp: "2026-04-01T10:00:01Z", event_type: "tool_result" },
      ];
      const body = entries.map((e) => JSON.stringify(e)).join("\n");
      await post(port, "/ingest", body);

      const contentA = await readFile(join(testDir, "session-a.jsonl"), "utf-8");
      const contentB = await readFile(join(testDir, "session-b.jsonl"), "utf-8");
      expect(contentA.trim().split("\n")).toHaveLength(2);
      expect(contentB.trim().split("\n")).toHaveLength(1);
    } finally {
      await collector.close();
    }
  });

  it("rejects malformed entries", async () => {
    const port = testPort++;
    const collector = await startCollector({ port, logDir: testDir });
    try {
      const body = [
        JSON.stringify({ session_id: "valid", timestamp: "2026-04-01T10:00:00Z" }),
        "not json",
        JSON.stringify({ no_session: true }),  // missing session_id
      ].join("\n");

      const res = await post(port, "/ingest", body);
      const result = JSON.parse(res.body);
      expect(result.accepted).toBe(1);
      expect(result.rejected).toBe(2);
    } finally {
      await collector.close();
    }
  });

  it("returns 404 for unknown paths", async () => {
    const port = testPort++;
    const collector = await startCollector({ port, logDir: testDir });
    try {
      const res = await get(port, "/unknown");
      expect(res.status).toBe(404);
    } finally {
      await collector.close();
    }
  });
});
