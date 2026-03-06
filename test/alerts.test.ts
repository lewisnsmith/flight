import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createSessionLogger, type AlertEntry, getAlertLogPath } from "../src/logger.js";
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

let testLogDir: string;

beforeEach(async () => {
  testLogDir = join(tmpdir(), `flight-alerts-${Date.now()}`);
});

afterEach(async () => {
  try { await rm(testLogDir, { recursive: true }); } catch { /* ignore */ }
});

describe("Alert System", () => {
  it("emits error alert on server error response", async () => {
    const logger = await createSessionLogger(testLogDir);
    const alerts: AlertEntry[] = [];
    logger.onAlert = (alert) => alerts.push(alert);

    // Send a request
    logger.log(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_file" } },
      "client->server",
    );

    // Receive error response
    logger.log(
      { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Permission denied" } },
      "server->client",
    );

    logger.close();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("error");
    expect(alerts[0].message).toBe("Permission denied");
    expect(alerts[0].session_id).toBe(logger.sessionId);
  });

  it("emits hallucination alert when agent proceeds without retrying", async () => {
    const logger = await createSessionLogger(testLogDir);
    const alerts: AlertEntry[] = [];
    logger.onAlert = (alert) => alerts.push(alert);

    // Request that will error
    logger.log(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_file" } },
      "client->server",
    );

    // Error response
    logger.log(
      { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Permission denied" } },
      "server->client",
    );

    // Agent proceeds with different tool instead of retrying
    logger.log(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file" } },
      "client->server",
    );

    logger.close();

    const hallucinations = alerts.filter((a) => a.severity === "hallucination");
    expect(hallucinations).toHaveLength(1);
    expect(hallucinations[0].message).toContain("write_file");
    expect(hallucinations[0].message).toContain("without retrying");
  });

  it("does not emit hallucination alert when agent retries same tool", async () => {
    const logger = await createSessionLogger(testLogDir);
    const alerts: AlertEntry[] = [];
    logger.onAlert = (alert) => alerts.push(alert);

    // Request
    logger.log(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file" } },
      "client->server",
    );

    // Error response
    logger.log(
      { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "File not found" } },
      "server->client",
    );

    // Retry same tool
    logger.log(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file" } },
      "client->server",
    );

    logger.close();

    const hallucinations = alerts.filter((a) => a.severity === "hallucination");
    expect(hallucinations).toHaveLength(0);
  });

  it("writes alerts to alerts.jsonl", async () => {
    const alertPath = getAlertLogPath();
    // Ensure the alert directory exists
    await mkdir(dirname(alertPath), { recursive: true });

    const logger = await createSessionLogger(testLogDir);

    // Request
    logger.log(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search" } },
      "client->server",
    );

    // Error response → should write to alerts.jsonl
    logger.log(
      { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Search failed" } },
      "server->client",
    );

    logger.close();

    // Wait for fire-and-forget write
    await new Promise((r) => setTimeout(r, 200));

    const content = await readFile(alertPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const lastAlert = JSON.parse(lines[lines.length - 1]) as AlertEntry;

    expect(lastAlert.severity).toBe("error");
    expect(lastAlert.message).toBe("Search failed");
  });
});
