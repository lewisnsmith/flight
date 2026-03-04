import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { LogEntry } from "../src/logger.js";

const MOCK_SERVER = join(import.meta.dirname, "mock-mcp-server.ts");
const PROXY_MODULE = join(import.meta.dirname, "..", "src", "proxy.ts");

function createBenchProxy(logDir: string) {
  const child = spawn("npx", ["tsx", "-e", `
    import { startProxy } from "${PROXY_MODULE.replace(/\\/g, "/")}";
    startProxy({
      command: "npx",
      args: ["tsx", "${MOCK_SERVER.replace(/\\/g, "/")}"],
      logDir: "${logDir.replace(/\\/g, "/")}",
    });
  `], { stdio: ["pipe", "pipe", "pipe"] });

  let responseCount = 0;
  const rl = createInterface({ input: child.stdout! });
  rl.on("line", () => { responseCount++; });

  function send(msg: Record<string, unknown>): void {
    child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  function waitForResponses(count: number, timeoutMs = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (responseCount >= count) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout: got ${responseCount}/${count} responses`));
        setTimeout(check, 20);
      };
      check();
    });
  }

  return { send, waitForResponses, close: () => { child.stdin!.end(); child.kill(); }, get count() { return responseCount; } };
}

let testLogDir: string;

afterEach(async () => {
  if (testLogDir) {
    try { await rm(testLogDir, { recursive: true }); } catch { /* ignore */ }
  }
});

describe("Benchmark: Proxy throughput", () => {
  it("handles 100 small frequent calls (1KB each)", async () => {
    testLogDir = join(tmpdir(), `flight-bench-small-${Date.now()}`);
    const proxy = createBenchProxy(testLogDir);
    const CALL_COUNT = 100;

    // Initialize first
    proxy.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "1.0" } } });
    await proxy.waitForResponses(1);

    const start = Date.now();

    for (let i = 1; i <= CALL_COUNT; i++) {
      proxy.send({
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "read_file", arguments: { path: `/file_${i}.ts` } },
      });
    }

    await proxy.waitForResponses(CALL_COUNT + 1); // +1 for initialize
    const elapsed = Date.now() - start;

    proxy.close();
    await new Promise((r) => setTimeout(r, 300));

    // Verify logs
    const files = await readdir(testLogDir);
    const logFile = files.find((f) => f.endsWith(".jsonl"))!;
    const logContent = await readFile(join(testLogDir, logFile), "utf-8");
    const entries = logContent.trim().split("\n").filter(Boolean);

    console.log(`\n  Benchmark: ${CALL_COUNT} small calls in ${elapsed}ms (${Math.round(CALL_COUNT / (elapsed / 1000))} calls/sec)`);
    console.log(`  Log entries: ${entries.length}`);

    // Should complete all calls
    expect(entries.length).toBeGreaterThanOrEqual(CALL_COUNT * 2); // request + response each
  }, 60000);

  it("handles 10 large response calls (~10KB each)", async () => {
    testLogDir = join(tmpdir(), `flight-bench-large-${Date.now()}`);
    const proxy = createBenchProxy(testLogDir);
    const CALL_COUNT = 10;

    proxy.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "1.0" } } });
    await proxy.waitForResponses(1);

    const start = Date.now();

    // list_dir returns a JSON array — smaller than 1MB but tests the pipeline
    for (let i = 1; i <= CALL_COUNT; i++) {
      proxy.send({
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "list_dir", arguments: { path: `/dir_${i}` } },
      });
    }

    await proxy.waitForResponses(CALL_COUNT + 1);
    const elapsed = Date.now() - start;

    proxy.close();
    await new Promise((r) => setTimeout(r, 300));

    console.log(`\n  Benchmark: ${CALL_COUNT} larger calls in ${elapsed}ms`);

    expect(elapsed).toBeLessThan(30000); // Should complete well within 30s
  }, 60000);
});
