# Flight — Agent Observability Platform

## What This Is

An agent observability platform that provides structured tracing, audit, and replay for AI agent systems. Flight supports multiple ingestion paths: TypeScript SDK (direct file I/O), Python SDK (HTTP client), HTTP collector, MCP stdio proxy, and Claude Code hooks. All paths write to the same JSONL format at `~/.flight/logs/`.

```
Agents (TS SDK, Python SDK, HTTP, MCP Proxy, Hooks)
                    ↓
              ~/.flight/logs/  (session JSONL + alerts)
```

## Stack

TypeScript, Node 20+, ESM modules, Vitest, tsup, Commander
Python SDK: stdlib only (no external deps), Python 3.9+

## Project Structure

```
src/
  cli.ts               — Commander CLI (subcommands: serve, proxy, log, claude, hook)
  proxy.ts             — stdio proxy: spawn upstream, bidirectional JSON-RPC forwarding
  json-rpc.ts          — streaming JSON-RPC parser (readline + JSON.parse per line)
  logger.ts            — session logger with async write queue and alert detection
  sdk.ts               — TypeScript SDK: createFlightClient() for programmatic logging
  collector.ts         — HTTP collector server (flight serve)
  progressive-disclosure.ts — PD handler: phase logic, usage tracking, tool filtering
  pd-schema.ts         — pure schema compression utilities
  file-lock.ts         — advisory file locking (O_CREAT|O_EXCL)
  retry.ts             — automatic retry manager for transient MCP errors
  hooks.ts             — Claude Code hook installation/removal (SessionStart/End, PostToolUse)
  init.ts              — Claude/Claude Code config file management (wraps mcpServers)
  setup.ts             — interactive setup wizard (wraps servers + installs hooks)
  shared.ts            — shared constants (DEFAULT_LOG_DIR, C colors, McpServerEntry type)
  summary.ts           — session summary computation
  stats.ts             — usage statistics
  lifecycle.ts         — log compression and garbage collection
  export.ts            — CSV/JSONL export
  replay.ts            — tool call replay from logs
  log-commands.ts      — CLI subcommands for log inspection (list, tail, view, filter, inspect, audit, verbose)
  index.ts             — public API re-exports

sdk/python/
  flight_sdk/
    __init__.py        — Package exports (FlightClient, LogEntry, ModelConfig)
    client.py          — Buffered HTTP client for flight serve
    types.py           — LogEntry, ModelConfig dataclasses
  tests/
    test_client.py     — Integration tests (starts flight serve, posts events, verifies JSONL)
  pyproject.toml       — Package config (flight-sdk, Python 3.9+)
```

## CLI Structure

```bash
# Top-level commands
flight serve [--port 4242] [--log-dir]   # HTTP collector
flight proxy --cmd <server> -- <args>     # MCP stdio proxy

# Log commands
flight log list|tail|view|filter|inspect|alerts|summary|tools|audit|verbose
flight log stats|export|replay|gc|prune

# Claude Code integration
flight claude setup                       # Interactive wizard
flight claude hooks install|remove        # Hook management
flight claude init desktop|code           # MCP server wrapping

# Internal (used by hooks)
flight hook session-start|session-end|post-tool-use
```

Old command paths (`flight setup`, `flight hooks`, `flight init`, `flight stats`, `flight export`, `flight replay`) are deprecated aliases that print a warning and delegate.

## Log Schema

Required fields: `session_id`, `timestamp`, `event_type`
Event types: `tool_call`, `tool_result`, `agent_action`, `evaluation`, `lifecycle`
Optional fields: `run_id`, `agent_id`, `model_config`, `chosen_action`, `execution_outcome`, `evaluator_score`, `labels`, `metadata`, `call_id`, `direction`, `method`, `tool_name`, `payload`, `error`, `latency_ms`, `hallucination_hint`, `pd_active`, `schema_tokens_saved`

## Claude Code Integration

### Hooks (always active)
Installed in `~/.claude/settings.json` by `flight claude setup`:
- **SessionStart** → `flight hook session-start` — creates active session marker
- **SessionEnd** → `flight hook session-end` — outputs summary, triggers compression/GC
- **PostToolUse** → `flight hook post-tool-use` — logs tool calls to `<session>_tools.jsonl`

### MCP Proxy Wrapping (optional)
`flight claude init code --apply` rewrites `~/.claude.json` mcpServers.

### Slash Commands
Installed in `~/.claude/commands/` by `flight claude setup`:
- **`/flight`** — quick session audit (runs `flight log audit`)
- **`/flight-log`** — comprehensive view (runs `flight log verbose`)

### Data Locations
- `~/.flight/logs/session_*.jsonl` — session recordings
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

Python SDK tests: `cd sdk/python && python3 -m pytest tests/ -v`

## Key Patterns

- **Handler result objects** — `PDResponseResult` carries rewritten responses, log metadata, and status messages in one return value.
- **Async write queue** — Logger batches writes with a flush timer; `closeSync()` drains synchronously for signal handlers.
- **SDK wraps logger** — `createFlightClient()` constructs synthetic JSON-RPC messages and delegates to `createSessionLogger`.
- **HTTP collector** — `startCollector()` uses Node built-in `http.createServer`, validates entries, batches writes per session.
- **Python SDK buffering** — entries buffer in memory, flush every 1s or 100 entries via `urllib.request` POST to `/ingest`.
- **JSON-RPC streaming** — `parseJsonRpcStream` is a newline-delimited JSON parser on Node readable streams.
- **Progressive disclosure** — Phase 1 (observation), Phase 2 (schema compression), Phase 3 (compression + filtering).
- **Alert detection** — Hallucination hints (different tool called after error), loop detection (same tool 5x in 60s).

## Testing

- Tests live in `test/` alongside source
- Mock MCP server pattern: spawn a test server, connect via proxy, assert on JSON-RPC messages
- `test/simulate/` contains validation harnesses for Claude API compatibility
- `sdk/python/tests/` — Python integration tests (require built CLI for `flight serve`)
- Run `npm run test` — all tests should pass before any PR

## Git Conventions

- Commit format: `<type>: <description>` (feat, fix, refactor, docs, test, chore)
- Messages explain WHY, not what
- One logical change per commit

See [ARCHITECTURE.md](ARCHITECTURE.md) for deeper design details.
