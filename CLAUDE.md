# CLAUDE.md — AI Assistant Guide for Flight

This file provides context for AI assistants (Claude Code, etc.) working on the
**Flight** codebase.

---

## Project Overview

**Flight** is a transparent MCP (Model Context Protocol) proxy and research
instrument for AI coding agents. It intercepts and logs tool calls between
Claude Code (or any MCP client) and upstream MCP servers, producing structured
JSONL session logs that enable researchers to analyze agent behavior,
hallucination patterns, and tool-use reliability.

Key capabilities:
- Zero-overhead STDIO proxy with <5 ms latency, 40k+ calls/sec throughput
- Append-only session logs at `~/.flight/logs/session_*.jsonl`
- Hallucination-hint detection (agent proceeds after tool error without retry)
- Auto-retry logic for read-only tools on transient failures
- `flight log` CLI for inspecting and filtering recorded sessions
- `flight init` to wrap existing MCP server configs non-destructively

---

## Repository Structure

```
flight/
├── src/
│   ├── cli.ts           # Commander.js CLI entry (proxy / init / log subcommands)
│   ├── proxy.ts         # Core STDIO proxy — spawns server, intercepts streams
│   ├── logger.ts        # JSONL session logger, hallucination-hint detection
│   ├── json-rpc.ts      # JSON-RPC 2.0 NDJSON parser and type guards
│   ├── log-commands.ts  # log subcommand implementations (list/tail/view/filter/inspect/alerts)
│   ├── init.ts          # Config discovery and wrapping for Claude / Claude Code
│   └── index.ts         # Public library exports
├── test/
│   ├── logger.test.ts
│   ├── json-rpc.test.ts
│   ├── log-commands.test.ts
│   ├── alerts.test.ts
│   ├── init.test.ts
│   ├── redaction.test.ts
│   ├── integration.test.ts
│   ├── benchmark.test.ts
│   └── mock-mcp-server.ts   # Test fixture MCP server
├── bench/
│   └── throughput.ts        # Performance benchmark (spawn-based)
├── docs/
│   ├── flight-prd.md        # Product requirements document
│   ├── plan.md              # Sprint plan and roadmap
│   └── CHANGELOG.md
├── .github/workflows/
│   ├── ci.yml               # PR/push: lint → typecheck → test → build (Node 20 & 22)
│   └── release.yml          # Publish to npm on git tags matching v*
├── tsup.config.ts           # Build: dual ESM output (CLI executable + library)
├── vitest.config.ts         # Test runner config (globals, 10s timeout)
├── eslint.config.js         # ESLint flat config (TypeScript + recommended rules)
└── tsconfig.json            # Strict TypeScript (ES2022, bundler resolution)
```

---

## Development Commands

```bash
# Install dependencies
npm install

# Build (compiles to dist/)
npm run build

# Watch mode during development
npm run dev

# Run tests once
npm test

# Run tests in watch mode
npm run test:watch

# Lint source files
npm run lint

# Type-check (src + tests)
npm run typecheck

# Full validation (lint + typecheck + test) — run before committing
npm run check

# Performance benchmark
npm run bench
```

Run `npm run check` before every commit to ensure lint, types, and tests all
pass.

```bash
# Run a single test file
npx vitest run test/logger.test.ts

# Run tests matching a name pattern
npx vitest run --reporter=verbose -t "hallucination"
```

---

## Architecture and Key Design Decisions

### STDIO Proxy (`src/proxy.ts`)

The proxy sits between the MCP client (stdin/stdout) and the upstream server
process it spawns. Message flow:

```
MCP client  →  proxy stdin  →  upstream server stdin
MCP client  ←  proxy stdout ←  upstream server stdout
```

Key behaviors:
- **Pending request map**: tracks in-flight JSON-RPC requests to correlate
  responses for latency calculation.
- **Auto-retry**: on error responses for read-only tools, the proxy holds back
  the error, waits 500 ms, and replays the original request once. Disable with
  `ProxyOptions.noRetry = true`. Retryable tool set (`SAFE_RETRY_NAMES`):
  `read_file`, `read`, `get_file_contents`, `list_dir`, `list_directory`, `ls`,
  `search`, `grep`, `find_files`. Any tool whose name starts with `get_`
  (`SAFE_RETRY_PREFIXES`) is also retryable. Permanent error codes
  (`-32601`, `-32602`, `-32600`) are never retried.
- **Backpressure-safe logging**: log writes are queued and never block the proxy
  pipe.
- **Graceful shutdown**: listens for `SIGINT`/`SIGTERM` to drain the write queue
  before exiting.

### Session Logger (`src/logger.ts`)

Writes structured `LogEntry` objects to `~/.flight/logs/session_<ts>.jsonl`.

Important constants:
| Constant | Value | Purpose |
|---|---|---|
| `MAX_QUEUE_DEPTH` | 1000 | Max buffered log entries before dropping |
| `FLUSH_INTERVAL_MS` | 100 ms | Write-batch interval |
| `MIN_DISK_SPACE_BYTES` | 100 MB | Disable logging below this threshold |
| `MAX_LOG_SIZE_BYTES` | 50 MB | Per-session log size cap |
| `HALLUCINATION_WINDOW_MS` | 30 000 ms | Window for detecting error-then-proceed patterns |
| `MAX_RECENT_RESPONSES` | 10 | Sliding window of responses checked for hallucinations |

**Hallucination-hint detection**: when an agent receives a tool error and then
sends another tool call (to a different tool) within 30 seconds without first
retrying the failed tool, an `AlertEntry` is appended to
`~/.flight/alerts.jsonl`.

**Secret redaction**: before writing, log entries are scrubbed against a list of
environment variable names and user-supplied regex patterns.

### JSON-RPC Layer (`src/json-rpc.ts`)

Parses NDJSON streams into typed `JsonRpcMessage` objects. Utility type guards:
- `isRequest(msg)` — has `method` + `id`
- `isResponse(msg)` — has `result` or `error` + `id`
- `isNotification(msg)` — has `method`, no `id`
- `extractToolName(msg)` — returns tool name from a `tools/call` request

### CLI (`src/cli.ts`)

Built with Commander.js. Three top-level subcommands:

| Command | Purpose |
|---|---|
| `flight proxy --cmd <server> -- [args]` | Start proxy wrapping an upstream server |
| `flight init <target> --apply` | Wrap Claude/Claude Code config to route through flight |
| `flight log <subcommand>` | Inspect recorded sessions |

`flight log` subcommands: `list`, `tail`, `view`, `filter`, `inspect`, `alerts`.

### Init (`src/init.ts`)

Discovers existing MCP server configurations in platform-specific config
directories, backs them up (`.bak` files), and rewrites them to route each
server through the `flight proxy` wrapper. Supports Claude Desktop and Claude
Code config formats.

---

## Code Conventions

### TypeScript

- **Strict mode** is enabled — no implicit `any`, always handle nulls.
- Use `ES2022` features freely; the build target is Node 20+.
- All source is ES modules (`"type": "module"` in package.json).
- Prefer `async`/`await` over raw Promises or callbacks.

### Naming

| Kind | Convention | Example |
|---|---|---|
| Interfaces / Types | PascalCase | `ProxyOptions`, `LogEntry`, `AlertEntry` |
| Functions / variables | camelCase | `createSessionLogger`, `parseJsonRpcStream` |
| Constants | UPPER_SNAKE_CASE | `MAX_QUEUE_DEPTH`, `MIN_DISK_SPACE_BYTES` |
| Files | kebab-case | `json-rpc.ts`, `log-commands.ts` |

### Error Handling

- Wrap file I/O in `try/catch`; degrade gracefully (e.g., disable logging on
  disk-space errors) rather than crashing the proxy.
- Alert writes are fire-and-forget — do not `await` them on the hot path.
- Never swallow errors silently; log to `console.error` or the alert system.
- Use standard JSON-RPC error codes: `-32601` (method not found), `-32000`
  (generic server error).

### Dependencies

The project intentionally has **one runtime dependency** (`commander`). Keep it
that way — do not add npm packages unless absolutely necessary. Prefer Node.js
stdlib (`fs`, `path`, `os`, `readline`, `child_process`, `stream`).

### Testing

- Test framework: **Vitest** (`describe`/`it`/`expect`, globals enabled).
- Create temp directories per test using `os.tmpdir()` + unique suffixes;
  clean up in `afterEach`.
- Use `mock-mcp-server.ts` for integration tests that need a live server.
- Benchmarks belong in `bench/` or `benchmark.test.ts`; assert throughput and
  latency thresholds.
- Test files mirror source: `src/foo.ts` → `test/foo.test.ts`.

---

## CI/CD

### Continuous Integration (`ci.yml`)

Runs on every push and pull request to `main`:
1. `npm run lint`
2. `npm run typecheck`
3. `npm test`
4. `npm run build`

Tested on **Node.js 20.x and 22.x** in a matrix.

### Release (`release.yml`)

Triggered by git tags matching `v*` (e.g., `v0.2.0`):
1. Full `npm run check` suite
2. `npm publish` with `NPM_TOKEN` secret
3. GitHub release created with auto-generated notes

To release a new version: bump `version` in `package.json`, commit, then
`git tag v<version> && git push --tags`.

---

## Log File Format

Session logs are newline-delimited JSON (JSONL). Each line is a `LogEntry`:

```jsonc
{
  "session_id": "session_20240115_102345_a1b2c3d4",
  "call_id": "1",                              // request id, or UUID for notifications
  "timestamp": "2024-01-15T10:23:45.123Z",
  "latency_ms": 42,                            // 0 for client→server entries
  "direction": "client->server",               // or "server->client"
  "method": "tools/call",                      // JSON-RPC method; "response" for bare responses
  "tool_name": "read_file",                    // present for tools/call messages
  "payload": { /* raw JSON-RPC message */ },
  "error": "file not found",                   // present when msg.error is set
  "hallucination_hint": true,                  // present (true) when hint detected
  "pd_active": false                           // pattern-detection flag (reserved, always false)
}
```

Alert entries in `~/.flight/alerts.jsonl`:

```jsonc
{
  "timestamp": "2024-01-15T10:23:45.123Z",
  "severity": "hallucination",               // "error" | "hallucination"
  "method": "tools/call",
  "tool_name": "read_file",                  // present for tool calls
  "message": "Agent proceeded after error on read_file without retrying",
  "session_id": "session_20240115_102345_a1b2c3d4",
  "call_id": "3"
}
```

---

## Common Tasks

### Add a new CLI subcommand

1. Implement the handler in `src/log-commands.ts` (or a new file if substantial).
2. Register it in `src/cli.ts` using Commander's `.command()` / `.action()`.
3. Export any new public types from `src/index.ts`.
4. Add tests in `test/`.

### Modify retry logic

Edit `src/proxy.ts` — look for `SAFE_RETRY_NAMES`, `SAFE_RETRY_PREFIXES`, and
`PERMANENT_ERROR_CODES`. The retry delay is 500 ms (hardcoded `setTimeout`).
Disable retries entirely via `ProxyOptions.noRetry`. Update tests in
`test/integration.test.ts`.

### Add a new log entry type

1. Define the type in `src/logger.ts`.
2. Update `src/index.ts` to export it.
3. Handle it in `src/log-commands.ts` display functions.

### Change hallucination detection behavior

Edit the `HALLUCINATION_WINDOW_MS` constant and detection logic in
`src/logger.ts`. Update `test/alerts.test.ts`.

---

## Known Limitations (v0.1)

- HTTP/SSE transport not yet supported — STDIO only.
- No multi-session aggregation or dashboard (planned for v1.0).
- Secret redaction is best-effort; review logs before sharing.
- Windows path support in `init.ts` is present but less tested than
  macOS/Linux.
