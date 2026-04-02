# Flight Architecture

This document describes the internal architecture of Flight, an agent
observability platform that provides structured tracing, audit, and replay
for AI agent systems. Flight supports multiple ingestion paths: SDK imports,
HTTP collection, MCP proxy, and Claude Code hooks.

---

## 1. System Overview

```
 ┌─────────────────────────────────────────────────────────────────┐
 │  Agent Systems                                                  │
 │                                                                 │
 │  ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌────────────┐ │
 │  │ TS SDK   │  │ Python   │  │ Claude Code  │  │ MCP Proxy  │ │
 │  │ (direct) │  │ SDK      │  │ Hooks        │  │ (stdio)    │ │
 │  └────┬─────┘  └────┬─────┘  └──────┬───────┘  └─────┬──────┘ │
 └───────┼─────────────┼───────────────┼─────────────────┼────────┘
         │             │               │                 │
         │ file I/O    │ HTTP POST     │ file I/O        │ file I/O
         ▼             ▼               ▼                 ▼
     ┌─────────────────────────────────────────────────────────┐
     │                  ~/.flight/logs/                         │
     │                  session_*.jsonl                         │
     │                  alerts.jsonl                            │
     └─────────────────────────────────────────────────────────┘
                              ▲
                              │
                    ┌─────────┴──────────┐
                    │  flight serve       │
                    │  (HTTP collector)   │
                    │  POST /ingest       │
                    └────────────────────┘
```

Flight provides four ingestion paths, all writing to the same JSONL format:

- **TypeScript SDK** (`src/sdk.ts`) — wraps `createSessionLogger` for direct
  file-based logging from TS/JS agents. No network required.
- **Python SDK** (`sdk/python/`) — buffered HTTP client that posts NDJSON to
  the Flight collector. Zero external dependencies (stdlib only).
- **HTTP Collector** (`src/collector.ts`) — `flight serve` runs an HTTP server
  that accepts `POST /ingest` with NDJSON bodies, routing entries to per-session
  files. Enables any language to log via HTTP.
- **MCP Proxy** (`src/proxy.ts`) — transparent STDIO proxy between MCP client
  and server. Intercepts JSON-RPC traffic for logging, hallucination detection,
  and optional token optimization.
- **Claude Code Hooks** — `PostToolUse`, `SessionStart`, `SessionEnd` hooks
  installed via `flight claude setup`.

---

## 2. JSON-RPC Flow

Messages are newline-delimited JSON-RPC 2.0 objects. The parser
(`src/json-rpc.ts`) uses `readline` to split on newlines, then
`JSON.parse` each line. Parse errors emit an `"error"` event rather
than crashing the proxy.

### Client-to-Server Path

```
process.stdin
    |
    v
parseJsonRpcStream()          -- readline + JSON.parse per line
    |
    v
"message" event
    |
    +---> [PD Phase 3?] -----> intercept discover_tools call
    |         |                  - respond locally from cached schemas, no upstream call
    |         v
    +---> logger.log(msg, "client->server")
    |         |
    |         +---> hallucination hint check (did client proceed after error?)
    |         +---> loop detection (same tool+args 5x in 60s?)
    |
    +---> pendingClientRequests.set(id, msg)     -- track for latency + retry
    |
    v
upstream.stdin.write(JSON.stringify(msg) + "\n")
```

### Server-to-Client Path

```
upstream.stdout
    |
    v
parseJsonRpcStream()
    |
    v
"message" event
    |
    +---> [pending retry?] --> if retry also failed, forward original error
    |                         if retry succeeded, forward success
    |
    +---> [auto-retry?] ----> if read-only tool + transient error:
    |         hold response, resend after 500ms, track in pendingRetries
    |
    +---> [PD active?] -----> intercept tools/list response:
    |         cache real schemas, apply phase-appropriate transformation
    |         (compress schemas and/or filter tools), log token savings
    |
    +---> logger.log(msg, "server->client")
    |         |
    |         +---> compute latency (now - pendingRequests[id].timestamp)
    |         +---> track in recentResponses (for hallucination detection)
    |         +---> emit error alert if msg.error present
    |
    v
process.stdout.write(JSON.stringify(msg) + "\n")
```

### Upstream stderr

Captured via `upstream.stderr.on("data")`, logged as
`logError("upstream-stderr", text)`, and forwarded to the proxy's own
stderr when not in quiet mode.

---

## 3. Progressive Disclosure Algorithm

> **Note:** Progressive Disclosure is experimental and off by default. The mechanism works but has not been validated with real AI client sessions.

Progressive disclosure (PD) reduces token overhead by compressing tool
schemas and hiding rarely-used tools. It activates when `--pd` is passed
to the proxy and operates in three phases based on accumulated usage history.

### Three-Phase Design

```
Phase 1 — Observation (no history)
  All tools visible, schemas unmodified.
  Records tool call counts per session for future decisions.

Phase 2 — Schema Compression (1+ sessions of history)
  All tools still visible, but schemas compressed via compressSchema():
    - Strip property-level descriptions
    - Remove defaults, $comment, redundant additionalProperties
    - Preserve type, enum, required, structure
  Achieves 30-60% token reduction on typical schemas.

Phase 3 — Compression + Filtering (tools qualify for hiding)
  Schema compression applied (same as Phase 2).
  Tools unused for K+ sessions are hidden from tools/list.
  A `discover_tools` meta-tool is appended so the client can
  search for and re-discover hidden tools by keyword.
  Hidden tools are still forwarded transparently if called directly.
```

### Phase Determination

The phase is computed when `loadSchemas()` is called:

```
if no usage store or 0 sessions → Phase 1
else if any tool's (sessions - lastSessionUsed) >= threshold → Phase 3
else → Phase 2
```

The `historyThreshold` parameter (default: 3) controls how many sessions
of non-use qualify a tool for hiding.

### Activation Sequence

```
1. Client sends tools/list request
2. Proxy forwards to upstream
3. Upstream responds with { tools: [T1, T2, ..., Tn] }
4. Proxy intercepts response:
   a. Cache all N schemas in memory (Map<name, ToolSchema>)
   b. Apply phase logic:
      - Phase 1: return tools unmodified
      - Phase 2: return all tools with compressed schemas
      - Phase 3: return visible tools (compressed) + discover_tools
   c. Log token savings estimate
   d. Set logger.pdActive = true
5. Client receives the phase-appropriate tool list
```

### Meta-Tool: `discover_tools` (Phase 3 only)

| Field       | Description                                             |
|-------------|---------------------------------------------------------|
| Purpose     | Search cached schemas by keyword (name + description).  |
|             | Returns `[{ name, description }]` for matching hidden   |
|             | tools. No upstream call — answered from in-memory cache.|
| When added  | Only appended to tools/list in Phase 3, when at least   |
|             | one tool is hidden.                                     |

### Routing Logic (in proxy.ts)

```
Client calls tools/call with name="discover_tools"
  --> pdHandler.discoverTools(query)
  --> respond directly to client (no upstream round-trip)

Any other tools/call (including hidden tools)
  --> forward to upstream as normal
```

### Usage Tracking & Persistence

Each tool call is recorded via `recordToolCall(name, isError)`. At session
end, `flushUsage()` (async) or `flushUsageSync()` (signal handler path)
merges session counts into the persistent store at
`~/.flight/usage/<serverKey>.json`. Both paths delegate to the pure
`mergeSessionUsage()` function for the actual merge logic.

### Token Savings Estimation

Estimated via character count divided by 4:
`savedTokens = ceil(len(JSON(originalSchemas)) / 4) - ceil(len(JSON(responseSchemas)) / 4)`

Logged per-entry in the `schema_tokens_saved` field when PD rewrites occur.

---

## 4. TypeScript SDK

The TypeScript SDK (`src/sdk.ts`) provides `createFlightClient()` — a
programmatic API for agents to log events without a proxy. It wraps the
existing `createSessionLogger` infrastructure, constructing synthetic
JSON-RPC messages internally to reuse the write queue and file management.

```
createFlightClient(options)
    │
    ├── createSessionLogger(options)  ← reuses existing logger
    │       │
    │       └── write queue → appendFile → <session>.jsonl
    │
    ├── logToolCall(name, input, output, error)
    │       → 2 entries: tool_call (request) + tool_result (response)
    │
    ├── logAction(action, outcome, metadata)
    │       → 1 entry: agent_action
    │
    ├── logEvaluation(score, labels)
    │       → 1 entry: evaluation
    │
    └── close() / closeSync()
```

All entries are stamped with `run_id`, `agent_id`, and `model_config` if
provided at client creation.

---

## 5. HTTP Collector

The HTTP collector (`src/collector.ts`) runs as `flight serve` and accepts
log entries over HTTP, enabling language-agnostic ingestion.

```
POST /ingest                          GET /health
Content-Type: application/x-ndjson    → 200 { "status": "ok", "sessions": N }
Body: one LogEntry JSON per line
→ 200 { "accepted": N, "rejected": M }
```

Implementation details:
- Uses Node built-in `http.createServer` (no dependencies)
- Validates required fields (`session_id`, `timestamp`) per line
- Routes entries to per-session files based on `session_id`
- Batches writes per session within a single request
- 10MB body limit with streaming rejection
- CORS headers for browser-based agents
- Default port: 4242

---

## 6. Python SDK

The Python SDK (`sdk/python/flight_sdk/`) is a buffered HTTP client with
zero external dependencies (stdlib only: `urllib.request`, `json`,
`dataclasses`, `threading`).

```
FlightClient(endpoint, session_id, run_id, ...)
    │
    ├── log_tool_call() → buffer entry
    ├── log_action()    → buffer entry
    ├── log_evaluation() → buffer entry
    │
    ├── Timer thread (flush_interval=1s)
    │       └── POST /ingest → flight serve
    │
    └── flush() / close()
        └── POST remaining buffer
```

Buffering: entries accumulate in memory and flush every `flush_interval`
seconds or when the buffer reaches `flush_size` entries. On flush failure
(collector down), entries are re-buffered for the next attempt.

---

## 7. Log Schema Reference

Each line in a session `.jsonl` file is a `LogEntry`:

| Field                 | Type                              | Description                                                  |
|-----------------------|-----------------------------------|--------------------------------------------------------------|
| Field                 | Type                              | Required | Description                                           |
|-----------------------|-----------------------------------|:--------:|-------------------------------------------------------|
| `session_id`          | `string`                          | **yes**  | Unique session identifier                             |
| `timestamp`           | `string` (ISO 8601)               | **yes**  | Wall-clock time of log entry                          |
| `event_type`          | `string`                          | **yes**  | `tool_call`, `tool_result`, `agent_action`, `evaluation`, `lifecycle` |
| `call_id`             | `string?`                         |          | JSON-RPC `id` or random UUID                          |
| `latency_ms`          | `number?`                         |          | Round-trip latency for responses                      |
| `direction`           | `string?`                         |          | `"client->server"` or `"server->client"`              |
| `method`              | `string?`                         |          | JSON-RPC method, or `"response"` for replies          |
| `tool_name`           | `string?`                         |          | Extracted tool name for `tools/call` messages          |
| `payload`             | `unknown?`                        |          | Full message payload (redacted if configured)          |
| `error`               | `string?`                         |          | Error message if the response was an error             |
| `run_id`              | `string?`                         |          | Groups related sessions (e.g., an experiment run)      |
| `agent_id`            | `string?`                         |          | Identifies which agent in a multi-agent system         |
| `model_config`        | `object?`                         |          | Model, quantization, provider, temperature             |
| `chosen_action`       | `string?`                         |          | The action the agent decided to take                   |
| `execution_outcome`   | `string?`                         |          | Result classification (success, failure, partial)      |
| `evaluator_score`     | `number?`                         |          | Score from an evaluation function                      |
| `labels`              | `Record<string,string>?`          |          | Post-hoc labels for analysis                           |
| `metadata`            | `Record<string,unknown>?`         |          | Arbitrary extra context                                |
| `hallucination_hint`  | `boolean?`                        |          | True if client proceeded after error without retrying  |
| `pd_active`           | `boolean?`                        |          | Whether progressive disclosure was active              |
| `schema_tokens_saved` | `number?`                         |          | Estimated tokens saved by PD                           |

### Alert Entries (alerts.jsonl)

Alerts are also appended to `~/.flight/alerts.jsonl`:

| Field        | Type                                      | Description                       |
|--------------|-------------------------------------------|-----------------------------------|
| `timestamp`  | `string` (ISO 8601)                       | When the alert fired              |
| `severity`   | `"error" \| "hallucination" \| "loop"`    | Alert classification              |
| `method`     | `string`                                  | JSON-RPC method                   |
| `tool_name`  | `string?`                                 | Tool name if applicable           |
| `message`    | `string`                                  | Human-readable alert description  |
| `session_id` | `string`                                  | Originating session               |
| `call_id`    | `string`                                  | Originating call                  |

---

## 8. Alert System

The proxy emits three types of real-time alerts, written to
`~/.flight/alerts.jsonl` and optionally displayed on stderr.

### Hallucination Hints

**Trigger:** The client sends a `tools/call` request for tool B immediately
after receiving an error response for tool A (different tool, within 30
seconds). This pattern suggests the agent treated a failed call as successful.

```
server->client: tools/call/write_file ERROR
client->server: tools/call/read_file        <-- hallucination hint
                (different tool, no retry)
```

If the client retries the *same* tool, no hint is emitted -- that is
legitimate error recovery.

**Limitation:** This is a heuristic. It does not catch fabricated data in
successful responses, incorrect arguments that happen to succeed, or
reasoning hallucinations that bypass tool calls.

### Loop Detection

**Trigger:** The same tool is called with identical arguments 5 or more
times within a 60-second window. Tracked via a hash of
`toolName + JSON.stringify(arguments)`.

The alert fires exactly once at the threshold (5th occurrence), not on
every subsequent call.

### Error Alerts

**Trigger:** Any `server->client` response containing an `error` field.
Every tool error is recorded as an alert for cross-session querying
via `flight log alerts`.

### Auto-Retry (Transparent)

For read-only tools (`read_file`, `list_dir`, `search`, `get_*`, etc.)
that fail with a transient error (not `-32601`, `-32602`, or `-32600`),
the proxy automatically retries once after 500ms. The client never sees
the initial failure if the retry succeeds. Both the original error and
retry result are logged.

---

## 9. Log Lifecycle

```
Active session
    |
    v
~/.flight/logs/session_*.jsonl       <-- append-only, NDJSON
    |
    | (after 24h default, or --compress-after)
    v
flight log gc --compress-after 24
    |
    v
session_*.jsonl.gz                   <-- gzip compressed, original deleted
    |
    | (when count > --max-sessions or total > --max-bytes)
    v
Oldest sessions deleted (FIFO)
```

### Compression (`compressOldSessions`)

- Scans `~/.flight/logs/` for `.jsonl` files with mtime older than threshold
- Streams each through `zlib.createGzip()` to `.jsonl.gz`
- Deletes the original `.jsonl` after successful compression

### Garbage Collection (`garbageCollect`)

- Default limits: 100 sessions max, 2 GB total
- Sorts by mtime ascending (oldest first)
- Deletes oldest files until both count and size are under limits
- Supports `--dry-run` to preview without deleting

### Pruning (`pruneSessions`)

- `--before <date>`: delete sessions with mtime before the given date
- `--keep <n>`: keep only the N most recent sessions, delete the rest
- Both options can be combined

### Per-Session Safety Limits

| Limit            | Value   | Behavior on breach                         |
|------------------|---------|--------------------------------------------|
| Write queue depth| 1,000   | Drops entry with stderr warning            |
| Session log size | 50 MB   | Disables logging for remainder of session  |
| Disk space       | 100 MB  | Disables logging entirely at session start |

---

## 10. Key Design Decisions

### Why STDIO (not HTTP)

MCP's transport layer is STDIO-based: the client spawns a server process and
communicates via stdin/stdout. Flight inserts itself into this pipe by being
the command the client spawns, then spawning the real server as a child
process. This requires zero network configuration, zero port management, and
works identically across platforms. HTTP would add connection management,
CORS, and port conflicts for no benefit in a local single-client scenario.

### Why NDJSON

Each log line is a self-contained JSON object terminated by `\n`. This
format is:

- **Append-only safe:** No need to maintain a valid JSON array wrapper.
  A crash mid-write corrupts at most one line.
- **Streamable:** `jq`, `grep`, `tail -f`, and Python's `readline()` all
  work natively. No custom parser required for downstream analysis.
- **Compressible:** gzip operates well on repetitive JSON text; `.jsonl.gz`
  files are typically 10-20x smaller than raw.

### Why async write queue with backpressure

Log writes must never block the proxy's message forwarding path. The
implementation uses:

1. **In-memory queue** (`writeQueue: string[]`): entries are enqueued
   synchronously during message handling.
2. **Periodic flush** (`setInterval` at 100ms): batches all queued entries
   into a single `appendFile` call, amortizing syscall overhead.
3. **Backpressure cap** (1,000 entries): if the queue fills (disk I/O
   stalled), new entries are dropped with a stderr warning rather than
   growing memory unboundedly.
4. **Size cap** (50 MB per session): prevents a runaway session from
   filling disk.
5. **Disk space check** (100 MB minimum): checked once at session start
   via `statfs`. If disk is low, logging is disabled entirely -- the
   proxy continues to function as a transparent pipe.

This design ensures the proxy adds <5ms latency per message and never
stalls or crashes due to I/O pressure.

### Why fire-and-forget alerts

Alert entries are written to `~/.flight/alerts.jsonl` via
`appendFile(...).catch(() => {})`. Alert writes are intentionally
best-effort: a failed alert write must never interrupt message proxying.
Alerts are a secondary signal for cross-session triage, not a critical
data path.

### Why redirect console to stderr

The proxy overrides `console.log`, `console.warn`, and `console.error` to
write to `process.stderr` at startup. This prevents any diagnostic output
from contaminating the stdout JSON-RPC stream between client and server,
which would cause parse errors on both sides.
