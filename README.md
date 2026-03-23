![CI](https://github.com/lewisnsmith/flight/actions/workflows/ci.yml/badge.svg)

# Flight

**A flight recorder for AI coding agents — captures every tool call, detects hallucinations, and optimizes tokens.**

Flight records everything your AI agent does: every file read, shell command, grep, edit, and MCP server interaction. It works through two complementary mechanisms:

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code                                            │
│                                                         │
│  Read, Write, Edit, Bash, Grep, Glob, ...               │
│       │                                                 │
│       │  hooks (PostToolUse)        MCP calls (stdio)   │
│       ▼                                  │              │
│  <session>_tools.jsonl                   │              │
└──────────────────────────────────────────┼──────────────┘
                                           │
                                           ▼
                                   ┌───────────────┐
                                   │ Flight Proxy   │──► session_*.jsonl
                                   │ - Intercept    │──► alerts.jsonl
                                   │ - Compress     │──► hallucination hints
                                   └───────┬───────┘
                                           │ stdio
                                           ▼
                                   ┌───────────────┐
                                   │ MCP Server     │
                                   └───────────────┘
```

**Hooks** capture all tool calls (built-in and MCP) — installed via `flight setup` into Claude Code's hook system. **Proxy wrapping** adds full JSON-RPC traffic recording and token optimization for MCP servers.

Together, they give you a complete, structured record of every action your agent takes — the raw material for studying hallucinations, tool-calling patterns, and failure modes.

---

## Origin

During the **MathWorks M3 competition**, I leaned on AI assistants for brainstorming and data lookup — only to discover, too late, that many of the "facts" and numerical results were hallucinated. The model produced confident, statistically formatted outputs. There was no way to inspect what it had actually done. Tool calls and data sources were opaque.

That frustration directly led to Flight.

The M3 experience exposed a structural problem: AI systems producing confident but incorrect statements, with no ground-truth trace. Without a record of every tool call, response, and error, hallucinations can't be studied — they can only be discovered after the damage is done. Flight is my attempt to build the missing instrumentation layer. It turns opaque agent runs into **structured, analyzable records** — the raw material for empirically studying agent behavior instead of treating failures as mysterious.

---

## Quick Start

```bash
# Install from source
git clone https://github.com/lewisnsmith/flight.git
cd flight && npm install && npm run build && npm link

# Interactive setup — installs hooks + optionally wraps MCP servers
flight setup

# Or step by step:
flight hooks install              # Record all tool calls via hooks
flight init claude-code --apply   # Also wrap MCP servers for full traffic recording

# Start a Claude Code session — Flight records automatically
# Then inspect what happened:
flight log tail
```

```
● Tailing session_20260315_142201

[14:22:01] Read    src/index.ts (3ms)
[14:22:03] Bash    npm run build (1204ms)
[14:22:05] Edit    src/auth.ts (5ms)
[14:22:06] ↑ mcp   tools/call/write_file ERROR: Permission denied
[14:22:08] ↑ mcp   tools/call/read_file ⚠ HALLUCINATION HINT
```

---

## What Gets Recorded

| Source | What's captured | Log file |
|--------|----------------|----------|
| **Hooks** (all tools) | Tool name, arguments, timing, session context | `<session>_tools.jsonl` |
| **MCP Proxy** (wrapped servers) | Full JSON-RPC request/response payloads, latency, errors | `session_*.jsonl` |
| **Alert detection** | Hallucination hints, error loops, repeated failures | `alerts.jsonl` |

Hooks are lightweight metadata; the proxy captures full payloads. Use both together for complete coverage.

---

## Debug a Hallucinated File Write

Claude claims it created `auth.ts`, but the file doesn't exist:

```bash
$ flight log tail
[14:02:11] ↑ mcp  tools/call/write_file
[14:02:12] ↓ mcp  tools/call ERROR: Permission denied
[14:02:14] ↑ mcp  tools/call/read_file ⚠ HALLUCINATION HINT

$ flight log inspect <call-id>
Session:   session_20260315_140200
Call ID:   2
Direction: server->client
Method:    response
Latency:   12ms
Error:     Permission denied

--- Payload ---
{
  "jsonrpc": "2.0",
  "id": 2,
  "error": { "code": -32000, "message": "Permission denied" }
}
```

> **Note:** `hallucination_hint` is a heuristic — it flags when the client proceeds after a server error without retrying. It does not catch fabricated data in successful responses, wrong-but-successful arguments, or reasoning hallucinations that bypass tools entirely. Treat hints as investigative leads, not verdicts.

---

## CLI Reference

```bash
# Setup & configuration
flight setup                        # Interactive setup wizard (hooks + MCP wrapping)
flight hooks install                # Install Claude Code hooks (records all tool calls)
flight hooks remove                 # Remove hooks
flight init claude                  # Discover and wrap Claude Desktop MCP servers
flight init claude --apply          # Apply directly (backs up original)
flight init claude-code --apply     # Wrap Claude Code MCP servers

# Proxy
flight proxy --cmd <server> -- <args>  # Run proxy manually
flight proxy --cmd <server> --pd       # With progressive disclosure enabled

# Log inspection
flight log list                     # List all sessions (ID, date, calls, errors)
flight log tail [--session <id>]    # Live stream a session
flight log view <session>           # Full timeline with summary
flight log filter --tool <name>     # Filter by tool name
flight log filter --errors          # Show only failed calls
flight log filter --hallucinations  # Show hallucination hints
flight log inspect <call-id>        # Pretty-print full request/response payload
flight log alerts                   # Show hallucination/loop/error alerts
flight log summary [--session <id>] # Session summary statistics
flight log tools                    # Tool call frequency breakdown
flight log prune --before <date>    # Delete sessions before a date
flight log prune --keep <n>         # Keep only the N most recent sessions

# Analysis & export
flight stats                        # Usage statistics across sessions
flight export --format csv          # Export session data as CSV
flight export --format jsonl        # Export session data as JSONL
flight replay <session>             # Replay tool calls from a recorded session
```

---

## Research Use

Every `.jsonl` session file is a structured dataset:

```json
{
  "session_id": "session_20260315_142201",
  "call_id": "2",
  "timestamp": "2026-03-15T14:02:11.421Z",
  "direction": "server->client",
  "method": "tools/call",
  "tool_name": "write_file",
  "latency_ms": 12,
  "error": "Permission denied",
  "hallucination_hint": true,
  "pd_active": false
}
```

**What you can study:**

- **Hallucination rate by tool** — which tools produce the most proceed-after-error patterns?
- **Tool-calling policy modeling** — how does the agent sequence tool calls?
- **Latency and error correlation** — do high-latency calls predict downstream failures?

**Extract all hallucination hints:**
```bash
jq 'select(.hallucination_hint == true)' ~/.flight/logs/session_*.jsonl
```

**Analyze with Python:**
```python
import json, pathlib

entries = []
for line in pathlib.Path("~/.flight/logs/session_abc.jsonl").expanduser().read_text().splitlines():
    entries.append(json.loads(line))

errors = [e for e in entries if e.get("error")]
hints = [e for e in entries if e.get("hallucination_hint")]
print(f"Calls: {len(entries)}, Errors: {len(errors)}, Hallucination hints: {len(hints)}")
```

---

## Features

| Feature | Status |
|---------|:------:|
| Claude Code hooks (all tool calls) | ✅ |
| MCP proxy (full JSON-RPC traffic) | ✅ |
| `.jsonl` session logging | ✅ |
| Hallucination hint detection | ✅ |
| `flight init` (MCP config discovery) | ✅ |
| Secret redaction | ✅ |
| `flight log` CLI (list, tail, view, filter, inspect) | ✅ |
| Progressive disclosure (token optimization) | ✅ |
| Replay functionality | ✅ |
| CSV/JSONL export | ✅ |
| Token savings metrics | ✅ |
| Log compression + lifecycle | ✅ |
| Auto-retry for transient errors | ✅ |
| Interactive setup wizard | ✅ |
| TUI dashboard | planned |

---

## Performance

- **<5ms** added latency per tool call (streaming NDJSON, fire-and-forget log writes)
- **40,000+ calls/sec** sustained throughput ([benchmarked](./bench/throughput.ts))
- **Backpressure-aware:** proxy never accumulates unbounded in-memory buffers
- **Disk-safe:** disables logging gracefully if free space drops below 100MB
- **Write queue:** 1,000 entries max; drops with warning under disk pressure, never stalls the proxy

---

## Log Storage

- **Location:** `~/.flight/logs/<session_id>.jsonl`
- **One file per session**, append-only
- **Auto-compression:** sessions older than 24h are gzip-compressed (`.jsonl.gz`)
- **Garbage collection:** configurable max sessions (100) and max size (2 GB)
- **Pruning:** `flight log prune --before <date>` or `--keep <n>`

---

## Related Work

| Tool | Terminal | Offline | Open Source | All Tool Calls | Token Optimization | Research-Grade Logs |
|------|:--------:|:-------:|:-----------:|:--------------:|:-----------------:|:-------------------:|
| **Flight** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reticle | ✅ | ✅ | ✅ | — | — | — |
| MCP Inspector | — (browser) | ✅ | ✅ | — | — | — |
| Langfuse/Moesif | — | — | partial | — | — | — |

---

## Install

```bash
git clone https://github.com/lewisnsmith/flight.git
cd flight && npm install && npm run build && npm link
flight init claude
```

Requires Node.js 20+. No database, no cloud, no external dependencies.

---

## Documentation

- [`docs/flight-prd.md`](./docs/flight-prd.md) — full product requirements document
- [`docs/plan.md`](./docs/plan.md) — sprint plan and roadmap
- [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) — iteration history

---

## License

MIT
