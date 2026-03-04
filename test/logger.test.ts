import { describe, it, expect, afterEach } from "vitest";
import { createSessionLogger } from "../src/logger.js";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_LOG_DIR = join(tmpdir(), "flight-test-logs-" + Date.now());

afterEach(async () => {
  try {
    await rm(TEST_LOG_DIR, { recursive: true });
  } catch {
    // ignore
  }
});

describe("SessionLogger", () => {
  it("creates a session with unique ID", async () => {
    const logger = await createSessionLogger(TEST_LOG_DIR);
    expect(logger.sessionId).toMatch(/^session_\d{8}_\d{6}$/);
    logger.close();
  });

  it("writes log entries to .jsonl file", async () => {
    const logger = await createSessionLogger(TEST_LOG_DIR);

    logger.log(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file" } },
      "client->server",
    );

    logger.log(
      { jsonrpc: "2.0", id: 1, result: { content: "file contents" } },
      "server->client",
    );

    logger.close();

    // Wait for flush
    await new Promise((resolve) => setTimeout(resolve, 200));

    const content = await readFile(logger.logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);

    const entry1 = JSON.parse(lines[0]);
    expect(entry1.direction).toBe("client->server");
    expect(entry1.method).toBe("tools/call");
    expect(entry1.tool_name).toBe("read_file");
    expect(entry1.session_id).toBe(logger.sessionId);
    expect(entry1.pd_active).toBe(false);

    const entry2 = JSON.parse(lines[1]);
    expect(entry2.direction).toBe("server->client");
    expect(entry2.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("logs errors", async () => {
    const logger = await createSessionLogger(TEST_LOG_DIR);

    logger.logError("upstream-stderr", "something went wrong");
    logger.close();

    await new Promise((resolve) => setTimeout(resolve, 200));

    const content = await readFile(logger.logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.error).toBe("something went wrong");
    expect(entry.method).toBe("upstream-stderr");
  });

  it("records error in response entries", async () => {
    const logger = await createSessionLogger(TEST_LOG_DIR);

    logger.log(
      { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Permission denied" } },
      "server->client",
    );

    logger.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const content = await readFile(logger.logPath, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.error).toBe("Permission denied");
  });
});
