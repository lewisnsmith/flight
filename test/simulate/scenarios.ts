import type { Scenario } from "./types.js";

/**
 * scenario-file-edit: Typical code editing flow.
 * list_directory → search_files → read_file → read_file → write_file → read_file (verify)
 */
const fileEdit: Scenario = {
  name: "scenario-file-edit",
  description: "Typical code editing workflow: browse, read, edit, verify",
  server: "fs",
  steps: [
    {
      tool: "list_directory",
      args: { path: "/src" },
      expectSuccess: true,
      description: "List source directory to find files",
    },
    {
      tool: "list_directory",
      args: { path: "/src/utils" },
      expectSuccess: true,
      description: "Drill into utils subdirectory",
    },
    {
      tool: "read_file",
      args: { path: "/src/utils/helpers.ts" },
      expectSuccess: true,
      description: "Read the target file to understand current code",
    },
    {
      tool: "read_file",
      args: { path: "/src/utils/types.ts" },
      expectSuccess: true,
      description: "Read related type definitions",
    },
    {
      tool: "write_file",
      args: { path: "/src/utils/helpers.ts", content: "// updated content\nexport function helper() { return true; }\n" },
      expectSuccess: true,
      description: "Write updated code to the file",
    },
    {
      tool: "read_file",
      args: { path: "/src/utils/helpers.ts" },
      expectSuccess: true,
      description: "Re-read file to verify the edit was applied",
    },
    {
      tool: "list_directory",
      args: { path: "/src/utils" },
      expectSuccess: true,
      description: "List directory again to confirm no extra files",
    },
    {
      tool: "read_file",
      args: { path: "/src/index.ts" },
      expectSuccess: true,
      description: "Read index to check imports are still valid",
    },
  ],
};

/**
 * scenario-debug: Investigation pattern with an error trigger and hallucination hint.
 */
const debug: Scenario = {
  name: "scenario-debug",
  description: "Debugging investigation with error trigger and hallucination hint",
  server: "fs",
  steps: [
    {
      tool: "read_file",
      args: { path: "/src/app.ts" },
      expectSuccess: true,
      description: "Read main app file to understand entry point",
    },
    {
      tool: "list_directory",
      args: { path: "/src/handlers" },
      expectSuccess: true,
      description: "Search for handler files",
    },
    {
      tool: "read_file",
      args: { path: "/src/handlers/auth.ts" },
      expectSuccess: true,
      description: "Read auth handler for the bug report",
    },
    {
      tool: "read_file",
      args: { path: "/src/handlers/session.ts" },
      expectSuccess: true,
      description: "Read session handler for related logic",
    },
    {
      tool: "list_directory",
      args: { path: "/src/middleware" },
      expectSuccess: true,
      description: "Search middleware directory for interceptors",
    },
    {
      tool: "read_file",
      args: { path: "/src/middleware/validate.ts" },
      expectSuccess: true,
      description: "Read validation middleware",
    },
    {
      tool: "read_file",
      args: { path: "/src/handlers/nonexistent-handler.ts" },
      expectSuccess: true,
      description: "Read a nonexistent file — error trigger (mock returns content regardless)",
    },
    {
      tool: "read_file",
      args: { path: "/src/handlers/user.ts" },
      expectSuccess: true,
      delayMs: 100,
      description: "Read a different file immediately after error — hallucination hint trigger",
    },
    {
      tool: "list_directory",
      args: { path: "/src" },
      expectSuccess: true,
      description: "Get file info to check timestamps",
    },
    {
      tool: "read_file",
      args: { path: "/src/config.ts" },
      expectSuccess: true,
      description: "Read config for environment-specific behavior",
    },
  ],
};

/**
 * scenario-git-workflow: Git operations workflow using git server tools.
 */
const gitWorkflow: Scenario = {
  name: "scenario-git-workflow",
  description: "Git workflow: status, diff, stage, commit, log",
  server: "git",
  steps: [
    {
      tool: "git_status",
      args: {},
      expectSuccess: true,
      description: "Check current git status",
    },
    {
      tool: "git_diff",
      args: { ref: "HEAD" },
      expectSuccess: true,
      description: "View diff against HEAD",
    },
    {
      tool: "git_log",
      args: { count: 5 },
      expectSuccess: true,
      description: "View recent commit history",
    },
    {
      tool: "git_add",
      args: { files: ["src/index.ts"] },
      expectSuccess: true,
      description: "Stage the changed file",
    },
    {
      tool: "git_diff",
      args: { ref: "HEAD~1" },
      expectSuccess: true,
      description: "Review changes since last commit",
    },
    {
      tool: "git_commit",
      args: { message: "fix: resolve null pointer in handler" },
      expectSuccess: true,
      description: "Commit the staged changes",
    },
    {
      tool: "git_log",
      args: { count: 3 },
      expectSuccess: true,
      description: "Verify the commit appears in log",
    },
    {
      tool: "git_status",
      args: {},
      expectSuccess: true,
      description: "Confirm working tree is clean",
    },
  ],
};

/**
 * scenario-error-recovery: Mix of error-triggering calls, retries, and loop detection.
 */
const errorRecovery: Scenario = {
  name: "scenario-error-recovery",
  description: "Error recovery patterns: permission errors, retries, and loop detection",
  server: "fs",
  steps: [
    {
      tool: "write_file",
      args: { path: "/readonly/config.json", content: "{}" },
      expectSuccess: false,
      description: "Write to readonly path — triggers permission error",
    },
    {
      tool: "read_file",
      args: { path: "/src/app.ts" },
      expectSuccess: true,
      description: "Recover by reading a valid file",
    },
    {
      tool: "write_file",
      args: { path: "/readonly/secrets.conf", content: "test" },
      expectSuccess: false,
      description: "Write to readonly path — triggers permission error",
    },
    {
      tool: "read_file",
      args: { path: "/src/index.ts" },
      expectSuccess: true,
      description: "Read a different file after error — hallucination hint",
    },
    {
      tool: "delete_file",
      args: { path: "/protected/secrets.env" },
      expectSuccess: false,
      description: "Delete protected file — triggers error",
    },
    {
      tool: "read_file",
      args: { path: "/src/loop-target.ts" },
      expectSuccess: true,
      description: "Loop detection trigger — call 1 of 5 identical reads",
    },
    {
      tool: "read_file",
      args: { path: "/src/loop-target.ts" },
      expectSuccess: true,
      description: "Loop detection trigger — call 2 of 5",
    },
    {
      tool: "read_file",
      args: { path: "/src/loop-target.ts" },
      expectSuccess: true,
      description: "Loop detection trigger — call 3 of 5",
    },
    {
      tool: "read_file",
      args: { path: "/src/loop-target.ts" },
      expectSuccess: true,
      description: "Loop detection trigger — call 4 of 5",
    },
    {
      tool: "read_file",
      args: { path: "/src/loop-target.ts" },
      expectSuccess: true,
      description: "Loop detection trigger — call 5 of 5 (should trigger loop alert)",
    },
  ],
};

/**
 * scenario-multi-tool: Diverse mix of tools for broad coverage across the fs server.
 */
const multiTool: Scenario = {
  name: "scenario-multi-tool",
  description: "Diverse tool usage for broad coverage across fs server capabilities",
  server: "fs",
  steps: [
    {
      tool: "list_directory",
      args: { path: "/" },
      expectSuccess: true,
      description: "List root directory",
    },
    {
      tool: "read_file",
      args: { path: "/README.md" },
      expectSuccess: true,
      description: "Read project readme",
    },
    {
      tool: "list_directory",
      args: { path: "/src" },
      expectSuccess: true,
      description: "List source directory",
    },
    {
      tool: "read_file",
      args: { path: "/src/index.ts" },
      expectSuccess: true,
      description: "Read main entry point",
    },
    {
      tool: "write_file",
      args: { path: "/src/new-feature.ts", content: "export const feature = true;\n" },
      expectSuccess: true,
      description: "Create a new feature file",
    },
    {
      tool: "read_file",
      args: { path: "/src/new-feature.ts" },
      expectSuccess: true,
      description: "Verify the new file was created",
    },
    {
      tool: "list_directory",
      args: { path: "/test" },
      expectSuccess: true,
      description: "List test directory",
    },
    {
      tool: "write_file",
      args: { path: "/test/new-feature.test.ts", content: "import { feature } from '../src/new-feature';\n" },
      expectSuccess: true,
      description: "Create a test file for the new feature",
    },
    {
      tool: "read_file",
      args: { path: "/package.json" },
      expectSuccess: true,
      description: "Read package.json for dependencies",
    },
    {
      tool: "read_file",
      args: { path: "/tsconfig.json" },
      expectSuccess: true,
      description: "Read TypeScript config",
    },
    {
      tool: "list_directory",
      args: { path: "/dist" },
      expectSuccess: true,
      description: "Check build output directory",
    },
    {
      tool: "read_file",
      args: { path: "/src/index.ts" },
      expectSuccess: true,
      description: "Re-read index to confirm no regressions",
    },
  ],
};

/** All scenarios in execution order */
export const scenarios: Scenario[] = [
  fileEdit,
  debug,
  gitWorkflow,
  errorRecovery,
  multiTool,
];

/** Lookup map by scenario name */
export const scenarioMap: Map<string, Scenario> = new Map(
  scenarios.map((s) => [s.name, s]),
);
