#!/usr/bin/env npx tsx
/**
 * Stress test script (Task 8d)
 *
 * Runs 5 sequential sessions, each executing ALL scenarios with error-rate 0.1.
 * Reports totals and verifies log files were created for each session.
 *
 * Usage: npx tsx test/simulate/stress.ts
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { runSimulation } from "./runner.js";
import type { RunResult } from "./types.js";

const SESSIONS = 5;
const ERROR_RATE = 0.1;

async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isFile()) {
        const s = await stat(fullPath);
        totalSize += s.size;
      } else if (entry.isDirectory()) {
        totalSize += await getDirectorySize(fullPath);
      }
    }
  } catch {
    // directory might not exist
  }
  return totalSize;
}

async function verifyLogFiles(results: RunResult[]): Promise<{
  totalLogFiles: number;
  missingLogs: string[];
}> {
  let totalLogFiles = 0;
  const missingLogs: string[] = [];

  for (const r of results) {
    try {
      const files = await readdir(r.logDir);
      const logFiles = files.filter((f) => f.endsWith(".jsonl"));
      if (logFiles.length === 0) {
        missingLogs.push(`${r.scenario} session ${r.session}: no .jsonl files in ${r.logDir}`);
      } else {
        totalLogFiles += logFiles.length;
      }
    } catch {
      missingLogs.push(`${r.scenario} session ${r.session}: log dir not found: ${r.logDir}`);
    }
  }

  return { totalLogFiles, missingLogs };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
  const startTime = Date.now();

  process.stderr.write(
    `[stress] Starting stress test: ${SESSIONS} sessions, all scenarios, error-rate ${ERROR_RATE}\n`,
  );

  const results = await runSimulation({
    pd: false,
    sessions: SESSIONS,
    scenarios: "all",
    errorRate: ERROR_RATE,
    quiet: true,
  });

  const totalDuration = Date.now() - startTime;

  // Aggregate stats
  const totalCalls = results.reduce((s, r) => s + r.totalCalls, 0);
  const totalOk = results.reduce((s, r) => s + r.successfulCalls, 0);
  const totalFail = results.reduce((s, r) => s + r.failedCalls, 0);
  const totalSessions = results.length;

  // Check log files
  const { totalLogFiles, missingLogs } = await verifyLogFiles(results);

  // Calculate total log directory size
  let totalLogSize = 0;
  for (const r of results) {
    totalLogSize += await getDirectorySize(r.logDir);
  }

  // Print report
  process.stdout.write("\n=== Stress Test Report ===\n\n");
  process.stdout.write(`Sessions:       ${totalSessions}\n`);
  process.stdout.write(`Total calls:    ${totalCalls}\n`);
  process.stdout.write(`Succeeded:      ${totalOk}\n`);
  process.stdout.write(`Failed:         ${totalFail}\n`);
  process.stdout.write(
    `Success rate:   ${totalCalls > 0 ? ((totalOk / totalCalls) * 100).toFixed(1) : 0}%\n`,
  );
  process.stdout.write(`Total duration: ${totalDuration}ms\n`);
  process.stdout.write(`Log files:      ${totalLogFiles}\n`);
  process.stdout.write(`Log size:       ${formatBytes(totalLogSize)}\n`);

  if (missingLogs.length > 0) {
    process.stdout.write(`\nMissing logs (${missingLogs.length}):\n`);
    for (const msg of missingLogs) {
      process.stdout.write(`  - ${msg}\n`);
    }
  } else {
    process.stdout.write(`\nAll ${totalSessions} sessions produced log files.\n`);
  }

  // Per-scenario breakdown
  process.stdout.write("\n--- Per-Scenario Breakdown ---\n");
  const byScenario = new Map<string, RunResult[]>();
  for (const r of results) {
    const existing = byScenario.get(r.scenario) ?? [];
    existing.push(r);
    byScenario.set(r.scenario, existing);
  }

  for (const [name, scenarioResults] of byScenario) {
    const calls = scenarioResults.reduce((s, r) => s + r.totalCalls, 0);
    const ok = scenarioResults.reduce((s, r) => s + r.successfulCalls, 0);
    const fail = scenarioResults.reduce((s, r) => s + r.failedCalls, 0);
    const avgDuration = Math.round(
      scenarioResults.reduce((s, r) => s + r.durationMs, 0) / scenarioResults.length,
    );
    process.stdout.write(
      `  ${name}: ${ok}/${calls} ok, ${fail} errors, avg ${avgDuration}ms/session\n`,
    );
  }

  process.stdout.write("\n");

  if (missingLogs.length > 0) {
    process.stdout.write("WARN: Some sessions did not produce log files.\n");
    process.exit(1);
  }

  process.stdout.write("Stress test completed successfully.\n");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(
    `[stress] Fatal: ${err instanceof Error ? err.message : err}\n`,
  );
  process.exit(1);
});
