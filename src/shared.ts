import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_LOG_DIR = join(homedir(), ".flight", "logs");

export const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",
} as const;

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
}
