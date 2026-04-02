![CI](https://github.com/lewisnsmith/flight/actions/workflows/ci.yml/badge.svg)

# Flight

**Agent observability platform — structured tracing, audit, and replay for AI agent systems.**

Flight records everything your AI agents do: tool calls, decisions, evaluation scores, and outcomes. It works through multiple ingestion paths, supporting any agent framework:

```
┌──────────────────────────────────────────────────────────────────┐
│  Your Agent (Python, TypeScript, or any language)                │
│                                                                  │
│  ┌─────────────┐   ┌──────────────┐   ┌───────────────────────┐ │
│  │  Python SDK  │   │   TS SDK     │   │  Claude Code Hooks    │ │
│  │  (HTTP POST) │   │  (direct I/O)│   │  (PostToolUse, etc.)  │ │
│  └──────┬──────┘   └──────┬───────┘   └──────────┬────────────┘ │
│         │                  │                      │              │
└─────────┼──────────────────┼──────────────────────┼──────────────┘
          │                  │                      │
          ▼                  ▼                      ▼
   ┌─────────────┐    ~/.flight/logs/        <session>_tools.jsonl
   │ flight serve │         ▲
   │ (HTTP        │─────────┘          ┌───────────────┐
   │  collector)  │                    │ Flight Proxy   │──► session_*.jsonl
   └─────────────┘                    │ (MCP stdio)    │──► alerts.jsonl
                                      └───────┬───────┘
                                              │ stdio
                                              ▼
                                      ┌───────────────┐
                                      │ MCP Server     │
                                      └───────────────┘
```

**Four ingestion paths:**
- **TypeScript SDK** — `createFlightClient()` for direct logging from TS/JS agents
- **Python SDK** — `FlightClient` for Python agents, posts to the HTTP collector
- **HTTP Collector** — `flight serve` accepts NDJSON over HTTP from any language
- **MCP Proxy** — transparent stdio proxy for full JSON-RPC traffic recording
- **Claude Code Hooks** — captures all tool calls via Claude Code's hook system

Together, they produce structured, analyzable JSONL records of every action your agents take.

---

## Origin

During the **MathWorks M3 competition**, I leaned on AI assistants for brainstorming and data lookup — only to discover, too late, that many of the "facts" and numerical results were hallucinated. The model produced confident, statistically formatted outputs. There was no way to inspect what it had actually done.

That frustration directly led to Flight. It turns opaque agent runs into **structured, analyzable records** — the raw material for empirically studying agent behavior instead of treating failures as mysterious.

---

## Quick Start

### TypeScript SDK

```typescript
import { createFlightClient } from "flight-proxy";

const flight = await createFlightClient({
  runId: "experiment-42",
  agentId: "my-agent",
  modelConfig: { model: "claude-sonnet-4-20250514", provider: "anthropic" },
});

// Log tool calls, actions, and evaluations
flight.logToolCall("search_web", { query: "AAPL price" }, { price: 187.5 });
flight.logAction("buy_stock", "success", { ticker: "AAPL", quantity: 10 });
flight.logEvaluation(0.85, { task: "portfolio_rebalance" });

await flight.close();
```

### Python SDK

```bash
# Start the collector
flight serve --port 4242

# In your Python agent:
pip install flight-sdk  # or: pip install -e sdk/python/
```

```python
from flight_sdk import FlightClient, ModelConfig

with FlightClient(
    endpoint="http://localhost:4242",
    run_id="experiment-42",
    agent_id="my-agent",
    model_config=ModelConfig(model="llama-3-8b", quantization="gptq-4bit"),
) as flight:
    flight.log_tool_call("search_db", {"query": "SELECT *"}, {"rows": 42})
    flight.log_action("decide", "hold", {"reason": "insufficient data"})
    flight.log_evaluation(0.72, labels={"task": "data_analysis"})
```

### Claude Code Integration

```bash
# Install from source
git clone https://github.com/lewisnsmith/flight.git
cd flight && npm install && npm run build && npm link

# Interactive setup — installs hooks + optionally wraps MCP servers
flight claude setup

# Or step by step:
flight claude hooks install           # Record all tool calls via hooks
flight claude init code --apply       # Wrap MCP servers for full traffic recording

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

## Log Schema

Every `.jsonl` session file uses a flexible schema. Only `session_id`, `timestamp`, and `event_type` are required — all other fields are optional:

```json
{
  "session_id": "session_20260315_142201",
  "timestamp": "2026-03-15T14:02:11.421Z",
  "event_type": "tool_call",
  "call_id": "2",
  "direction": "server->client",
  "method": "tools/call",
  "tool_name": "write_file",
  "latency_ms": 12,
  "error": "Permission denied",
  "run_id": "experiment-42",
  "agent_id": "heuristic-agent-1",
  "model_config": { "model": "claude-sonnet-4-20250514", "provider": "anthropic" },
  "chosen_action": "write_config",
  "execution_outcome": "failure",
  "evaluator_score": 0.3,
  "labels": { "domain": "devops" },
  "metadata": { "retry_count": 2 }
}
```

**Event types:** `tool_call`, `tool_result`, `agent_action`, `evaluation`, `lifecycle`

---

## CLI Reference

```bash
# HTTP Collector
flight serve [--port 4242] [--log-dir ~/.flight/logs]

# MCP Proxy
flight proxy --cmd <server> -- <args>
flight proxy --cmd <server> --pd           # With progressive disclosure

# Log inspection
flight log list                     # List all sessions
flight log tail [--session <id>]    # Live stream a session
flight log view <session>           # Full timeline with summary
flight log filter --tool <name>     # Filter by tool name
flight log filter --errors          # Show only failed calls
flight log filter --hallucinations  # Show hallucination hints
flight log inspect <call-id>        # Full request/response payload
flight log alerts                   # Hallucination/loop/error alerts
flight log summary [--session <id>] # Session summary statistics
flight log tools                    # Tool call frequency breakdown
flight log stats                    # Usage statistics across sessions
flight log export --format csv      # Export session data as CSV
flight log export --format jsonl    # Export as JSONL
flight log replay <session>         # Replay tool calls from a session
flight log gc                       # Compress old sessions, collect garbage
flight log prune --before <date>    # Delete sessions before a date
flight log prune --keep <n>         # Keep only N most recent sessions

# Claude Code integration
flight claude setup                 # Interactive setup wizard
flight claude hooks install         # Install Claude Code hooks
flight claude hooks remove          # Remove hooks
flight claude init desktop          # Discover and wrap Claude Desktop MCP servers
flight claude init desktop --apply  # Apply directly (backs up original)
flight claude init code --apply     # Wrap Claude Code MCP servers
```

---

## Features

| Feature | Status |
|---------|:------:|
| TypeScript SDK (direct logging) | ✅ |
| Python SDK (HTTP client) | ✅ |
| HTTP collector (`flight serve`) | ✅ |
| MCP proxy (full JSON-RPC traffic) | ✅ |
| Claude Code hooks (all tool calls) | ✅ |
| `.jsonl` structured session logging | ✅ |
| Flexible schema (run_id, agent_id, model_config, etc.) | ✅ |
| Hallucination hint detection | ✅ |
| Secret redaction | ✅ |
| Progressive disclosure (token optimization) | ✅ |
| Replay functionality | ✅ |
| CSV/JSONL export | ✅ |
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

---

## Log Storage

- **Location:** `~/.flight/logs/<session_id>.jsonl`
- **One file per session**, append-only
- **Auto-compression:** sessions older than 24h are gzip-compressed (`.jsonl.gz`)
- **Garbage collection:** configurable max sessions (100) and max size (2 GB)
- **Pruning:** `flight log prune --before <date>` or `--keep <n>`

---

## Research Use

```python
import json, pathlib

entries = []
for line in pathlib.Path("~/.flight/logs/session_abc.jsonl").expanduser().read_text().splitlines():
    entries.append(json.loads(line))

errors = [e for e in entries if e.get("error")]
hints = [e for e in entries if e.get("hallucination_hint")]
actions = [e for e in entries if e.get("event_type") == "agent_action"]
evals = [e for e in entries if e.get("evaluator_score") is not None]

print(f"Calls: {len(entries)}, Errors: {len(errors)}, Actions: {len(actions)}, Evals: {len(evals)}")
```

**What you can study:**

- **Hallucination rate by tool** — which tools produce the most proceed-after-error patterns?
- **Agent decision quality** — correlate `chosen_action` with `execution_outcome` and `evaluator_score`
- **Model comparison** — compare `model_config` variants across runs using `run_id`
- **Multi-agent coordination** — trace `agent_id` interactions within shared sessions
- **Tool-calling policy modeling** — how does the agent sequence tool calls?

---

## Related Work

| Tool | Terminal | Offline | Open Source | Multi-Agent | Token Optimization | Research-Grade Logs |
|------|:--------:|:-------:|:-----------:|:-----------:|:-----------------:|:-------------------:|
| **Flight** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reticle | ✅ | ✅ | ✅ | — | — | — |
| MCP Inspector | — (browser) | ✅ | ✅ | — | — | — |
| Langfuse/Moesif | — | — | partial | partial | — | — |

---

## Install

```bash
git clone https://github.com/lewisnsmith/flight.git
cd flight && npm install && npm run build && npm link
```

Requires Node.js 20+. No database, no cloud, no external dependencies.

For the Python SDK:
```bash
pip install -e sdk/python/
```

---

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — internal architecture and design decisions
- [`docs/flight-prd.md`](./docs/flight-prd.md) — full product requirements document
- [`docs/plan.md`](./docs/plan.md) — sprint plan and roadmap
- [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) — iteration history

---

## License

MIT
