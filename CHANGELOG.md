# Changelog

## 1.2.1

### Added
- Pixel art airplane banner printed as a header when any Flight CLI command runs
- `--no-banner` global flag to suppress the banner
- `FLIGHT_NO_BANNER=1` env var alternative for scripting/CI
- `printBanner()` exported from the public API for programmatic use
- Banner respects `NO_COLOR` and skips output on non-TTY streams

## 1.2.0

### Added
- `flight log audit` — rich audit view of tool calls for the current session (powers `/flight-log` slash command)
- `/flight-log` slash command installed by `flight setup`
- Active session marker (`~/.flight/logs/.active_session`) for hook-aware session resolution
- `mergeSessionUsage()` exported for programmatic usage tracking in progressive disclosure
- SIGTERM/SIGINT signal handlers hardened in proxy startup

### Changed
- Progressive disclosure phase logic refactored for clarity; `mergeSessionUsage` extracted as a pure function
- Updated package description to better reflect scope
- Improved README, ARCHITECTURE.md, and CLAUDE.md docs

## 1.0.0

### Core
- Transparent STDIO MCP proxy with <5ms overhead (4762 calls/sec)
- 100% JSON-RPC fidelity — zero behavior change to upstream servers
- Bidirectional streaming NDJSON parser with backpressure handling
- Auto-retry for read-only tools (500ms delay, single attempt)
- Graceful upstream crash recovery and signal handling

### Logging
- Async .jsonl session logger with write queue (max 1000 depth, 100ms flush)
- Full log schema: session_id, call_id, timestamp, latency_ms, direction, method, tool_name, payload, error, hallucination_hint, pd_active, schema_tokens_saved
- Per-session 50MB log cap, startup disk check (100MB minimum)
- Secret redaction: env var values and regex patterns stripped before writing

### Detection
- Hallucination hint detection: flags when client proceeds after error without retrying
- Loop detection: alerts after 5 identical calls within 60 seconds
- Alert system with severity levels (error, hallucination, loop) written to alerts.jsonl

### CLI Commands
- `flight proxy --cmd <command>` — start the proxy
- `flight init claude` / `flight init claude-code` — auto-configure MCP clients
- `flight setup` / `flight setup --remove` — zero-config setup with Claude Code hooks
- `flight log list|view|tail|filter|inspect|alerts|summary` — log inspection
- `flight log gc|prune` — log lifecycle management
- `flight export <session> --format csv|jsonl` — research export
- `flight replay <call-id> --cmd <server>` — call replay
- `flight stats [session]` — token metrics and tool breakdown

### Progressive Disclosure (Experimental)
- `--pd` flag replaces N tool schemas with 2 meta-tools (discover_tools + execute_tool)
- Token savings: ~2x (minimal schemas) to ~37x (50 verbose tools)
- Schema interception with automatic fallback to passthrough on failure
- Off by default — pending validation with real AI sessions

### Log Lifecycle
- Automatic compression of sessions older than 24 hours
- Garbage collection by session count and byte limit
- Pruning by date or keep count

### Testing
- 102 tests across 20 test files
- Fuzz testing (11 tests for parser resilience)
- Disk-full condition tests
- PD token reduction verification
- Integration tests with mock MCP server
- Performance benchmarks

### Simulation Framework
- 3 mock MCP servers (filesystem, git, web) with 10 tools each
- 5 scenario modules simulating realistic Claude-like workflows
- PD validation script with automated go/no-go decision
- Stress testing (25 sessions, 240 calls, error injection)
