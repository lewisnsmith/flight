/**
 * Flight Proxy throughput benchmark.
 *
 * Spawns the proxy with a mock MCP server and measures:
 * - Small calls: 1000 x ~1KB requests → calls/sec
 * - Large calls: 50 x ~100KB requests → MB/sec
 *
 * Usage: npx tsx bench/throughput.ts
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

const MOCK_SERVER = join(import.meta.dirname, "..", "test", "mock-mcp-server.ts");
const PROXY_MODULE = join(import.meta.dirname, "..", "src", "proxy.ts");

function createProxy(logDir: string) {
  const child = spawn("npx", ["tsx", "-e", `
    import { startProxy } from "${PROXY_MODULE.replace(/\\/g, "/")}";
    startProxy({
      command: "npx",
      args: ["tsx", "${MOCK_SERVER.replace(/\\/g, "/")}"],
      logDir: "${logDir.replace(/\\/g, "/")}",
      quiet: true,
    });
  `], { stdio: ["pipe", "pipe", "pipe"] });

  let responseCount = 0;
  let totalResponseBytes = 0;
  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    responseCount++;
    totalResponseBytes += Buffer.byteLength(line);
  });

  function send(msg: Record<string, unknown>) {
    child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  function waitForResponses(count: number, timeoutMs = 60000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (responseCount >= count) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout: got ${responseCount}/${count}`));
        setTimeout(check, 10);
      };
      check();
    });
  }

  return {
    send,
    waitForResponses,
    close: () => { child.stdin!.end(); child.kill(); },
    get count() { return responseCount; },
    get bytes() { return totalResponseBytes; },
  };
}

async function benchSmallCalls() {
  const logDir = join(tmpdir(), `flight-bench-small-${Date.now()}`);
  const proxy = createProxy(logDir);
  const CALL_COUNT = 1000;

  // Initialize
  proxy.send({
    jsonrpc: "2.0", id: 0, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "1.0" } },
  });
  await proxy.waitForResponses(1);

  const start = Date.now();

  for (let i = 1; i <= CALL_COUNT; i++) {
    proxy.send({
      jsonrpc: "2.0", id: i, method: "tools/call",
      params: { name: "read_file", arguments: { path: `/file_${i}.ts` } },
    });
  }

  await proxy.waitForResponses(CALL_COUNT + 1);
  const elapsed = Date.now() - start;
  const callsPerSec = Math.round(CALL_COUNT / (elapsed / 1000));

  proxy.close();
  await rm(logDir, { recursive: true }).catch(() => {});

  return { callCount: CALL_COUNT, elapsed, callsPerSec };
}

async function benchLargeCalls() {
  const logDir = join(tmpdir(), `flight-bench-large-${Date.now()}`);
  const proxy = createProxy(logDir);
  const CALL_COUNT = 50;

  // Initialize
  proxy.send({
    jsonrpc: "2.0", id: 0, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "1.0" } },
  });
  await proxy.waitForResponses(1);

  const start = Date.now();

  for (let i = 1; i <= CALL_COUNT; i++) {
    proxy.send({
      jsonrpc: "2.0", id: i, method: "tools/call",
      params: { name: "list_dir", arguments: { path: `/dir_${i}` } },
    });
  }

  await proxy.waitForResponses(CALL_COUNT + 1);
  const elapsed = Date.now() - start;
  const totalMB = proxy.bytes / (1024 * 1024);
  const mbPerSec = totalMB / (elapsed / 1000);

  proxy.close();
  await rm(logDir, { recursive: true }).catch(() => {});

  return { callCount: CALL_COUNT, elapsed, totalMB, mbPerSec };
}

async function main() {
  console.log("Flight Proxy Throughput Benchmark");
  console.log("=================================\n");

  console.log("Running small-call benchmark (1000 x ~1KB)...");
  const small = await benchSmallCalls();
  console.log(`  ${small.callCount} calls in ${small.elapsed}ms → ${small.callsPerSec} calls/sec\n`);

  console.log("Running large-call benchmark (50 x ~100KB)...");
  const large = await benchLargeCalls();
  console.log(`  ${large.callCount} calls in ${large.elapsed}ms → ${large.mbPerSec.toFixed(2)} MB/sec\n`);

  console.log("Summary");
  console.log("-------");
  console.log(`  Small calls:  ${small.callsPerSec} calls/sec`);
  console.log(`  Large calls:  ${large.mbPerSec.toFixed(2)} MB/sec`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
