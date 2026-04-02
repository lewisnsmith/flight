import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile, rm } from "node:fs/promises";
import { createFlightClient } from "../src/sdk.js";
import type { LogEntry } from "../src/logger.js";

const testDir = join(tmpdir(), `flight-sdk-${Date.now()}`);

afterEach(async () => {
  try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
});

function parseEntries(content: string): LogEntry[] {
  return content.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogEntry);
}

describe("FlightClient", () => {
  it("generates a session ID", async () => {
    const client = await createFlightClient({ logDir: testDir });
    expect(client.sessionId).toMatch(/^session_/);
    await client.close();
  });

  it("accepts a custom session ID", async () => {
    const client = await createFlightClient({ logDir: testDir, sessionId: "custom-session-123" });
    expect(client.sessionId).toBe("custom-session-123");
    await client.close();
  });

  it("logs tool calls as request/response pairs", async () => {
    const client = await createFlightClient({ logDir: testDir });
    client.logToolCall("read_file", { path: "/tmp/test.txt" }, "file contents");
    await client.close();

    const content = await readFile(join(testDir, `${client.sessionId}.jsonl`), "utf-8");
    const entries = parseEntries(content);

    expect(entries).toHaveLength(2);
    // Request
    expect(entries[0].direction).toBe("client->server");
    expect(entries[0].method).toBe("tools/call");
    expect(entries[0].tool_name).toBe("read_file");
    expect(entries[0].event_type).toBe("tool_call");
    // Response
    expect(entries[1].direction).toBe("server->client");
    expect(entries[1].event_type).toBe("tool_result");
    expect(entries[1].error).toBeUndefined();
  });

  it("logs tool call errors", async () => {
    const client = await createFlightClient({ logDir: testDir });
    client.logToolCall("write_file", { path: "/etc/passwd" }, undefined, "Permission denied");
    await client.close();

    const content = await readFile(join(testDir, `${client.sessionId}.jsonl`), "utf-8");
    const entries = parseEntries(content);

    expect(entries).toHaveLength(2);
    expect(entries[1].error).toBe("Permission denied");
  });

  it("logs agent actions", async () => {
    const client = await createFlightClient({ logDir: testDir });
    client.logAction("buy_stock", "success", { ticker: "AAPL", quantity: 10 });
    await client.close();

    const content = await readFile(join(testDir, `${client.sessionId}.jsonl`), "utf-8");
    const entries = parseEntries(content);

    expect(entries).toHaveLength(1);
    expect(entries[0].method).toBe("agent/action");
    expect(entries[0].event_type).toBe("tool_call");
  });

  it("logs evaluations", async () => {
    const client = await createFlightClient({ logDir: testDir });
    client.logEvaluation(0.85, { task: "portfolio_rebalance" });
    await client.close();

    const content = await readFile(join(testDir, `${client.sessionId}.jsonl`), "utf-8");
    const entries = parseEntries(content);

    expect(entries).toHaveLength(1);
    expect(entries[0].method).toBe("agent/evaluation");
  });

  it("stamps run_id and agent_id on every entry", async () => {
    const client = await createFlightClient({
      logDir: testDir,
      runId: "experiment-42",
      agentId: "heuristic-agent-1",
    });
    client.logToolCall("analyze", { data: [1, 2, 3] }, { result: "ok" });
    client.logAction("decide", "hold");
    await client.close();

    const content = await readFile(join(testDir, `${client.sessionId}.jsonl`), "utf-8");
    const entries = parseEntries(content);

    for (const entry of entries) {
      expect(entry.run_id).toBe("experiment-42");
      expect(entry.agent_id).toBe("heuristic-agent-1");
    }
  });

  it("stamps model_config on every entry", async () => {
    const client = await createFlightClient({
      logDir: testDir,
      modelConfig: {
        model: "llama-3-8b",
        quantization: "gptq-4bit",
        provider: "local",
      },
    });
    client.logToolCall("predict", { input: "test" }, { prediction: 0.7 });
    await client.close();

    const content = await readFile(join(testDir, `${client.sessionId}.jsonl`), "utf-8");
    const entries = parseEntries(content);

    expect(entries[0].model_config).toEqual({
      model: "llama-3-8b",
      quantization: "gptq-4bit",
      provider: "local",
    });
  });

  it("supports closeSync for signal handlers", async () => {
    const client = await createFlightClient({ logDir: testDir });
    client.logToolCall("test", {}, "ok");
    client.closeSync();

    const content = await readFile(join(testDir, `${client.sessionId}.jsonl`), "utf-8");
    const entries = parseEntries(content);
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });
});
