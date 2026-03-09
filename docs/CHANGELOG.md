# Changelog

## v0.1.1 — Bug Fixes

### Fixed: Session logs truncated on exit (close flush was fire-and-forget)

`close()` called `flush()` but never awaited it. Since `flush()` does async `appendFile`, the process could exit before the final batch wrote to disk — silently losing the tail of the session log.

- `close()` now returns `Promise<void>` and awaits `flush()`
- Added `closeSync()` using `writeFileSync` for signal handler paths (SIGTERM/SIGINT) where async isn't possible
- Updated all callers in `proxy.ts` to await `close()` or use `closeSync()` as appropriate

### Fixed: False hallucination hints under concurrent requests

The hallucination heuristic used single scalar variables (`lastResponseWasError`, `lastErrorMethod`, `lastErrorToolName`). If the client sent requests A and B concurrently, interleaved responses would corrupt the state — the next client request could falsely trigger a hallucination hint.

- Replaced scalar state with an ordered list of recent server responses (`recentResponses[]`)
- When a client request arrives, checks only the most recent server response for the error-then-different-tool pattern
- Correctly handles interleaved responses without false positives

### Fixed: Synchronous disk space check blocking startup

`createSessionLogger` used `execSync('df ...')` to check available disk space. On slow disks or network mounts this could add visible latency to proxy startup.

- Replaced `execSync` + shell `df` command with `fs.statfs()` (async, native Node.js API)
- Cross-platform: works on Windows unlike the previous `df`-based approach
- No shell spawning overhead
