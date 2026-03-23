# Flight — MCP Flight Recorder & Token Optimizer

## What This Is

A transparent stdio proxy that sits between Claude Code (MCP client) and MCP servers. It records all JSON-RPC traffic, detects hallucination patterns, and optionally compresses tool schemas to save tokens. Installed globally via `npm link`, activated via Claude Code hooks.

```
Claude Code ─→ Flight Proxy ─→ MCP Server
                  ↓
            ~/.flight/logs/  (session JSONL + alerts)
```

## Stack

TypeScript, Node 20+, ESM modules, Vitest, tsup, Commander

## Project Structure

```
src/
  cli.ts               — Commander CLI entry point (subcommands: init, proxy, log, setup, hooks)
  proxy.ts             — stdio proxy: spawn upstream, bidirectional JSON-RPC forwarding
  json-rpc.ts          — streaming JSON-RPC parser (readline + JSON.parse per line)
  logger.ts            — session logger with async write queue and alert detection
  progressive-disclosure.ts — PD handler: phase logic, usage tracking, tool filtering
  pd-schema.ts         — pure schema compression utilities
  file-lock.ts         — advisory file locking (O_CREAT|O_EXCL)
  retry.ts             — automatic retry manager for transient MCP errors
  hooks.ts             — Claude Code hook installation/removal (SessionStart/End, PostToolUse)
  init.ts              — Claude/Claude Code config file management (wraps mcpServers)
  setup.ts             — interactive setup wizard (wraps servers + installs hooks)
  summary.ts           — session summary computation
  stats.ts             — usage statistics
  lifecycle.ts         — log compression and garbage collection
  export.ts            — CSV/JSONL export
  replay.ts            — tool call replay from logs
  log-commands.ts      — CLI subcommands for log inspection (list, tail, view, filter, inspect)
  index.ts             — public API re-exports
```

## Claude Code Integration

Flight integrates via two mechanisms:

### 1. Hooks (always active)
Installed in `~/.claude/settings.json` by `flight setup`:
- **SessionStart** → `flight hook session-start` — creates active session marker
- **SessionEnd** → `flight hook session-end` — outputs summary, triggers compression/GC
- **PostToolUse** → `flight hook post-tool-use` — logs tool calls to `<session>_tools.jsonl`

### 2. MCP Proxy Wrapping (optional, for full traffic recording)
`flight init claude-code --apply` rewrites `~/.claude.json` mcpServers:
```json
// Before: "command": "your-server", "args": ["--flag"]
// After:  "command": "flight", "args": ["proxy", "--cmd", "your-server", "--", "--flag"]
```
Only applies to user-configured MCP servers, not plugin-provided ones.

### Data Locations
- `~/.flight/logs/session_*.jsonl` — full JSON-RPC session recordings
- `~/.flight/logs/<session>_tools.jsonl` — tool call metadata from hooks
- `~/.flight/alerts.jsonl` — hallucination hints, loops, errors
- `~/.flight/usage/` — token usage statistics

## Commands

```bash
npm run build       # Build with tsup
npm run test        # Run tests (vitest)
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit (src + test)
npm run check       # lint + typecheck + test (use before committing)
```

## Key Patterns

- **Handler result objects** — `PDResponseResult` carries rewritten responses, log metadata, and status messages in one return value. Callers branch on fields, not exceptions.
- **Async write queue** — Logger batches writes with a flush timer; `closeSync()` drains synchronously for signal handlers.
- **File locking** — `acquireLock(path)` uses `O_CREAT|O_EXCL` with PID-based stale detection. Returns `""` on timeout (best-effort, never blocks).
- **JSON-RPC streaming** — `parseJsonRpcStream` is a newline-delimited JSON parser on Node readable streams, emitting typed `JsonRpcMessage` events.
- **Progressive disclosure phases** — Phase 1 (observation), Phase 2 (schema compression), Phase 3 (compression + filtering with `discover_tools`).
- **Signal handling** — SIGTERM/SIGINT: kill upstream, flush PD data, drain retry state, close logger. 5s safety timeout for sync fallback.
- **Alert detection** — Hallucination hints (different tool called after error), loop detection (same tool 5x in 60s), all error responses.

## Testing

- Tests live in `test/` alongside source
- Mock MCP server pattern: spawn a test server, connect via proxy, assert on JSON-RPC messages
- `test/simulate/` contains validation harnesses for Claude API compatibility
- Run `npm run test` — all tests should pass before any PR

## Git Conventions

- Commit format: `<type>: <description>` (feat, fix, refactor, docs, test, chore)
- Messages explain WHY, not what
- One logical change per commit

See [ARCHITECTURE.md](ARCHITECTURE.md) for deeper design details.
