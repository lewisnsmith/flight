# Flight Proxy FAQ

## What is Flight?

Flight is a local MCP flight recorder. It sits as a transparent proxy between an MCP client (such as Claude Code or Claude Desktop) and your MCP servers. It records every JSON-RPC message -- tool calls, responses, and errors -- into structured JSONL session logs for inspection and analysis.

## How does Flight differ from using MCP servers directly?

Flight does not change MCP behavior. It forwards every message between client and server unmodified. The only difference is that messages are logged as they pass through. Your MCP servers work exactly the same way, and the client cannot tell Flight is present. The proxy is fully transparent.

## Does Flight slow down my MCP server?

No. Flight adds less than 5ms of latency per tool call. Log writes are fire-and-forget using an async write queue, so they never block the proxy path. Benchmarks show sustained throughput above 40,000 calls per second.

## Where are logs stored?

All session logs are stored locally at:

```
~/.flight/logs/<session_id>.jsonl
```

Each session produces one append-only JSONL file. You can list sessions with `flight log list` and inspect them with `flight log view <session>` or `flight log inspect <call-id>`.

## How do I set it up with Claude Desktop?

Run the init command to discover and wrap your existing MCP servers:

```bash
flight init claude           # generates a config snippet
flight init claude --apply   # applies directly (backs up your original config)
```

This reads your `claude_desktop_config.json`, wraps each server command with the Flight proxy, and writes the updated configuration.

## How do I set it up with Claude Code?

Use the setup command to install Flight as a Claude Code hook:

```bash
flight setup
```

This integrates Flight into Claude Code's hook system so that MCP traffic is automatically recorded during sessions.

## What is Progressive Disclosure?

Progressive Disclosure is a token optimization feature. Instead of sending full tool responses to the client immediately, Flight can send a compact summary first and only provide the full payload if the client requests it. This reduces token consumption for large responses while preserving access to the complete data. PD is currently experimental and off by default. Enable it with the `--pd` flag on `flight proxy`.

## How do I export session data for analysis?

Use the export command to extract session data in CSV or JSONL format:

```bash
flight log export --format csv --session <session_id> > output.csv
flight log export --format jsonl --session <session_id> > output.jsonl
```

You can also work with the raw JSONL files directly using `jq`, Python, or any tool that reads newline-delimited JSON.

## Is my data safe?

Yes. All data stays on your local machine. Flight never sends data to any external service. Session logs are plain files on disk under `~/.flight/logs/`. Flight also includes secret redaction support, which can automatically strip sensitive values (API keys, tokens, passwords) from log entries before they are written to disk.

## How do I detect hallucinations?

Flight includes a heuristic hallucination hint detector. It flags cases where the client proceeds after a server error without retrying -- a pattern that often indicates the agent is operating on assumptions rather than real data. View flagged entries with:

```bash
flight log filter --hallucinations
```

These hints are investigative leads, not definitive verdicts. They tell you where to look, not what happened.
