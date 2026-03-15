![CI](https://github.com/lewisnsmith/flight/actions/workflows/ci.yml/badge.svg)

# Flight Proxy

**A local MCP flight recorder and research instrument for AI coding agents.**

```
┌─────────────────┐
│  Claude Code     │
│  (MCP Client)    │
└────────┬─────────┘
         │ stdio
         ▼
┌─────────────────┐
│  Flight Proxy    │  ◄── Logs to .jsonl
│  - Intercept     │  ◄── Hallucination hints
│  - Record        │  ◄── Secret redaction
└────────┬─────────┘
         │ stdio
         ▼
┌─────────────────┐
│  MCP Server      │
│  (filesystem,    │
│   postgres, etc) │
└──────────────────┘
```

`flight-proxy` sits transparently between Claude Code (or any MCP client) and your upstream MCP servers. It logs every tool call, response, and error — then lets you inspect and analyze them from the terminal.

It is also research infrastructure: every captured session is a structured, analyzable dataset for studying when and how AI agents hallucinate, misuse tools, and recover from failures.

---

## Origin

During the **MathWorks M3 competition**, I leaned on AI assistants for brainstorming and data lookup — only to discover, too late, that many of the "facts" and numerical results were hallucinated. The model produced confident, statistically formatted outputs. There was no way to inspect what it had actually done. Tool calls and data sources were opaque.

That frustration directly led to `flight-proxy`.

The M3 experience exposed a structural problem: AI systems producing confident but incorrect statements, with no ground-truth trace. Without a record of every tool call, response, and error, hallucinations can't be studied — they can only be discovered after the damage is done. `flight-proxy` is my attempt to build the missing instrumentation layer. It turns opaque agent runs into **structured, analyzable records** — the raw material for empirically studying agent behavior instead of treating failures as mysterious.

---

## Quick Start

```bash
# Install from source
git clone https://github.com/lewisnsmith/flight.git
cd flight && npm install && npm run build && npm link

# Discover your existing MCP servers and wrap them with Flight
flight init claude
# → reads your claude_desktop_config.json
# → wraps each server with the Flight proxy
# → writes snippet to ~/.flight/claude_desktop_config_snippet.json

# Or apply directly (backs up your original config)
flight init claude --apply

# Start a Claude Code session — Flight intercepts automatically
# Then inspect what happened:
flight log tail
```

```
● Tailing session_20260315_142201 — ~/.flight/logs/session_20260315_142201.jsonl

[14:22:03] ↑ tools/call/read_file (5ms)
[14:22:05] ↑ tools/call/write_file ERROR: Permission denied
[14:22:08] ↑ tools/call/read_file ⚠ HALLUCINATION HINT
```

---

## Debug a Hallucinated File Write

Claude claims it created `auth.ts`, but the file doesn't exist:

```bash
$ flight log tail
[14:02:11] ↑ tools/call/write_file
[14:02:12] ↓ tools/call ERROR: Permission denied
[14:02:14] ↑ tools/call/read_file ⚠ HALLUCINATION HINT

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
# Setup
flight init claude                  # Discover and wrap existing MCP servers
flight init claude --apply          # Apply directly (backs up original)

# Proxy
flight proxy --cmd <server> -- <args>  # Run proxy manually

# Log inspection
flight log list                     # List all sessions (ID, date, calls, errors)
flight log tail [--session <id>]    # Live stream a session
flight log view <session>           # Full timeline with summary
flight log filter --tool <name>     # Filter by tool name
flight log filter --errors          # Show only failed calls
flight log filter --hallucinations  # Show hallucination hints
flight log inspect <call-id>        # Pretty-print full request/response payload
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

| Feature | v0.1 (current) | v1.0 (planned) |
|---------|:--------------:|:--------------:|
| Transparent STDIO proxy | ✅ | ✅ |
| `.jsonl` session logging | ✅ | ✅ |
| Hallucination hint detection | ✅ | ✅ |
| `flight init claude` (config discovery) | ✅ | ✅ |
| Secret redaction | ✅ | ✅ |
| `flight log` CLI (list, tail, view, filter, inspect) | ✅ | ✅ |
| Progressive disclosure (experimental, token optimization) | — | ✅ |
| Replay functionality | — | ✅ |
| CSV/JSONL export | — | ✅ |
| Token savings metrics | — | ✅ |
| TUI dashboard | — | ✅ |
| Log compression + lifecycle | — | ✅ |

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
- Planned for v1.0: automatic compression, retention policies, `flight log gc`

---

## Related Work

| Tool | Terminal | Offline | Open Source | Token Optimization | Research-Grade Logs |
|------|:--------:|:-------:|:-----------:|:-----------------:|:-------------------:|
| **Flight Proxy** | ✅ | ✅ | ✅ | planned | ✅ |
| Reticle | ✅ | ✅ | ✅ | — | — |
| MCP Inspector | — (browser) | ✅ | ✅ | — | — |
| Langfuse/Moesif | — | — | partial | — | — |

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
