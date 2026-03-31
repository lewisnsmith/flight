import type { LogEntry } from "./logger.js";
import { C } from "./shared.js";

export interface SessionSummary {
  sessionId: string;
  totalCalls: number;
  errors: number;
  hallucinationHints: number;
  topTools: Array<{ name: string; count: number }>;
  durationMs: number;
  timeline: string;
}

export function computeSummary(entries: LogEntry[]): SessionSummary {
  const sessionId = entries[0]?.session_id ?? "unknown";
  const errors = entries.filter((e) => e.error).length;
  const hallucinationHints = entries.filter((e) => e.hallucination_hint).length;

  const toolCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.tool_name) {
      toolCounts.set(entry.tool_name, (toolCounts.get(entry.tool_name) ?? 0) + 1);
    }
  }
  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  let durationMs = 0;
  if (entries.length >= 2) {
    const first = new Date(entries[0].timestamp).getTime();
    const last = new Date(entries[entries.length - 1].timestamp).getTime();
    durationMs = last - first;
  }

  const responses = entries.filter((e) => e.direction === "server->client");
  const timelineChars: string[] = [];
  for (const r of responses) {
    if (r.hallucination_hint) {
      timelineChars.push("!");
    } else if (r.error) {
      timelineChars.push("x");
    } else {
      timelineChars.push("=");
    }
  }

  let timeline = timelineChars.join("");
  if (timeline.length > 50) {
    const ratio = Math.ceil(timeline.length / 50);
    const compressed: string[] = [];
    for (let i = 0; i < timeline.length; i += ratio) {
      const chunk = timeline.slice(i, i + ratio);
      if (chunk.includes("!")) compressed.push("!");
      else if (chunk.includes("x")) compressed.push("x");
      else compressed.push("=");
    }
    timeline = compressed.join("");
  }
  timeline = `[${timeline}]`;

  return {
    sessionId,
    totalCalls: entries.length,
    errors,
    hallucinationHints,
    topTools,
    durationMs,
    timeline,
  };
}

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}


export function formatSummary(summary: SessionSummary): string {
  const lines: string[] = [];
  lines.push(`${C.cyan}Session:${C.reset} ${summary.sessionId} (${formatDuration(summary.durationMs)})`);
  lines.push(`  Calls: ${summary.totalCalls}  |  Errors: ${summary.errors > 0 ? C.red + summary.errors + C.reset : "0"}  |  Hallucination hints: ${summary.hallucinationHints > 0 ? C.yellow + summary.hallucinationHints + C.reset : "0"}`);

  if (summary.topTools.length > 0) {
    const toolStr = summary.topTools.map((t) => `${t.name} (${t.count})`).join(", ");
    lines.push(`  Top tools: ${toolStr}`);
  }

  lines.push(`  Timeline: ${summary.timeline}`);
  lines.push(`${C.dim}            x = error, ! = hallucination hint${C.reset}`);

  return lines.join("\n");
}
