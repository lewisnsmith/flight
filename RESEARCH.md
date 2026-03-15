# Flight Proxy: Research Guide

This document covers how to use Flight Proxy as a data collection instrument for studying AI agent behavior, tool-calling patterns, and hallucination mechanisms. It is written for researchers, not just developers -- the emphasis is on what the data can and cannot tell you.

---

## 1. Using Flight as a Data Collection Instrument

Flight Proxy intercepts all JSON-RPC traffic between an MCP client (e.g., Claude Code) and upstream MCP servers. Every tool call, response, error, and stderr message is logged to append-only `.jsonl` files at `~/.flight/logs/`.

### Setup for data collection

```bash
# Install
git clone https://github.com/lewisnsmith/flight.git
cd flight && npm install && npm run build && npm link

# Wrap your existing MCP servers
flight init claude --apply
# This backs up your original config and inserts Flight as a transparent proxy.
# No changes to your workflow -- Claude Code talks to Flight, Flight talks to the MCP server.
```

Once configured, every Claude Code session automatically produces a structured log file. No manual recording step is needed.

### What gets captured

Each proxied JSON-RPC message produces a log entry containing:

- Full request/response payloads (tool name, arguments, results, errors)
- Timestamps and computed latency for request-response pairs
- Session and call identifiers for grouping
- Heuristic flags: `hallucination_hint`, loop detection alerts
- Progressive disclosure state (`pd_active`, `schema_tokens_saved`)
- Inline stderr from crashed or misbehaving MCP servers

### What does NOT get captured

- Client-side reasoning (the model's internal chain of thought)
- Content correctness (Flight cannot tell if a successful response contains wrong data)
- Interactions that bypass tools entirely (e.g., the model fabricating an answer from memory)
- Network-level details (Flight operates at the STDIO/JSON-RPC layer, not HTTP)

### Data volume

A typical 10-call session produces roughly 500KB of raw JSONL. Sessions are capped at 50MB each to prevent runaway logs. If free disk space drops below 100MB, logging is disabled automatically rather than crashing the proxy.

---

## 2. Log Schema for Analysis

Each line in a session log file is a JSON object conforming to the `LogEntry` interface:

| Field | Type | Description | Research notes |
|-------|------|-------------|----------------|
| `session_id` | string | Unique session identifier (format: `session_YYYYMMDD_HHMMSS_<8-char-uuid>`) | Use for grouping and session-level aggregation. |
| `call_id` | string | Unique call identifier (from JSON-RPC `id` or generated UUID) | Use for matching request-response pairs. |
| `timestamp` | string (ISO 8601) | When the message was logged | Enables time-series analysis of tool-calling sequences. |
| `latency_ms` | number | Round-trip time for request-response pairs (0 for outbound requests) | Only populated on `server->client` responses. Useful for performance studies and detecting slow tools. |
| `direction` | `"client->server"` or `"server->client"` | Which direction the message was traveling | Filter to `client->server` for agent decisions, `server->client` for tool outcomes. |
| `method` | string | JSON-RPC method (e.g., `tools/call`, `tools/list`, `response`) | Core field for categorizing interaction types. |
| `tool_name` | string or undefined | Extracted tool name from `tools/call` params | Present only for tool-call-related messages. |
| `payload` | object | Full JSON-RPC message (request or response body) | Contains arguments, results, error details. Omitted by default in JSONL export unless `--include-payload` is passed. |
| `error` | string or undefined | Error message if the response was an error | `undefined` for successful calls. |
| `hallucination_hint` | boolean or undefined | True if the agent proceeded after a tool error without retrying | See Section 5 for how this heuristic works and its limitations. |
| `pd_active` | boolean | Whether progressive disclosure was enabled for this call | Essential for A/B comparisons of token optimization. |
| `schema_tokens_saved` | number or undefined | Estimated tokens saved by progressive disclosure on this call | Only present when PD is active and a tool listing was served from the meta-tool. |

### Alert log

Separate from session logs, Flight writes an alert log at `~/.flight/alerts.jsonl` with entries for errors, hallucination hints, and loop detections. Each alert entry contains:

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | string | ISO 8601 timestamp |
| `severity` | `"error"`, `"hallucination"`, or `"loop"` | Alert category |
| `method` | string | JSON-RPC method that triggered the alert |
| `tool_name` | string or undefined | Tool involved, if applicable |
| `message` | string | Human-readable description |
| `session_id` | string | Session where the alert occurred |
| `call_id` | string | Specific call that triggered the alert |

---

## 3. Export Formats

Flight supports two export formats via the `flight export` command.

### CSV

```bash
flight export <session-id> --format csv --output ./data/session.csv
```

**Columns exported:** `session_id`, `call_id`, `timestamp`, `direction`, `method`, `tool_name`, `latency_ms`, `error`, `hallucination_hint`, `pd_active`

**When to use CSV:**
- Loading into spreadsheet tools, R, MATLAB, or pandas for tabular analysis
- When you need a flat structure and do not need the full request/response payloads
- Quick exploratory analysis or visualization

**Limitations:** The `payload` and `schema_tokens_saved` fields are not included in CSV output. If you need payload data, use JSONL.

### JSONL

```bash
flight export <session-id> --format jsonl --output ./data/session.jsonl
flight export <session-id> --format jsonl --include-payload --output ./data/session_full.jsonl
```

**When to use JSONL:**
- When you need the full request/response payloads for content analysis
- When you want to preserve the complete data structure for programmatic processing
- When building pipelines in Python or similar (one `json.loads()` per line)

By default, JSONL export strips the `payload` field to reduce file size. Pass `--include-payload` to retain it.

### Filtering options (available for both formats)

| Flag | Effect |
|------|--------|
| `--tool <name>` | Include only entries where `tool_name` matches or `method` contains the given name |
| `--errors` | Include only entries with a non-empty `error` field |
| `--hallucinations` | Include only entries where `hallucination_hint` is true |

Filters can be combined. If no session ID is provided, the most recent session is used.

### Direct analysis (without export)

You can also work with the raw `.jsonl` files directly:

```bash
# Extract all hallucination hints across sessions
jq 'select(.hallucination_hint == true)' ~/.flight/logs/session_*.jsonl

# Count errors per tool
jq -r 'select(.error) | .tool_name // "unknown"' ~/.flight/logs/session_*.jsonl | sort | uniq -c | sort -rn
```

---

## 4. Progressive Disclosure Research

Progressive disclosure (PD) is Flight's token optimization layer. Instead of sending all tool schemas upfront, it exposes a single meta-tool that lets the agent discover tools on demand. This can reduce schema token overhead by 10-50x for large toolsets.

> **Caveat:** PD savings scale with schema verbosity: ~2x for minimal schemas, ~10x for verbose real-world schemas (e.g., Supabase), ~37x at 50 tools. The synthetic validation shows identical success rates with PD on/off, but real AI clients may behave differently since they must use discover_tools before execute_tool.

### Measuring token savings

The `schema_tokens_saved` field on each log entry records the estimated token reduction when PD serves a tool listing from the meta-tool instead of including the full schema. Use `flight stats` for per-session summaries:

```bash
flight stats <session-id>
# Output includes: total tokens saved, per-tool breakdown, PD active status
```

For aggregate analysis across sessions:

```bash
flight stats --all
# Shows: session count, total calls, total errors, PD session count, total tokens saved
```

### Setting up A/B comparisons

To compare agent behavior with and without PD:

1. **Passthrough sessions (control):** Run Flight with PD disabled (the default). The `pd_active` field will be `false` for all entries.
2. **PD sessions (treatment):** Run Flight with `--pd` enabled. The `pd_active` field will be `true`.
3. **Export and compare:**

```bash
# Export control sessions
flight export <control-session> --format csv --output control.csv

# Export treatment sessions
flight export <pd-session> --format csv --output treatment.csv
```

### Metrics to track

- **Token savings:** `schema_tokens_saved` per call and per session (from `flight stats`)
- **Task completion rate:** Does PD change whether the agent successfully completes tasks?
- **Tool discovery patterns:** With PD, how does the agent sequence its `tools/list` calls? Does it explore or exploit?
- **Error rate:** Compare `errors` count between PD and non-PD sessions
- **Latency:** Compare `latency_ms` distributions -- PD adds one extra round-trip for tool discovery

### Limitations of PD measurement

- Token savings are estimates, not exact counts (based on schema size heuristics)
- PD is currently single-server only -- it wraps one MCP server at a time
- The meta-tool pattern changes agent behavior in ways beyond token reduction (the agent must explicitly discover tools, which may alter its planning)

---

## 5. Hallucination Detection

### How the heuristic works

Flight's `hallucination_hint` flag detects a specific pattern: the agent receives an error response from a `tools/call` request, and within 30 seconds, issues a *different* `tools/call` request instead of retrying the failed one.

The logic, step by step:

1. Flight tracks the most recent server response (up to 10 responses buffered).
2. When a new `tools/call` request arrives from the client, Flight checks: was the last response an error on a `tools/call`?
3. If yes, and the new request is within the 30-second window (`HALLUCINATION_WINDOW_MS`), Flight checks whether the new call targets the *same* tool as the failed one.
4. If the tool name differs (i.e., the agent moved on instead of retrying), `hallucination_hint` is set to `true`.

This detects the "proceed without retry" pattern -- when the agent appears to ignore a failure and continue as if the tool call succeeded.

### What it catches

- Agent claims it wrote a file, but `write_file` returned "Permission denied" and the agent moved on to a different tool
- Agent claims it queried a database, but the query errored and the agent proceeded with fabricated results
- Any case where a tool error is followed by a different tool call within 30 seconds

### What it does NOT catch

- **Content hallucinations:** The tool call succeeded, but the agent misinterprets or fabricates information from the response. Flight has no ground truth to compare against.
- **Reasoning hallucinations:** The agent generates incorrect information without making any tool call at all. Flight only sees tool traffic.
- **Wrong-but-successful calls:** The agent calls a tool with incorrect arguments, but the tool returns a valid (though wrong) response.
- **Delayed hallucinations:** If the agent waits longer than 30 seconds before proceeding, the window expires and no hint is generated.
- **Non-tool-call methods:** The heuristic only fires on `tools/call` requests. Errors on `resources/list` or other methods are not tracked for hallucination hints.

### False positive scenarios

- **Intentional fallback:** The agent tries tool A, it fails, and the agent deliberately falls back to tool B as a valid alternative strategy. This is flagged as a hallucination hint even though the agent is behaving correctly.
- **Unrelated sequential calls:** The agent was going to call tool B regardless of whether tool A succeeded. The temporal proximity triggers the heuristic.
- **Partial success:** Tool A partially succeeded (returned an error message but also some data), and the agent reasonably moves on.

### Recommendations for researchers

Treat `hallucination_hint` as a filter for manual review, not as a classifier. The flag has reasonable precision for the specific "proceed after error" pattern, but unknown recall for hallucinations in general. Always inspect the `payload` of flagged entries to determine whether the agent actually hallucinated.

---

## 6. Loop Detection

### How it works

Flight tracks tool calls by tool name and argument hash. If the same tool is called with the same arguments 5 or more times within a 60-second window, a loop alert is generated.

Specifically:

1. For each `tools/call` request, Flight computes a key: `toolName:JSON.stringify(arguments)`.
2. It maintains a sliding window of timestamps for each key.
3. Timestamps older than 60 seconds are pruned on each check.
4. When the count reaches exactly 5, an alert with severity `"loop"` is written to `~/.flight/alerts.jsonl` and emitted to any registered alert handler.

The alert fires once at the threshold (5 calls). If the agent continues looping beyond 5 calls, no additional alerts are generated for that key.

### What it catches

- Agent stuck retrying a failing tool with identical arguments
- Polling loops where the agent repeatedly reads the same resource
- Copy-paste patterns where the agent re-executes the same command

### What it misses

- **Loops with varying arguments:** If the agent calls the same tool but with slightly different arguments each time, the hash changes and no loop is detected.
- **Cross-tool loops:** If the agent alternates between two tools in a cycle (A, B, A, B, ...), each tool's individual count may stay below the threshold.
- **Slow loops:** If the agent spaces calls more than 60 seconds apart, the sliding window prunes earlier timestamps and the count never reaches 5.
- **Legitimate repetition:** Some tools are meant to be called repeatedly (e.g., `list_files` in different directories). The heuristic has no way to distinguish productive repetition from stuck loops.

---

## 7. Known Limitations

### Transport

- **STDIO only.** Flight proxies STDIO-based MCP servers. HTTP/SSE MCP transports are not supported.

### Progressive disclosure

- **Single-server PD.** Progressive disclosure wraps one MCP server at a time. Cross-server tool discovery is not coordinated.

### Detection heuristics

- **Hallucination detection is behavioral, not semantic.** It flags a specific interaction pattern (proceed after error), not content correctness. It cannot detect fabricated data in successful responses.
- **30-second window is arbitrary.** The `HALLUCINATION_WINDOW_MS` constant is a tuning parameter, not derived from empirical data. Different agent workflows may need different windows.
- **Loop detection uses exact argument matching.** Minor variations in arguments (whitespace, ordering) produce different hashes and evade detection.
- **No content analysis.** Flight does not parse or evaluate the content of tool responses. It cannot determine whether a response is factually correct.

### Logging

- **50MB per-session cap.** Long sessions with large payloads may hit the cap, after which logging is silently disabled for that session.
- **No log compression in current version.** Compression and lifecycle management are planned for v1.0 but not yet implemented.
- **Redaction is pattern-based.** Secret redaction uses string matching on configured environment variables and regex patterns. It may miss secrets that do not match configured patterns.

### Scope

- **Agent-side only.** Flight sees the wire protocol between client and server. It cannot observe the model's reasoning process, prompt construction, or internal state.
- **No causal claims.** Correlation between tool errors and subsequent behavior does not establish that the agent "hallucinated." The `hallucination_hint` flag is a starting point for investigation, not a diagnosis.

---

## 8. Suggested Research Questions

The following are research questions that Flight data is well-positioned to help answer. Each includes notes on which fields and methods are relevant.

1. **What is the proceed-after-error rate across different tools and MCP servers?**
   Filter on `hallucination_hint == true`, group by `tool_name`. Compare rates across server types (filesystem, database, API). This measures how often agents ignore failures, though not whether they actually hallucinate content.

2. **Does progressive disclosure change tool-calling patterns?**
   Compare sessions with `pd_active == true` vs `pd_active == false`. Look at: number of distinct tools used, tool discovery order, total calls per session, error rates. PD forces explicit discovery, which may alter exploration behavior.

3. **How does tool latency correlate with agent error recovery?**
   Use `latency_ms` on responses paired with subsequent `hallucination_hint` flags. Do agents handle slow-responding tools differently than fast-failing ones? High latency may cause the agent to "move on" more readily.

4. **What tool-calling sequences precede failures?**
   Extract ordered sequences of `(tool_name, direction, error)` tuples per session. Look for common prefixes or patterns that predict downstream errors. This is feasible with the timestamp and session_id fields.

5. **How effective is the 5-call/60-second loop threshold?**
   Export all sessions and compute, for each tool+args key, the actual count and time distribution. Is 5 calls the right threshold? Do real loops cluster at different counts? This could inform better default parameters.

6. **What is the token cost distribution across tool schemas, and how much does PD reduce it?**
   Aggregate `schema_tokens_saved` across PD sessions. Compare against estimated total schema tokens for the same server without PD. This requires knowing the baseline schema size, which can be captured from `tools/list` responses in passthrough mode.

7. **Do agents retry differently based on error type?**
   Categorize errors from the `error` field (permission denied, not found, timeout, etc.) and measure retry rates for each category. The hallucination hint logic already distinguishes retry (same tool) from proceed (different tool).

8. **How do stderr crashes differ from JSON-RPC errors in their downstream effects?**
   Flight captures both structured JSON-RPC errors and raw stderr output from crashed MCP servers. Compare agent behavior after each type. Stderr crashes may be harder for agents to interpret.

9. **Can tool-calling policy be modeled from trace data?**
   Use session logs as sequential decision data: at each step, the agent observes the last response and chooses the next tool call. This is a candidate for Markov chain or reinforcement learning analysis of tool-calling policy.

10. **What fraction of agent sessions exhibit at least one hallucination-pattern event?**
    A basic prevalence estimate: across N sessions, how many contain at least one `hallucination_hint == true` entry? Stratify by session length, tool count, and PD status. This gives a baseline rate for the detectable pattern, acknowledging it underestimates total hallucination incidence.
