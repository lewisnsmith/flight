# Product Requirements Document: Flight Proxy

> **Status:** This document describes the full v1.0 vision. For current implementation status, see the [README](../README.md).

## Overview

**Product Name:** Flight Proxy
**Version:** 1.0
**Date:** March 2026
**Status:** Planning

---

## Executive Summary

Flight Proxy is a local MCP (Model Context Protocol) proxy that acts as a **flight recorder** and **token optimizer** for AI coding agents like Claude Code and Cursor. It provides terminal-first debugging and observability for agentic tool calls, while reducing token costs through progressive disclosure.

It is also **research infrastructure** for the systematic, empirical study of agent behavior, tool-calling policies, and hallucinations. Every captured session is a structured dataset — JSON-RPC logs with timestamps, methods, latencies, and errors — that can be analyzed quantitatively, used to model tool-calling policies, and eventually used to design interventions that reduce hallucination rates. Flight Proxy turns opaque agent runs into inspectable, reproducible, analyzable records.

---

## Problem Statement

### 1. Silent Tool Failures & Hallucinations
AI coding agents frequently hallucinate successful tool calls when MCP servers fail or return errors. Developers see Claude Code claim it "created a file" or "queried the database," but no actual change occurred. Debugging requires manually checking git diffs and retracing steps, with no visibility into the JSON-RPC traffic that caused the failure.

### 2. Token Bloat from Large Toolsets
When developers connect 10+ MCP servers (GitHub, Postgres, Slack, local files, etc.), Claude's system prompt becomes bloated with 20,000+ tokens of unused tool schemas. This increases API costs by 10-50x per interaction and degrades model reasoning performance due to context window pollution.

### 3. No Local-First Debugging Tools
Existing solutions are either:
- Enterprise SaaS platforms (Moesif, Langfuse) requiring cloud data export
- Web dashboards requiring local server setup
- Incomplete logging that doesn't capture full JSON-RPC streams

Developers need a **terminal-native, offline-first** tool that works instantly without changing their workflow.

### 4. No Ground-Truth Trace for Studying Agent Behavior

During the MathWorks M3 competition, the author leaned on AI assistants for brainstorming and data lookup — only to discover that many of the "facts" and data points were hallucinated. There was no way to inspect what the model had actually done. Tool calls and data sources were opaque. The model produced confident, statistically formatted outputs with no retrievable ground truth.

This is a structural problem: AI systems generating confident but incorrect statements, with no trace to audit. Without a ground-truth record of every tool call, response, and error, hallucinations cannot be studied systematically — they can only be experienced after the fact. Flight Proxy is an attempt to build the missing instrumentation layer: it turns agent runs into **structured, replayable, analyzable datasets** that make hallucinations and tool-calling failures tractable as a scientific problem, not just a developer frustration.

---

## Target Users

### Primary
- **Power users of Claude Code / Cursor** running 5+ MCP servers
- **Agent framework developers** building on LangGraph, AutoGPT, or custom MCP orchestrators
- **ML researchers and empirical AI scientists** studying agent behavior, tool-calling policies, and hallucination mechanisms — Flight Proxy provides the ground-truth trace layer needed to move from anecdotal hallucination reports to quantitative analysis

### Secondary
- **Indie hackers** optimizing API costs for AI-powered products
- **Enterprise teams** needing local observability before cloud deployment

---

## Goals & Success Metrics

### Goals

1. **Flight Recorder**
   - Capture 100% of MCP JSON-RPC traffic (requests, responses, errors, stderr)
   - Enable replay and inspection of any tool call sequence
   - Target: <5ms added latency per call

2. **Token Optimization**
   - Reduce schema token overhead by 10-50x for large toolsets (10+ servers)
   - Implement progressive disclosure meta-tool pattern
   - Maintain 100% functional compatibility with existing MCP servers

3. **Zero-Friction Adoption**
   - Install: Single command (`npm install -g flight-proxy`)
   - Config: Drop-in replacement in `claude_desktop_config.json` via `flight init claude`
   - No external dependencies, databases, or cloud services

4. **Research Infrastructure**
   - Log schema designed as a first-class research dataset (not just a debug artifact): `session_id`, `call_id`, `tool_name`, `hallucination_hint`, `pd_active`, `latency_ms`, `error` as top-level fields
   - Export sessions as flat CSV or clean JSONL for analysis in Python, R, or MATLAB
   - `flight log filter --hallucinations` surfaces calls where the client proceeded after a server error — a detectable *heuristic* for hallucinated success (does not catch fabricated data, wrong-but-successful arguments, or reasoning hallucinations that bypass tool calls entirely)
   - Enables quantitative modeling of tool-calling policies and empirical study of when and how agents hallucinate

### Success Metrics

- **GitHub Adoption:** 200+ stars within 3 months of v1.0 release
- **Measured Performance:** ≥10x token reduction demonstrated with real user setup (10+ tools)
- **Community Validation:** 3+ public testimonials citing Flight Proxy as essential for debugging
- **Technical Reliability:** <1% failure rate in proxying tool calls

---

## Key Features (v1.0)

### 1. MCP Proxy Core
- **Transparent STDIO proxy** that sits between Claude and upstream MCP servers
- Forwards JSON-RPC messages bidirectionally without modification (unless progressive disclosure enabled)
- Configurable mapping: logical server name → upstream command/args/env
- Support for multiple concurrent proxy instances (one per MCP server)

### 2. Flight Recorder
- **Append-only `.jsonl` logging** of all tool interactions
  - Fields: `session_id`, `call_id`, `timestamp`, `direction`, `method`, `payload`, `latency_ms`, `error`
- **Per-session log files** with automatic rotation on session close
- **Structured error capture** including stderr from crashed MCP servers
- **Secret redaction** for configured env vars and patterns (active from v0.1 MVP)

**Log lifecycle and disk budget (defaults, all configurable):**
- **Retention:** Keep the last **100 sessions** or the last **2GB** of compressed logs, whichever limit is hit first. Oldest sessions are pruned automatically.
- **Compression:** Sessions older than **1 day** are gzip-compressed (typical ratio: 8–12× for JSON). A 10-call session producing ~500KB raw compresses to ~50KB. Active sessions are written uncompressed for fast appends.
- **Disk budget:** Default cap of **5GB** total log storage (configurable via `--max-disk-mb`). The TUI shows a disk usage warning at 80% of the configured budget.
- **Manual control:** `flight log prune` trims to current retention policy; `flight log prune --all` clears everything. `flight log gc` runs cleanup and reports reclaimed space. Flags: `--max-sessions N`, `--max-disk-mb N`.
- **On-disk structure:** `~/.flight/logs/<session_id>.jsonl` (active) → `<session_id>.jsonl.gz` (after 1 day)
- **Startup guard:** Flight checks available disk space on launch. If free space is below 100MB, it emits a warning and disables logging rather than crashing the proxy.

### 3. Terminal CLI
```bash
# Setup
flight init claude                   # Discover existing MCP servers, wrap with Flight proxy
flight init claude --apply           # Apply directly (backs up original first)

# Logging
flight log list                      # List all sessions
flight log tail                      # Live stream current session
flight log view <session>            # Paginated timeline view
flight log filter --tool <name>      # Filter by tool name
flight log filter --errors           # Show only failed calls
flight log gc                        # Garbage collect logs, show reclaimed space
flight log prune                     # Trim to retention policy
flight log prune --all               # Clear everything

# Replay & stats
flight replay <call-id>              # Re-execute specific request
flight replay <call-id> --dry-run    # Show what would happen
flight stats                         # Session-level token and call summary
flight metrics summary               # Aggregate usage report across all sessions
```

### 4. Terminal UI (TUI)
- **Live dashboard** showing:
  - Current tool calls (streaming)
  - Token usage estimates
  - Error rate by tool
  - Call latency histogram
  - Disk usage bar (warns at 80% of configured budget)
- **Interactive timeline navigation** with keyboard controls
- **Syntax-highlighted JSON** for request/response inspection

### 5. Progressive Disclosure Layer

> **Scope for v1.0 (PD v0):** Single upstream server only. Multi-server orchestration, per-tool token metrics, cross-session stats, and complex matching heuristics are deferred to post-v1.0. The goal is to ship the core differentiator correctly, not completely.

Implements the meta-tool pattern to reduce schema bloat:

**Exposed to Claude:**
```json
{
  "tools": [
    {
      "name": "discover_tools",
      "description": "Search available tools by capability or domain"
    },
    {
      "name": "execute_tool",
      "description": "Execute a specific tool with arguments"
    }
  ]
}
```

**Under the hood (PD v0 scope):**
- Cache upstream tool schemas in memory at proxy startup via `tools/list`
- Intercept `tools/list` responses and replace with `discover_tools` + `execute_tool` only
- Inject the matching full schema when Claude calls `discover_tools`
- Emit a simple before/after token estimate per session (raw schema token count vs. disclosed count)
- **Fallback:** If schema interception fails or the server returns an unexpected format, silently drop back to passthrough mode and log a warning

**`execute_tool` Routing & Protocol Details:**

When Claude calls `execute_tool({ tool_name: "read_file", arguments: { path: "src/auth.ts" } })`, the proxy must:
1. Look up `read_file` in the cached schema registry
2. Translate the call into a standard `tools/call` JSON-RPC request with the original tool name and arguments
3. Map the proxy's `call_id` to the upstream `call_id` for response correlation
4. Forward the upstream response back to Claude, unwrapping it from `execute_tool` framing — Claude receives the result as if it called the tool directly
5. If the tool name is not found in the cache, return a JSON-RPC error to Claude (not a proxy crash) with a descriptive message

**Error propagation:** Upstream errors (JSON-RPC error responses, timeouts, crashes) are forwarded to Claude as `execute_tool` error responses with the original error message preserved. The proxy never swallows upstream errors.

**MCP Protocol Negotiation:**

The proxy must handle the MCP `initialize` handshake transparently:
1. **Passthrough mode (PD disabled):** Forward `initialize` request/response unmodified between client and server. The proxy is invisible at the protocol level.
2. **PD mode:** Forward the `initialize` handshake unmodified (capabilities are negotiated between client and server directly). The proxy only intercepts `tools/list` responses *after* initialization completes. It does **not** modify advertised capabilities — it only replaces the tool list content.
3. **Version pinning:** The proxy should log the MCP protocol version from the `initialize` exchange and warn if it encounters an unsupported version (currently targets MCP draft spec as of March 2026).

**PD Validation Checkpoint (required before full implementation):**

Before building the full PD implementation, validate the meta-tool pattern with a manual test:
1. Create a mock MCP server that exposes only `discover_tools` and `execute_tool`
2. Run a real Claude Code session against it with a multi-step task
3. Evaluate: Does Claude correctly discover tools before using them? Does the indirection cause reasoning errors, extra retries, or tool-calling failures?
4. **Go/no-go:** If Claude's task completion rate drops >20% vs. passthrough, explore alternative designs (e.g., category-based schema subsets, lazy schema loading) before proceeding.

**Deferred to post-v1.0:**
- Multi-server orchestration (routing `execute_tool` across N upstream servers)
- Per-tool usage frequency stats and cross-session disclosure analytics
- Complex fuzzy-matching or embedding-based tool search
- Schema diff detection across MCP server versions

### 6. Usage Metrics (Computed from Session Logs)

`flight metrics summary` computes aggregate usage metrics **on-the-fly from session logs** — no separate metrics file is maintained. This avoids additional disk surface area while providing the same insights.

**Output includes:** session count, total tool calls, error rate distribution, PD adoption rate, estimated token savings, average session duration.

**Privacy:** All computation is local. No data is transmitted. Metrics are derived from the same `.jsonl` session logs that are already subject to secret redaction.

> **Note:** A dedicated `~/.flight/metrics.jsonl` file for pre-computed metrics is deferred to post-v1.0. If on-the-fly computation becomes too slow for users with thousands of sessions, a cache file will be introduced then.

### 7. Safety & Isolation
- **Secret redaction** for configured env vars and patterns
- **Dry-run replay mode** that simulates without executing side effects
- **Rate limiting** to prevent runaway tool call loops
- **Audit trail** with tamper-evident log integrity checks

---

## Non-Goals (Out of Scope for v1.0)

- ❌ Web dashboard or GUI (terminal-only)
- ❌ General-purpose agent framework (not replacing LangGraph/AutoGPT)
- ❌ Long-term project knowledge management (no vector DB or embeddings)
- ❌ Multi-user collaboration features
- ❌ Cloud sync or hosted service
- ❌ Integration with non-MCP protocols
- ❌ Multi-server progressive disclosure orchestration (PD v0 is single-server only)

---

## Technical Architecture

### System Diagram
```
┌─────────────────┐
│  Claude Code    │
│  (MCP Client)   │
└────────┬────────┘
         │ stdio
         ▼
┌─────────────────┐
│  Flight Proxy   │  ◄── Logs to .jsonl
│  - Intercept    │  ◄── Progressive Disclosure
│  - Record       │  ◄── Token Metrics
│  - Transform    │
└────────┬────────┘
         │ stdio
         ▼
┌─────────────────┐
│  MCP Server     │
│  (filesystem,   │
│   postgres,     │
│   github, etc)  │
└─────────────────┘
```

### Technology Stack (Proposed)
- **Runtime:** Node.js 20+ (TypeScript) or Rust
- **JSON-RPC:** Native JSON streaming parser
- **TUI:** `blessed` (Node) or `ratatui` (Rust)
- **CLI:** `commander` (Node) or `clap` (Rust)
- **Logging:** Structured `.jsonl` with `pino` or similar

### Performance Requirements

**Latency budget (<5ms per call):**
- JSON-RPC messages are processed as **streaming NDJSON** — never fully buffered in memory — so large responses (e.g. a tool returning 500KB of file content) do not block forwarding while waiting for the final byte.
- Log writes are **fire-and-forget async**: the proxy pipes bytes downstream immediately and enqueues the log write separately. Disk I/O latency is never on the critical path.
- The <5ms target is measured as the delta between first-byte-received-from-upstream and first-byte-forwarded-to-client, not including network or disk time.

**Throughput targets (non-functional):**
- Must sustain **1,000+ tool calls per session** without degradation (typical agent sessions run 20–200 calls; 1,000 covers outlier long-running sessions).
- Log pipeline must sustain **10 MB/s write throughput** to handle sessions with large tool responses (e.g. a database query returning 1MB of rows called 10× per minute).
- Benchmarks must cover two distinct load profiles:
  - *Small frequent messages:* 500 calls × ~1KB each (tool chatter, status checks)
  - *Single large responses:* 10 calls × ~1MB each (file reads, DB dumps)

**Backpressure handling:**
- The proxy applies **pass-through backpressure**: if the Claude client is reading slowly, the proxy slows its reads from the upstream MCP server proportionally. It does not accumulate unbounded in-memory buffers.
- The async log write queue has a maximum in-memory depth of 1,000 entries. If the disk falls behind (e.g. on a slow HDD under heavy load), entries beyond this limit are **dropped with a warning** in the TUI/stderr — the proxy never stalls to wait for disk.

**Worst-case log I/O behavior:**
- On startup, Flight checks available disk space. If free space is below 100MB, it emits a warning and disables logging rather than crashing the proxy.
- A dedicated async write queue ensures that even a full disk (write failure) results in a logged warning, not a proxy crash or tool call failure.

---

## User Workflows

### Workflow 0: Zero-Config First Run
```bash
# Install
$ npm install -g flight-proxy

# Generate Claude Desktop config snippet
$ flight init claude
✓ Found existing config: ~/Library/Application Support/Claude/claude_desktop_config.json
✓ Discovered 3 MCP servers: filesystem, github, postgres
✓ Wrapped config written to: ~/.flight/claude_desktop_config_snippet.json
  Review and merge into your claude_desktop_config.json, or run:
  flight init claude --apply    # overwrites in place (backup saved to .bak)

# Start a Claude Code session — Flight intercepts automatically
$ flight log tail
● Recording MCP traffic to ~/.flight/logs/session_20260315_142201.jsonl
  flight log view session_20260315_142201   ← inspect after session
  flight replay <call-id>                  ← replay any call

[14:22:03] ↑ Claude → filesystem/read_file("src/auth.ts")
[14:22:03] ↓ filesystem → OK (2,341 bytes, 1ms)
[14:22:05] ↑ Claude → github/create_pr(...)
```

### Workflow 1: Debug a Hallucinated File Write
```bash
# Claude claims it created auth.ts, but file doesn't exist
$ flight log tail
[14:02:11] ↑ Claude → write_file("auth.ts", ...)
[14:02:12] ↓ filesystem_mcp → ERROR: Permission denied
[14:02:14] ⚠  HALLUCINATION HINT: Claude proceeded after server error

# Replay to confirm the upstream failure
$ flight replay call_abc123
ERROR: Permission denied (path outside allowed directory)
```

> **Important:** `hallucination_hint` is a heuristic, not a ground-truth hallucination detector. It flags one detectable pattern: the client proceeding after an upstream error without retrying. It does **not** catch fabricated data in successful responses, wrong tool arguments that happen to succeed, or hallucinated reasoning that never involved a tool call. Treat hints as investigative leads, not verdicts.

### Workflow 2: Optimize Token Usage
```bash
# Before: 50 tools loaded = 22,000 tokens
$ flight start --progressive-disclosure
✓ Proxy running on stdio
✓ Progressive disclosure: ENABLED (PD v0 — single server)
✓ Estimated schema tokens: 500 (was 22,000)

# After Claude session
$ flight stats
Session duration: 45min
Tool calls: 28
Tokens saved: ~600,000 (95% reduction)
Cost saved: ~$1.20
```

### Workflow 3: Investigate Agent Loop Failure
```bash
$ flight log view session_xyz --tui
# Interactive timeline shows:
# 1. Query database → 5000 rows returned
# 2. Summarize results → Model truncated JSON
# 3. Write code using wrong schema → Bug introduced
# 4. Run tests → Failed
# 5. Query database again → Same 5000 rows...
# [Detected infinite loop at step 6]
```

---

## Dependencies & Risks

### Dependencies
- MCP specification stability (currently in draft)
- Claude Desktop or compatible MCP client
- Upstream MCP servers following stdio transport spec

### Risks

| Risk | Mitigation |
|------|-----------|
| MCP spec changes break proxy | Pin to specific MCP version, provide upgrade path |
| Added latency degrades UX | Target <5ms overhead, benchmark small-frequent and large-single load profiles (see Performance Requirements) |
| Complex tool schemas break progressive disclosure | Fallback to passthrough mode, add schema validation |
| Anthropic adds native debugging | Position as enhanced/offline alternative |
| **Progressive disclosure ships late or incomplete** | **Treat as Phase 3 (Week 3-4) feature, not Phase 4. PD v0 is intentionally narrow (single-server only). Ship without TUI before shipping without PD. If PD slips, delay v1.0 rather than release a pure logger.** |
| **PD indirection degrades Claude's reasoning quality** | **The `discover_tools` → `execute_tool` pattern adds an extra round-trip per tool call. Claude must reason through the indirection layer, which may reduce tool-calling accuracy. Mitigate with a manual validation test (see PD Validation Checkpoint below) before committing to full implementation. If Claude struggles with the pattern, consider alternative designs (e.g., category-based schema subsets instead of meta-tools).** |

---

## MVP Definition: First 3 Users

The full v1.0 feature set (proxy + CLI + TUI + progressive disclosure) risks building too much before any user feedback. The MVP is the smallest slice that validates the core flight recorder value proposition.

**Phase 1.5 — "First User MVP" (target: end of Week 2–3)**

Ship to 3 target users: ideally 1 agent framework developer, 1 power Claude Code user, 1 indie hacker with 10+ MCP servers.

What IS in the MVP:
- Transparent STDIO proxy (zero-modification passthrough — no PD yet)
- Append-only `.jsonl` session logging with the full field schema
- `flight log tail` — live stream of current session in terminal
- `flight log view <session>` — paginated post-mortem inspection
- `flight init claude` — one command to generate a working `claude_desktop_config.json` snippet
- Secret redaction for env vars (on by default)
- One fully documented workflow: **"Debug a Hallucinated File Write"** (Workflow 1 above)
- README with a 5-minute setup walkthrough for Claude Code

What is explicitly NOT in the MVP:
- TUI dashboard (the `tail` command substitutes for it)
- Progressive disclosure (proxy runs in pure passthrough mode)
- Replay functionality
- Token savings metrics
- Compression or log pruning automation

**First-feedback gate:** Only proceed to progressive disclosure and TUI after at least 2 of 3 early users confirm the flight recorder is independently useful. If users say "I don't need the logging, I need the token savings" — reprioritize PD above TUI immediately.

---

## Release Timeline

> **Critical path note:** Progressive disclosure is the primary differentiator vs. Reticle and MCP Inspector. It must ship in v1.0 — not as a stretch goal. PD v0 is intentionally narrow to make this achievable. The timeline below front-loads it accordingly.

- **Week 1-2:** Core proxy + basic logging + `flight init claude` + CI setup
- **Week 2-3:** Phase 1.5 MVP → ship to 3 friendly users, gather feedback
- **Week 3:** PD validation checkpoint (manual mock test with real Claude sessions — go/no-go gate)
- **Week 3-4:** PD v0 implementation (single-server schema caching, `discover_tools`/`execute_tool`, session token estimate)
- **Week 5:** CLI commands (log list/view/filter/inspect, export)
- **Week 6:** Replay functionality + TUI
- **Week 7-8:** Hardening, docs, v1.0 release

---

## Open Questions

1. Should we support HTTP transport in addition to stdio?
2. Do we need built-in anonymization for sharing logs publicly?
3. Should progressive disclosure be opt-in or default?
4. ~~Should the developer-facing `metrics.jsonl` file be opt-out or opt-in?~~ **Resolved:** No separate metrics file in v1.0. `flight metrics summary` computes on-the-fly from session logs.
5. ~~What's the right balance between log detail and disk usage?~~ **Resolved:** Default 100 sessions / 2GB compressed / 5GB total cap; gzip sessions older than 1 day. See Flight Recorder spec.

---

## Appendix: Related Work

- **AgentLens** (auriel-ai): Closed-source agent debugger with replay, focuses on cost tracking
- **MCP Inspector** (Glama): Web-based MCP debugging tool, requires browser
- **Reticle** (Rust): Lightweight MCP logger, no progressive disclosure
- **Moesif/Langfuse**: Enterprise observability platforms, cloud-based

**Differentiation:** Flight Proxy is the only **terminal-native, offline-first, open-source** tool combining flight recording with token optimization — and the only tool explicitly designed as research infrastructure for empirical study of agent hallucinations and tool-calling behavior.
