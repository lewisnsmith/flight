import { describe, it, expect, afterEach } from "vitest";
import { createSessionLogger, type AlertEntry } from "../src/logger.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

describe("loop detection", () => {
  let logDir: string;

  afterEach(async () => {
    if (logDir) {
      try { await rm(logDir, { recursive: true }); } catch { /* ignore */ }
    }
  });

  it("emits loop alert when same tool+args called 5 times within 60s", async () => {
    logDir = join(tmpdir(), `flight-loop-${Date.now()}`);
    const logger = await createSessionLogger(logDir);

    const alerts: AlertEntry[] = [];
    logger.onAlert = (alert) => alerts.push(alert);

    for (let i = 0; i < 5; i++) {
      logger.log(
        { jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/same/file.ts" } } },
        "client->server",
      );
      logger.log(
        { jsonrpc: "2.0", id: i + 1, result: { content: [] } },
        "server->client",
      );
    }

    await logger.close();

    const loopAlerts = alerts.filter((a) => a.severity === "loop");
    expect(loopAlerts.length).toBeGreaterThanOrEqual(1);
    expect(loopAlerts[0].message).toContain("read_file");
  });

  it("does not emit loop alert for different arguments", async () => {
    logDir = join(tmpdir(), `flight-loop-diff-${Date.now()}`);
    const logger = await createSessionLogger(logDir);

    const alerts: AlertEntry[] = [];
    logger.onAlert = (alert) => alerts.push(alert);

    for (let i = 0; i < 5; i++) {
      logger.log(
        { jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: "read_file", arguments: { path: `/file${i}.ts` } } },
        "client->server",
      );
      logger.log(
        { jsonrpc: "2.0", id: i + 1, result: { content: [] } },
        "server->client",
      );
    }

    await logger.close();

    const loopAlerts = alerts.filter((a) => a.severity === "loop");
    expect(loopAlerts.length).toBe(0);
  });
});
