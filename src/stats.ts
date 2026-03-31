import type { LogEntry } from "./logger.js";
import { C } from "./shared.js";

export interface SessionStats {
  sessionId: string;
  totalCalls: number;
  errors: number;
  pdActive: boolean;
  totalTokensSaved: number;
  toolBreakdown: Array<{ name: string; calls: number; tokensSaved: number }>;
}

export function computeStats(entries: LogEntry[]): SessionStats {
  const sessionId = entries[0]?.session_id ?? "unknown";
  const pdActive = entries.some((e) => e.pd_active);
  const errors = entries.filter((e) => e.error).length;

  let totalTokensSaved = 0;
  const toolMap = new Map<string, { calls: number; tokensSaved: number }>();

  for (const entry of entries) {
    if (entry.schema_tokens_saved) {
      totalTokensSaved += entry.schema_tokens_saved;
    }

    if (entry.tool_name) {
      const existing = toolMap.get(entry.tool_name) ?? { calls: 0, tokensSaved: 0 };
      existing.calls++;
      existing.tokensSaved += entry.schema_tokens_saved ?? 0;
      toolMap.set(entry.tool_name, existing);
    }
  }

  const toolBreakdown = [...toolMap.entries()]
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.tokensSaved - a.tokensSaved);

  return {
    sessionId,
    totalCalls: entries.length,
    errors,
    pdActive,
    totalTokensSaved,
    toolBreakdown,
  };
}


export function formatStats(stats: SessionStats): string {
  const lines: string[] = [];
  lines.push(`${C.cyan}Session:${C.reset} ${stats.sessionId}`);
  lines.push(`  Total calls: ${stats.totalCalls}  |  Errors: ${stats.errors}`);
  lines.push(`  PD active: ${stats.pdActive ? C.green + "yes" + C.reset : "no"}`);
  lines.push(`  Tokens saved: ~${stats.totalTokensSaved.toLocaleString()}`);

  if (stats.toolBreakdown.length > 0) {
    lines.push(`\n  ${C.dim}Tool breakdown:${C.reset}`);
    for (const tool of stats.toolBreakdown.slice(0, 10)) {
      lines.push(`    ${tool.name}: ${tool.calls} calls, ~${tool.tokensSaved} tokens saved`);
    }
  }

  return lines.join("\n");
}

export interface AggregateStats {
  sessionCount: number;
  totalCalls: number;
  totalErrors: number;
  totalTokensSaved: number;
  pdSessionCount: number;
}

export function computeAggregateStats(sessions: LogEntry[][]): AggregateStats {
  let totalCalls = 0;
  let totalErrors = 0;
  let totalTokensSaved = 0;
  let pdSessionCount = 0;

  for (const entries of sessions) {
    totalCalls += entries.length;
    totalErrors += entries.filter((e) => e.error).length;
    totalTokensSaved += entries.reduce((sum, e) => sum + (e.schema_tokens_saved ?? 0), 0);
    if (entries.some((e) => e.pd_active)) pdSessionCount++;
  }

  return { sessionCount: sessions.length, totalCalls, totalErrors, totalTokensSaved, pdSessionCount };
}

export function formatAggregateStats(stats: AggregateStats): string {
  const lines: string[] = [];
  lines.push(`${C.cyan}Aggregate stats${C.reset} (${stats.sessionCount} sessions)`);
  lines.push(`  Total calls: ${stats.totalCalls}  |  Errors: ${stats.totalErrors}`);
  lines.push(`  PD sessions: ${stats.pdSessionCount}/${stats.sessionCount}`);
  lines.push(`  Total tokens saved: ~${stats.totalTokensSaved.toLocaleString()}`);
  return lines.join("\n");
}
