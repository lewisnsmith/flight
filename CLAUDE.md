# Flight — MCP Flight Recorder & Token Optimizer

## Stack

TypeScript, Node 20+, ESM modules, Vitest, tsup, Commander

## Project Structure

```
src/
  cli.ts               — Commander CLI entry point
  proxy.ts             — stdio proxy: spawn upstream, bidirectional JSON-RPC forwarding
  json-rpc.ts          — streaming JSON-RPC parser
  logger.ts            — session logger with async write queue and alert detection
  progressive-disclosure.ts — PD handler: phase logic, usage tracking, tool filtering
  pd-schema.ts         — pure schema compression utilities
  file-lock.ts         — advisory file locking (O_CREAT|O_EXCL)
  retry.ts             — automatic retry manager for transient MCP errors
  hooks.ts             — Claude Code hook installation/removal
  init.ts              — Claude/Claude Code config file management
  setup.ts             — interactive setup wizard
  summary.ts           — session summary computation
  stats.ts             — usage statistics
  lifecycle.ts         — log compression and garbage collection
  export.ts            — CSV/JSONL export
  replay.ts            — tool call replay from logs
  log-commands.ts      — CLI subcommands for log inspection
  index.ts             — public API re-exports
```

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
