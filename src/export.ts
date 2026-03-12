import type { LogEntry } from "./logger.js";

const CSV_COLUMNS = [
  "session_id", "call_id", "timestamp", "direction", "method",
  "tool_name", "latency_ms", "error", "hallucination_hint", "pd_active",
] as const;

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function entriesToCsv(entries: LogEntry[]): string {
  const header = CSV_COLUMNS.join(",");
  const rows = entries.map((entry) => {
    return CSV_COLUMNS.map((col) => {
      const val = entry[col as keyof LogEntry];
      if (val === undefined || val === null) return "";
      return escapeCsvField(String(val));
    }).join(",");
  });
  return [header, ...rows].join("\n") + "\n";
}

export interface JsonlOptions {
  includePayload?: boolean;
}

export function entriesToJsonl(entries: LogEntry[], options?: JsonlOptions): string {
  return entries.map((entry) => {
    const out: Record<string, unknown> = { ...entry };
    if (!options?.includePayload) {
      delete out.payload;
    }
    return JSON.stringify(out);
  }).join("\n") + "\n";
}
