#!/usr/bin/env npx tsx
/**
 * Scenario runner for the Flight Proxy simulation framework.
 *
 * Drives mock MCP servers through the Flight proxy to generate realistic
 * session data. Run via: npx tsx test/simulate/runner.ts [options]
 *
 * Options:
 *   --pd / --no-pd         Enable or disable progressive disclosure (default: off)
 *   --sessions <n>         Number of sessions per scenario (default: 1)
 *   --scenario <name>      Run a specific scenario by name
 *   --all                  Run all scenarios (default if no --scenario given)
 *   --error-rate <0-1>     Mock server error injection rate (default: 0)
 *   --quiet                Suppress proxy stderr output
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { scenarios, scenarioMap } from "./scenarios.js";
import type { Scenario, RunOptions, RunResult } from "./types.js";

const MOCK_SERVERS: Record<string, string> = {
  fs: join(import.meta.dirname, "mock-fs-server.ts"),
  git: join(import.meta.dirname, "mock-git-server.ts"),
  web: join(import.meta.dirname, "mock-web-server.ts"),
};
const PROXY_MODULE = join(import.meta.dirname, "..", "..", "src", "proxy.ts");

// ── CLI Argument Parsing ──────────────────────────────────────────────

function parseArgs(argv: string[]): RunOptions {
  let pd = false;
  let sessions = 1;
  let scenarioNames: string[] | "all" = "all";
  let errorRate = 0;
  let quiet = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pd") {
      pd = true;
    } else if (arg === "--no-pd") {
      pd = false;
    } else if (arg === "--sessions" && argv[i + 1]) {
      sessions = parseInt(argv[++i], 10);
    } else if (arg === "--scenario" && argv[i + 1]) {
      const name = argv[++i];
      if (scenarioNames === "all") scenarioNames = [];
      (scenarioNames as string[]).push(name);
    } else if (arg === "--all") {
      scenarioNames = "all";
    } else if (arg === "--error-rate" && argv[i + 1]) {
      errorRate = parseFloat(argv[++i]);
    } else if (arg === "--quiet") {
      quiet = true;
    }
  }

  return { pd, sessions, scenarios: scenarioNames, errorRate, quiet };
}

// ── Proxy Spawning ────────────────────────────────────────────────────

interface ProxyHandle {
  child: ChildProcess;
  send: (msg: Record<string, unknown>) => void;
  waitForResponses: (count: number, timeoutMs?: number) => Promise<void>;
  close: () => void;
  responses: Array<Record<string, unknown>>;
  errors: string[];
}

function spawnProxy(
  mockServerPath: string,
  logDir: string,
  pd: boolean,
  errorRate: number,
): ProxyHandle {
  const proxyModulePath = PROXY_MODULE.replace(/\\/g, "/");
  const mockPath = mockServerPath.replace(/\\/g, "/");
  const logDirPath = logDir.replace(/\\/g, "/");

  const child = spawn("npx", ["tsx", "-e", `
    import { startProxy } from "${proxyModulePath}";
    process.env.FLIGHT_LOG_DIR = "${logDirPath}";
    startProxy({
      command: "npx",
      args: ["tsx", "${mockPath}"],
      logDir: "${logDirPath}",
      quiet: true,
      pd: ${pd},
    });
  `], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MOCK_ERROR_RATE: String(errorRate) },
  });

  const responses: Array<Record<string, unknown>> = [];
  const errors: string[] = [];

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      try {
        responses.push(JSON.parse(line.trim()));
      } catch {
        // ignore non-JSON output
      }
    });
  }

  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      errors.push(chunk.toString());
    });
  }

  function send(msg: Record<string, unknown>): void {
    child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  function waitForResponses(count: number, timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (responses.length >= count) return resolve();
        if (Date.now() - start > timeoutMs) {
          return reject(
            new Error(`Timeout waiting for ${count} responses, got ${responses.length}`),
          );
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  function close(): void {
    child.stdin!.end();
    child.kill();
  }

  return { child, send, waitForResponses, close, responses, errors };
}

// ── Scenario Execution ───────────────────────────────────────────────

async function runScenario(
  scenario: Scenario,
  sessionNum: number,
  opts: RunOptions,
): Promise<RunResult> {
  const logDir = await mkdtemp(
    join(tmpdir(), `flight-sim-${scenario.name}-s${sessionNum}-`),
  );

  // Determine mock server path based on scenario.server
  const mockServerPath = MOCK_SERVERS[scenario.server];
  if (!mockServerPath) {
    throw new Error(`Unknown server type: ${scenario.server}`);
  }

  const startTime = Date.now();
  const proxy = spawnProxy(mockServerPath, logDir, opts.pd, opts.errorRate);

  let responseCount = 0;
  let successfulCalls = 0;
  let failedCalls = 0;

  try {
    // ── Handshake: initialize ──
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "flight-simulator", version: "1.0" },
      },
    });
    await proxy.waitForResponses(++responseCount);

    // ── Handshake: notifications/initialized ──
    proxy.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    // No response expected for notifications

    // ── Handshake: tools/list ──
    proxy.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    await proxy.waitForResponses(++responseCount);

    // ── Execute scenario steps ──
    let nextId = 3;
    for (const step of scenario.steps) {
      if (step.delayMs) {
        await delay(step.delayMs);
      }

      const id = nextId++;
      proxy.send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: step.tool, arguments: step.args },
      });

      await proxy.waitForResponses(++responseCount, 15000);

      const response = proxy.responses[responseCount - 1];
      if (response && "error" in response) {
        failedCalls++;
      } else {
        successfulCalls++;
      }
    }
  } catch (err) {
    if (!opts.quiet) {
      process.stderr.write(
        `[runner] Error in ${scenario.name} session ${sessionNum}: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  } finally {
    proxy.close();
    // Allow logs to flush
    await delay(300);
  }

  const durationMs = Date.now() - startTime;

  return {
    scenario: scenario.name,
    session: sessionNum,
    pd: opts.pd,
    totalCalls: scenario.steps.length,
    successfulCalls,
    failedCalls,
    durationMs,
    logDir,
  };
}

// ── Utilities ─────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printSummaryTable(results: RunResult[]): void {
  const header = [
    "Scenario".padEnd(28),
    "Sess",
    "PD".padEnd(4),
    "Total",
    "OK".padStart(4),
    "Fail".padStart(5),
    "Duration".padStart(10),
    "Log Dir",
  ].join(" | ");

  const separator = "-".repeat(header.length);

  process.stdout.write("\n" + separator + "\n");
  process.stdout.write(header + "\n");
  process.stdout.write(separator + "\n");

  for (const r of results) {
    const row = [
      r.scenario.padEnd(28),
      String(r.session).padStart(4),
      (r.pd ? "yes" : "no").padEnd(4),
      String(r.totalCalls).padStart(5),
      String(r.successfulCalls).padStart(4),
      String(r.failedCalls).padStart(5),
      `${r.durationMs}ms`.padStart(10),
      r.logDir,
    ].join(" | ");
    process.stdout.write(row + "\n");
  }

  process.stdout.write(separator + "\n");

  const totals = results.reduce(
    (acc, r) => ({
      calls: acc.calls + r.totalCalls,
      ok: acc.ok + r.successfulCalls,
      fail: acc.fail + r.failedCalls,
      duration: acc.duration + r.durationMs,
    }),
    { calls: 0, ok: 0, fail: 0, duration: 0 },
  );

  process.stdout.write(
    `\nTotals: ${totals.calls} calls, ${totals.ok} succeeded, ${totals.fail} failed, ${totals.duration}ms total\n`,
  );
}

// ── Main ──────────────────────────────────────────────────────────────

export async function runSimulation(opts: RunOptions): Promise<RunResult[]> {
  // Resolve which scenarios to run
  let selectedScenarios: Scenario[];
  if (opts.scenarios === "all") {
    selectedScenarios = scenarios;
  } else {
    selectedScenarios = [];
    for (const name of opts.scenarios) {
      const s = scenarioMap.get(name);
      if (!s) {
        process.stderr.write(`[runner] Unknown scenario: ${name}\n`);
        process.stderr.write(
          `[runner] Available: ${scenarios.map((sc) => sc.name).join(", ")}\n`,
        );
        process.exit(1);
      }
      selectedScenarios.push(s);
    }
  }

  if (!opts.quiet) {
    process.stderr.write(
      `[runner] Running ${selectedScenarios.length} scenario(s) x ${opts.sessions} session(s), PD=${opts.pd}, errorRate=${opts.errorRate}\n`,
    );
  }

  const results: RunResult[] = [];

  for (const scenario of selectedScenarios) {
    for (let session = 1; session <= opts.sessions; session++) {
      if (!opts.quiet) {
        process.stderr.write(
          `[runner] ${scenario.name} session ${session}/${opts.sessions}...\n`,
        );
      }
      const result = await runScenario(scenario, session, opts);
      results.push(result);
    }
  }

  return results;
}

// ── CLI Entry Point ───────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  const results = await runSimulation(opts);
  printSummaryTable(results);
  process.exit(0);
}

// Only run CLI when executed directly (not when imported as a module)
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("runner.ts") ||
    process.argv[1].endsWith("runner.js"));

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`[runner] Fatal: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
}
