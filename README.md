# ✈️ Flight Proxy

**A local MCP flight recorder, token optimizer, and research instrument for AI coding agents.**

`flight-proxy` sits transparently between Claude Code (or any MCP client) and your upstream MCP servers. It logs every tool call, response, error, and loop — then lets you replay, inspect, and analyze them. It also implements progressive disclosure to cut schema token overhead by up to 50×.

And it is research infrastructure: every captured session is a structured, analyzable dataset for studying when and how AI agents hallucinate, misuse tools, and recover from failures.

---

## Origin

During the **MathWorks M3 competition**, I leaned on AI assistants for brainstorming and data lookup — only to discover, too late, that many of the "facts" and numerical results were hallucinated. The model produced confident, statistically formatted outputs. There was no way to inspect what it had actually done. Tool calls and data sources were opaque.

That frustration directly led to `flight-proxy`.

The M3 experience exposed a structural problem: AI systems producing confident but incorrect statements, with no ground-truth trace. Without a record of every tool call, response, and error, hallucinations can't be studied — they can only be discovered after the damage is done. `flight-proxy` is my attempt to build the missing instrumentation layer. It turns opaque agent runs into **structured, replayable, analyzable records** — the raw material for empirically studying agent behavior instead of treating failures as mysterious.

---

## What It Is

Two things in one:

**1. A developer debugging tool**
Drop-in STDIO proxy that records every JSON-RPC message between Claude Code and your MCP servers. When Claude claims it created a file that doesn't exist, you can see exactly what the model sent, what the server returned, and where the hallucination occurred.

**2. Research infrastructure**
Every session becomes a structured dataset with fields like `tool_name`, `hallucination_hint`, `latency_ms`, `error`, and `pd_active`. You can export sessions to CSV, filter for hallucination-hint events, and model tool-calling policies quantitatively — moving from anecdotal AI failures to empirical analysis.

---

## Quick Start

```bash
# Install
npm install -g flight-proxy

# Generate a ready-to-use Claude Desktop config snippet
flight init claude
# → writes snippet to ~/.flight/claude_desktop_config_snippet.json
# → add it to your claude_desktop_config.json under "mcpServers"

# Start a Claude Code session — Flight intercepts automatically
flight log tail
```

```
● Recording MCP traffic to ~/.flight/logs/session_20260315_142201.jsonl
  flight log view session_20260315_142201   ← inspect after session
  flight replay <call-id>                   ← replay any call

[14:22:03] ↑ Claude → filesystem/read_file("src/auth.ts")
[14:22:03] ↓ filesystem → OK (2,341 bytes, 1ms)
[14:22:05] ↑ Claude → github/create_pr(...)
[14:22:06] ↓ github → ERROR: base branch not found
[14:22:08] ⚠  HALLUCINATION HINT: Claude proceeded as if PR was created
```

---

## Core Workflows

### Debug a Hallucinated File Write
```bash
$ flight log tail
[14:02:11] ↑ Claude → write_file("auth.ts", ...)
[14:02:12] ↓ filesystem_mcp → ERROR: Permission denied
[14:02:14] ⚠  HALLUCINATION HINT: Claude proceeded as if successful

$ flight replay call_abc123
ERROR: Permission denied (path outside allowed directory)
```

### Cut Token Costs with Progressive Disclosure
```bash
# 50 tools loaded without PD = ~22,000 tokens per request
$ flight start --progressive-disclosure

✓ Progressive disclosure: ENABLED (PD v0 — single server)
✓ Estimated schema tokens: ~500 (was ~22,000)

$ flight stats
Session duration: 45min | Tool calls: 28
Tokens saved: ~600,000 (95% reduction) | Cost saved: ~$1.20
```

### Catch an Infinite Agent Loop
```bash
$ flight log view session_xyz
[1] ↑ query_database → 5,000 rows returned
[2] ↑ summarize     → model truncated JSON mid-response
[3] ↑ write_code    → wrong schema used, bug introduced
[4] ↑ run_tests     → failed
[5] ↑ query_database → same 5,000 rows again
⚠  Loop detected at call [6]: identical method + args as [1]
```

---

## CLI Reference

```bash
# Setup
flight init claude               # Generate claude_desktop_config.json snippet

# Logging
flight log list                  # List all sessions (ID, date, calls, errors, PD flag)
flight log tail                  # Live stream current session
flight log view <session>        # Paginated post-mortem timeline
flight log filter --tool <name>  # Filter by tool name
flight log filter --errors       # Show only failed calls
flight log filter --hallucinations  # Show calls with hallucination_hint: true
flight log gc                    # Garbage collect logs, show reclaimed space
flight log prune                 # Trim to retention policy

# Replay & analysis
flight replay <call-id>          # Re-execute a specific call
flight replay <call-id> --dry-run
flight stats                     # Session token + call summary
flight export <session> --format csv    # Export for Python/R/MATLAB analysis
flight export <session> --format jsonl  # Export clean JSONL
flight metrics summary           # Aggregate usage report across all sessions
```

---

## Research Use

Flight Proxy is designed as an instrumentation layer for empirical AI research. Each `.jsonl` session file is a structured dataset:

```json
{
  "session_id": "ses_abc123",
  "call_id": "call_7f2a",
  "timestamp": "2026-03-15T14:02:11.421Z",
  "direction": "server->client",
  "method": "tools/call",
  "tool_name": "write_file",
  "latency_ms": 12,
  "error": "Permission denied",
  "hallucination_hint": true,
  "pd_active": false,
  "schema_tokens_saved": 0
}
```

**What you can study:**

- **Hallucination rate by tool** — which tools produce the most hallucinated successes after server errors?
- **Tool-calling policy modeling** — how does the agent sequence tool calls? What predicts a loop?
- **Progressive disclosure effects** — does reducing schema token overhead change tool selection behavior?
- **Latency and error correlation** — do high-latency calls predict downstream hallucinations?

**Example: extract all hallucination hints from a session**
```bash
jq 'select(.hallucination_hint == true)' ~/.flight/logs/session_abc.jsonl
```

**Example: export for pandas**
```bash
flight export session_abc --format csv > session_abc.csv
python3 -c "
import pandas as pd
df = pd.read_csv('session_abc.csv')
print(df.groupby('tool_name')['hallucination_hint'].mean().sort_values(ascending=False))
"
```

**Example: session-level aggregate across all sessions**
```bash
flight metrics summary
# → tool call counts, error rates, PD adoption %, token savings distribution
```

---

## Features

| Feature | v0.1 MVP | v1.0 |
|---------|----------|------|
| Transparent STDIO proxy | ✅ | ✅ |
| `.jsonl` session logging (research-grade schema) | ✅ | ✅ |
| `flight log tail` / `flight log view` | ✅ | ✅ |
| `flight init claude` | ✅ | ✅ |
| Secret redaction (on by default) | ✅ | ✅ |
| CLI (filter, inspect, gc, prune) | — | ✅ |
| Replay functionality | — | ✅ |
| CSV/JSONL export for research | — | ✅ |
| Progressive disclosure (single-server PD v0) | — | ✅ |
| Token savings metrics | — | ✅ |
| Terminal UI (TUI) | — | ✅ |
| Log compression + lifecycle management | — | ✅ |
| `flight metrics summary` | — | ✅ |

---

## Log Storage

Defaults (all configurable):
- **Retention:** last 100 sessions or last 2GB compressed, whichever comes first
- **Compression:** sessions older than 1 day are gzip-compressed (~10× ratio)
- **Total cap:** 5GB. Flight warns in TUI at 80%, auto-prunes at cap.
- **Location:** `~/.flight/logs/<session_id>.jsonl` → `.jsonl.gz` after 1 day

```bash
flight log gc          # clean up now, show reclaimed space
flight log prune --max-sessions 50 --max-disk-mb 1000
```

---

## Performance

- **<5ms** added latency per tool call (streaming NDJSON, fire-and-forget log writes)
- **Backpressure-aware:** proxy never accumulates unbounded in-memory buffers
- **Disk-safe:** disables logging gracefully if free space drops below 100MB
- Sustains **1,000+ calls/session** and **10 MB/s** log throughput without proxy lag

---

## Related Work

| Tool | Terminal | Offline | Open Source | Token Optimization | Research-Grade Logs |
|------|----------|---------|-------------|-------------------|---------------------|
| **Flight Proxy** | ✅ | ✅ | ✅ | ✅ (PD v0) | ✅ |
| Reticle | ✅ | ✅ | ✅ | ❌ | ❌ |
| MCP Inspector | ❌ (browser) | ✅ | ✅ | ❌ | ❌ |
| AgentLens | ❌ | ❌ | ❌ | ❌ | ❌ |
| Langfuse/Moesif | ❌ | ❌ | Partial | ❌ | ❌ |

---

## Install

```bash
npm install -g flight-proxy
flight init claude
```

Requires Node.js 20+. No database, no cloud, no external dependencies.

---

## Documentation

- [`plan.md`](./plan.md) — implementation plan and phase breakdown
- [`flight-prd.md`](./flight-prd.md) — full product requirements document
- `ARCHITECTURE.md` — system diagram and JSON-RPC interception details *(coming Week 1)*
- `RESEARCH.md` — guide to using Flight Proxy as a research instrument *(coming Week 7)*

---

## License

MIT
