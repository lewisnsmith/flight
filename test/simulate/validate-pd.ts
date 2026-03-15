#!/usr/bin/env npx tsx
/**
 * PD Validation Script (Task 8c)
 *
 * Runs all scenarios twice — once with PD enabled, once with PD disabled —
 * then compares success rates, token savings, and prints a go/no-go recommendation.
 *
 * Usage: npx tsx test/simulate/validate-pd.ts
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runSimulation } from "./runner.js";
import type { RunResult } from "./types.js";

interface PDComparison {
  scenario: string;
  passthroughRate: number;
  pdRate: number;
  rateDiff: number;
  passthroughCalls: number;
  pdCalls: number;
  passthroughErrors: number;
  pdErrors: number;
  schemaTokensSaved: number;
  pdActive: boolean;
}

async function extractLogMetrics(
  logDir: string,
): Promise<{ schemaTokensSaved: number; pdActive: boolean }> {
  let schemaTokensSaved = 0;
  let pdActive = false;

  try {
    const files = await readdir(logDir);
    const logFile = files.find((f) => f.endsWith(".jsonl"));
    if (!logFile) return { schemaTokensSaved, pdActive };

    const content = await readFile(join(logDir, logFile), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (typeof entry.schema_tokens_saved === "number") {
          schemaTokensSaved = entry.schema_tokens_saved;
        }
        if (entry.pd_active === true) {
          pdActive = true;
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // log directory may not exist or be empty
  }

  return { schemaTokensSaved, pdActive };
}

function printComparisonTable(comparisons: PDComparison[]): void {
  const header = [
    "Scenario".padEnd(28),
    "PT Rate".padStart(8),
    "PD Rate".padStart(8),
    "Diff".padStart(7),
    "PT Err".padStart(7),
    "PD Err".padStart(7),
    "Tokens Saved".padStart(13),
    "PD Active".padStart(10),
  ].join(" | ");

  const separator = "-".repeat(header.length);

  process.stdout.write("\n=== PD Validation Report ===\n\n");
  process.stdout.write(separator + "\n");
  process.stdout.write(header + "\n");
  process.stdout.write(separator + "\n");

  for (const c of comparisons) {
    const row = [
      c.scenario.padEnd(28),
      `${(c.passthroughRate * 100).toFixed(1)}%`.padStart(8),
      `${(c.pdRate * 100).toFixed(1)}%`.padStart(8),
      `${(c.rateDiff * 100).toFixed(1)}%`.padStart(7),
      String(c.passthroughErrors).padStart(7),
      String(c.pdErrors).padStart(7),
      String(c.schemaTokensSaved).padStart(13),
      (c.pdActive ? "yes" : "no").padStart(10),
    ].join(" | ");
    process.stdout.write(row + "\n");
  }

  process.stdout.write(separator + "\n");
}

async function main() {
  process.stderr.write("[validate-pd] Running all scenarios with PD OFF...\n");
  const passthroughResults = await runSimulation({
    pd: false,
    sessions: 1,
    scenarios: "all",
    errorRate: 0,
    quiet: true,
  });

  process.stderr.write("[validate-pd] Running all scenarios with PD ON...\n");
  const pdResults = await runSimulation({
    pd: true,
    sessions: 1,
    scenarios: "all",
    errorRate: 0,
    quiet: true,
  });

  // Build comparison data
  const comparisons: PDComparison[] = [];
  let hasNoGo = false;

  for (let i = 0; i < passthroughResults.length; i++) {
    const pt = passthroughResults[i];
    const pd = pdResults[i];

    if (!pt || !pd) continue;

    const ptRate = pt.totalCalls > 0 ? pt.successfulCalls / pt.totalCalls : 0;
    const pdRate = pd.totalCalls > 0 ? pd.successfulCalls / pd.totalCalls : 0;
    const rateDiff = pdRate - ptRate;

    // Extract log-level PD metrics
    const pdMetrics = await extractLogMetrics(pd.logDir);

    comparisons.push({
      scenario: pt.scenario,
      passthroughRate: ptRate,
      pdRate: pdRate,
      rateDiff,
      passthroughCalls: pt.totalCalls,
      pdCalls: pd.totalCalls,
      passthroughErrors: pt.failedCalls,
      pdErrors: pd.failedCalls,
      schemaTokensSaved: pdMetrics.schemaTokensSaved,
      pdActive: pdMetrics.pdActive,
    });

    // Check go/no-go threshold: PD success rate must not drop more than 20%
    if (rateDiff < -0.20) {
      hasNoGo = true;
    }
  }

  printComparisonTable(comparisons);

  // Aggregate summary
  const totalPtOk = passthroughResults.reduce((s, r) => s + r.successfulCalls, 0);
  const totalPtAll = passthroughResults.reduce((s, r) => s + r.totalCalls, 0);
  const totalPdOk = pdResults.reduce((s, r) => s + r.successfulCalls, 0);
  const totalPdAll = pdResults.reduce((s, r) => s + r.totalCalls, 0);
  const totalTokensSaved = comparisons.reduce((s, c) => s + c.schemaTokensSaved, 0);

  process.stdout.write("\n--- Aggregate ---\n");
  process.stdout.write(
    `Passthrough: ${totalPtOk}/${totalPtAll} succeeded (${((totalPtOk / totalPtAll) * 100).toFixed(1)}%)\n`,
  );
  process.stdout.write(
    `PD:          ${totalPdOk}/${totalPdAll} succeeded (${((totalPdOk / totalPdAll) * 100).toFixed(1)}%)\n`,
  );
  process.stdout.write(`Total schema tokens saved: ${totalTokensSaved}\n`);

  // Go/No-Go decision
  process.stdout.write("\n");
  if (hasNoGo) {
    process.stdout.write(
      "*** NO-GO *** PD success rate dropped more than 20% compared to passthrough in one or more scenarios.\n",
    );
    process.exit(1);
  } else {
    process.stdout.write(
      "GO: PD success rate is within acceptable range across all scenarios.\n",
    );
    process.exit(0);
  }
}

main().catch((err) => {
  process.stderr.write(
    `[validate-pd] Fatal: ${err instanceof Error ? err.message : err}\n`,
  );
  process.exit(1);
});
