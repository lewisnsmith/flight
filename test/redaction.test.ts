import { describe, it, expect, afterEach } from "vitest";
import { createSessionLogger } from "../src/logger.js";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LogEntry } from "../src/logger.js";

let testDir: string;

afterEach(async () => {
  if (testDir) {
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  }
});

describe("Secret redaction", () => {
  it("redacts env var values from payloads", async () => {
    testDir = join(tmpdir(), `flight-redact-${Date.now()}`);

    // Set a secret env var
    process.env.FLIGHT_TEST_SECRET = "super-secret-token-12345";

    const logger = await createSessionLogger(testDir, {
      redactEnvVars: ["FLIGHT_TEST_SECRET"],
    });

    logger.log(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "test", arguments: { token: "super-secret-token-12345", other: "safe-value" } },
      },
      "client->server",
    );

    logger.close();
    await new Promise((r) => setTimeout(r, 200));

    const content = await readFile(logger.logPath, "utf-8");

    // Secret should not appear in logs
    expect(content).not.toContain("super-secret-token-12345");
    expect(content).toContain("[REDACTED]");
    expect(content).toContain("safe-value");

    delete process.env.FLIGHT_TEST_SECRET;
  });

  it("redacts patterns matching regex", async () => {
    testDir = join(tmpdir(), `flight-redact-pattern-${Date.now()}`);

    const logger = await createSessionLogger(testDir, {
      redactPatterns: ["sk-[a-zA-Z0-9]+", "ghp_[a-zA-Z0-9]+"],
    });

    logger.log(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "test", arguments: { key: "sk-abc123XYZ", ghToken: "ghp_realtoken999", safe: "hello" } },
      },
      "client->server",
    );

    logger.close();
    await new Promise((r) => setTimeout(r, 200));

    const content = await readFile(logger.logPath, "utf-8");

    expect(content).not.toContain("sk-abc123XYZ");
    expect(content).not.toContain("ghp_realtoken999");
    expect(content).toContain("[REDACTED]");
    expect(content).toContain("hello");
  });
});
