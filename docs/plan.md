# Sprint Plan: Flight Proxy

**Approach:** MVP-first → publish to GitHub → continue to v1.0
**Stack:** Node.js 20+, TypeScript, Vitest, commander, pino, tsup
**Cadence:** Weekly sprints, large tasks (major deliverables)
**Builder:** Claude Code
**Specs:** Detailed requirements (performance budgets, log lifecycle, retention policies, architecture) live in `flight-prd.md`. This plan references the PRD — not duplicates it.

---

## MVP Scope (Sprints 1–3)

Ship a working MCP flight recorder to GitHub. No progressive disclosure, no TUI, no replay. Prove the core value: transparent proxy + structured logging + CLI inspection.

### Sprint 1: Project Scaffolding + Proxy Core

**Task 1: Initialize project and CI**
- TypeScript project with `tsup` build, `vitest` test runner, `commander` CLI
- `tsconfig.json`, `package.json` (name: `flight-proxy`, bin: `flight`), `.gitignore`, ESLint
- GitHub Actions CI: lint + type-check + test on push/PR, Node 20 + 22 matrix
- Release workflow stub: on tag push → build → npm publish
- First test passing (smoke test)

**Task 2: STDIO proxy core**
- Bidirectional STDIO pipe: `process.stdin → [intercept] → upstream.stdin` and reverse
- Spawn upstream process from CLI args: `flight proxy --cmd <command> -- <args>`
- Streaming NDJSON parser — forward first byte before log write completes
- Handle partial messages, chunked streams, upstream crashes, and clean exit
- Backpressure: pass-through (slow client → slow upstream reads, no unbounded buffers)
- Unit tests for JSON-RPC parser, integration test with mock MCP server

**Task 3: Structured logging system**
- Async `.jsonl` writer with dedicated write queue (max depth 1,000 — drop with warning on overflow, never block proxy)
- Log schema:
  ```typescript
  interface LogEntry {
    session_id: string;        // UUID per proxy invocation
    call_id: string;           // UUID per request/response pair
    timestamp: string;         // ISO 8601, ms precision
    latency_ms: number;        // Round-trip time
    direction: 'client->server' | 'server->client';
    method: string;            // e.g. "tools/call"
    tool_name?: string;        // Extracted from payload for easy filtering
    payload: unknown;          // Full JSON-RPC (redacted)
    error?: string;
    hallucination_hint?: boolean; // Heuristic: client proceeded after server error
    pd_active: boolean;
  }
  ```
- Flush every 100ms or on session close
- Per-session log files: `~/.flight/logs/<session_id>.jsonl`
- Startup disk check: if <100MB free, warn and disable logging
- Secret redaction: strip configured env var values and regex patterns before writing
- `hallucination_hint` detection: flag when client sends follow-up after upstream error without retrying

**Key PRD specs for this sprint:** <5ms latency budget, 10 MB/s log write throughput, 1,000 entry write queue cap, 100MB disk space guard. See `flight-prd.md` §Performance Requirements and §Flight Recorder for full details.

**Sprint 1 exit criteria:** `flight proxy --cmd echo -- "hello"` works end-to-end, logs are written, tests pass in CI.

---

### Sprint 2: CLI Commands + `flight init`

**Task 4: `flight init claude` command**
- Discover existing `claude_desktop_config.json` from platform-specific path:
  - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Linux: `~/.config/Claude/claude_desktop_config.json`
  - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- For each `mcpServers` entry, wrap with Flight proxy:
  ```json
  "filesystem": { "command": "flight", "args": ["proxy", "--cmd", "mcp-server-filesystem", "--", "--root", "/workspace"] }
  ```
- Write to `~/.flight/claude_desktop_config_snippet.json` by default
- `--apply` flag: overwrite in place with `.bak` backup
- No existing config: generate example snippet with placeholder entry

**Task 5: Log inspection CLI**
- `flight log list` — table of sessions (ID, date, duration, call count, error count)
- `flight log tail [--session <id>]` — live stream with color coding (green=success, red=error, yellow=hallucination hint)
- `flight log view <session-id>` — paginated timeline (timestamp, tool name, latency, status)
- `flight log filter --tool <name> | --errors | --hallucinations`
- `flight log inspect <call-id>` — pretty-print full request/response with syntax highlighting
- Truncate large payloads by default, `--full` flag for complete output

**Sprint 2 exit criteria:** Can install, run `flight init claude`, proxy a real MCP server, and inspect the session with CLI commands.

---

### Sprint 3: MVP Polish + GitHub Publish

**Task 6: Integration testing + benchmarks**
- End-to-end test with real `mcp-server-filesystem` (or lightweight mock)
- Benchmark two load profiles:
  - Small frequent: 500 calls x ~1KB (tool chatter)
  - Large single: 10 calls x ~1MB (file reads)
- Verify <5ms added latency (first-byte-in to first-byte-out)
- Verify log queue drop behavior under simulated disk stall
- Test secret redaction with mock secrets

**Task 7: README + publish**
- README with:
  - Origin story: MathWorks M3 competition → hallucinated data with no trace → built the missing instrumentation layer (see PRD §Problem Statement §4)
  - Dual framing: "Flight recorder for AI coding agents" — developer debugging tool + research infrastructure
  - System diagram (ASCII): Claude ⇄ Flight Proxy ⇄ MCP Server
  - Install: `npm install -g flight-proxy`
  - Quick start: `flight init claude` → 3-step setup
  - Feature overview (flight recorder, hallucination hints, CLI commands)
  - Documented workflow: "Debug a Hallucinated File Write" with terminal output example
  - Limitations section (hallucination_hint is heuristic, PD coming in v1.0)
  - Comparison table vs. related tools (MCP Inspector, Reticle, AgentLens — see PRD §Appendix)
- `LICENSE` (MIT)
- Publish v0.1.0 to npm, tag on GitHub
- Add CI badge to README

**Sprint 3 exit criteria:** Published on GitHub and npm. A user can `npm install -g flight-proxy && flight init claude` and start recording MCP sessions in <2 minutes.

---

## MVP Gate

**Do not proceed until:**
- Package is live on npm and GitHub
- At least 1 real captured session demonstrates hallucination detection
- Feedback from 1-3 early users confirms flight recorder value

---

## Post-MVP Sprints (v1.0)

### Sprint 4: Progressive Disclosure Validation

**Task 8: PD validation checkpoint**
- Create mock MCP server exposing `discover_tools` + `execute_tool` with 10+ real tool schemas
- Run 3+ real Claude Code sessions against it (file editing, code gen, debugging tasks)
- Measure task completion rate vs. passthrough baseline
- **Go/no-go:** If completion drops >20%, pivot to alternatives:
  - Category-based schema subsets
  - Lazy schema loading (summaries first, full schema on first use)
  - Hybrid (top-N tools direct, meta-tool for the rest)
- Document results and chosen approach

**Sprint 4 exit criteria:** Written go/no-go decision with data. Chosen PD approach validated.

---

### Sprint 5: Progressive Disclosure Implementation

**Task 9: PD core (single-server)**
- MCP protocol handling:
  - Forward `initialize` handshake unmodified in both modes
  - Log MCP protocol version, warn on unsupported version
  - Only intercept `tools/list` responses after initialization
- Schema cache: fetch all upstream tool schemas via `tools/list` at startup
- Intercept `tools/list`: replace with `discover_tools` + `execute_tool` meta-tools
- `discover_tools` handler: keyword match against cached tool names/descriptions, return matches
- `execute_tool` routing:
  - Translate to standard `tools/call` JSON-RPC with original tool name and arguments
  - Maintain `call_id` mapping table for response correlation
  - Unwrap upstream response (Claude sees result as if it called the tool directly)
  - Unknown tool → JSON-RPC error: `"Unknown tool: {name}. Use discover_tools to find available tools."`
  - Forward upstream errors with original message preserved
- Fallback: any schema interception failure → silently drop to passthrough, log warning
- Config: `--pd` flag, `progressiveDisclosure.enabled` in config

**Task 10: Token metrics + stats command**
- Estimate baseline tokens: raw schema char count / 4
- Estimate disclosed tokens: meta-tool schema + injected schemas from `discover_tools` calls
- Log `schema_tokens_saved` per call
- `flight stats <session-id>`: before/after token estimate, savings %, call summary
- Test: 1 tool (identical to passthrough), 10+ tools (verify 10-50x reduction claim)

**Sprint 5 exit criteria:** PD mode works with real Claude Desktop session. Measured token savings documented.

---

### Sprint 6: Research Export + Replay

**Task 11: Export and replay**
- `flight export <session-id> --format csv` — flat CSV with `hallucination_hint`, `tool_name`, `latency_ms` as columns
- `flight export <session-id> --format jsonl` — cleaned JSONL (redaction applied)
- `flight replay <call-id>` — re-execute request against upstream
- `flight replay <call-id> --dry-run` — show what would execute without side effects
- `flight metrics summary` — compute aggregate stats on-the-fly from session logs (session count, error rate, PD adoption, token savings)

**Sprint 6 exit criteria:** Can export a session to CSV, replay a call, and view aggregate metrics.

---

### Sprint 7: Hardening + TUI

**Task 12: Safety hardening**
- Configurable redaction patterns: env vars list + regex patterns (e.g. `sk-*`, `ghp_*`)
- Loop detection: same call + same args repeated N times → warning (configurable circuit breaker)
- Log lifecycle: compress sessions >1 day to `.jsonl.gz`, auto-prune if >5GB, `flight log gc` and `flight log prune` commands
- Graceful upstream crash recovery, clear error messages
- Fuzz test with malformed JSON, test disk-full conditions

**Task 13: TUI dashboard (if time permits)**
- Header: session info, duration, PD status
- Main: scrollable tool call timeline
- Detail: selected call request/response
- Sidebar: call count, error rate, latency, token savings, disk usage %
- Keys: `↑/↓` navigate, `Enter` inspect, `/` filter, `e` errors-only, `h` hallucination hints, `q` quit
- `flight tui` launch command
- If timeline is tight, defer TUI entirely — CLI is sufficient

**Sprint 7 exit criteria:** Hardened proxy passes fuzz tests, handles crashes gracefully, manages disk budget.

---

### Sprint 8: Documentation + v1.0 Release

**Task 14: Documentation**
- `README.md`: origin story, dual framing (dev tool + research), install/quickstart, feature overview, demo GIF placeholder
- `ARCHITECTURE.md`: system diagram, JSON-RPC flow, PD algorithm, log schema reference
- `RESEARCH.md`: using Flight as a data collection instrument, example jq/Python queries, hallucination_hint limitations, guidance on session dataset building
- `CONTRIBUTING.md`, `FAQ.md`

**Task 15: Release**
- Version bump to 1.0.0
- GitHub release with changelog
- Publish to npm
- Sample anonymized session datasets (2-3 `.jsonl.gz` files)
- Update CI release workflow for automated publish on tag

**Sprint 8 exit criteria:** v1.0.0 published on npm, docs complete, ready for launch announcement.

---

## Cut Lines

If time runs short, cut in this order (bottom first):
1. **TUI** (Task 13) — CLI is sufficient
2. **Replay** (part of Task 11) — export is more valuable
3. **Loop detection** (part of Task 12) — nice-to-have safety feature
4. **Log compression** (part of Task 12) — manual cleanup is fine for early users
5. **Never cut:** proxy core, logging, CLI inspection, PD, README

---

## Success Criteria

### MVP (Sprint 3)
- `npm install -g flight-proxy` works
- <5ms added latency
- 100% JSON-RPC fidelity
- `flight init claude` sets up in <2 minutes
- Published on GitHub with README

### v1.0 (Sprint 8)
- 10-50x token reduction with PD (single-server)
- Research-grade log export (CSV/JSONL)
- Hardened for production use
- Complete documentation (developer + researcher paths)
- 200+ GitHub stars target within 3 months

---

## Post-v1.0 Roadmap

- **v1.1:** Multi-server PD, `flight analyze` command, Parquet export
- **v1.2:** Experiment mode (`--condition` labels for A/B), anomaly detection
- **v2.0:** HTTP transport, non-MCP framework support, plugin system, potential Rust rewrite

## Future: Claude Code Extension

If Claude Code ships a formal extension/plugin API, Flight could migrate from the current
proxy + hooks architecture to a native extension. This would enable:

- Deeper UI integration (inline panels, status indicators)
- Direct access to Claude's context window for smarter PD
- No MCP config wrapping needed at all

For now, the proxy + Claude Code hooks approach (`flight setup`) is the pragmatic choice
that works with the current Claude Code architecture. The zero-config setup via hooks
(SessionStart/SessionEnd) combined with MCP config wrapping provides the best balance
of integration depth and stability.
