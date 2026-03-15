# Changelog

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
