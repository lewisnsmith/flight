export interface ScenarioStep {
  /** Tool to call */
  tool: string;
  /** Arguments for the tool */
  args: Record<string, unknown>;
  /** Expected: should this call succeed? (for validation) */
  expectSuccess?: boolean;
  /** Delay in ms before this step */
  delayMs?: number;
  /** Description of what this step simulates */
  description?: string;
}

export interface Scenario {
  name: string;
  description: string;
  /** Which mock server to use: "fs", "git", "web" */
  server: "fs" | "git" | "web";
  steps: ScenarioStep[];
}

export interface RunOptions {
  pd: boolean;
  sessions: number;
  scenarios: string[] | "all";
  errorRate: number;
  logDir?: string;
  quiet?: boolean;
}

export interface RunResult {
  scenario: string;
  session: number;
  pd: boolean;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  durationMs: number;
  logDir: string;
}
