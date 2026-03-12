# Flight v1.0 Feature Design

## Overview

Four features that make Flight simpler, more integrated with Claude Code, and useful for reducing token waste and debugging overhead.

---

## Feature 1: Progressive Disclosure (PD)

### Problem
Every MCP `tools/list` response sends full JSON schemas for all tools. Claude receives and processes these schemas on every session, burning tokens on redundant data.

### Design

Flight intercepts `tools/list` responses and replaces full schemas with two lightweight meta-tools:

**`discover_tools`** — keyword search against cached schemas
- Input: `{ query: string }`
- Returns: matching tool names + one-line descriptions (no full input schemas)
- Search is fuzzy over tool names and descriptions

**`execute_tool`** — translates to a real `tools/call`
- Input: `{ tool_name: string, arguments: object }`
- Flight looks up the tool in its cache, constructs a real `tools/call` JSON-RPC request
- Remaps call IDs so the upstream response correlates back to the original `execute_tool` request
- Forwards the real response back to Claude

**Schema caching:**
- On first `tools/list` response, cache full schemas to `~/.flight/schemas/<server-fingerprint>.json`
- Cache invalidation: re-fetch on proxy startup if cache is older than 24 hours, or on `tools/list` hash mismatch
- `pd_active` field in log entries (already exists, currently hardcoded `false`) set to `true` when PD is active

**Token metrics:**
- Each log entry gets `schema_tokens_saved: number` (estimated: character count / 4)
- `flight stats <session>` computes total tokens saved, per-tool breakdown
- `flight stats` (no session) shows aggregate across recent sessions

**Safety gate:**
- If Claude's task completion degrades >20% vs passthrough in manual testing, pivot to category-based subsets (group tools by domain, expose categories first)
- PD can be disabled per-session: `flight proxy --no-pd`
- CLI flag `--pd` to explicitly enable (off by default until validated)

### Files to create/modify
- `src/progressive-disclosure.ts` — schema cache, discover_tools/execute_tool logic, call-ID remapping
- `src/proxy.ts` — intercept `tools/list` responses, delegate to PD module
- `src/logger.ts` — set `pd_active`, compute `schema_tokens_saved`
- `src/cli.ts` — add `--pd` and `--no-pd` flags, add `flight stats` command
- `src/stats.ts` — token savings computation from log files

---

## Feature 2: Zero-Config Setup (`flight setup`)

### Problem
Current setup requires multiple steps: clone, build, link, run `flight init claude-code --apply`. Users must understand MCP config wrapping.

### Design

**One command: `flight setup`**

This command:
1. Detects Claude Code installation (checks for `~/.claude/settings.json`)
2. Wraps existing MCP server configs with Flight proxy (existing `wrapWithFlight` logic)
3. Installs Claude Code hooks for session lifecycle:
   - `SessionStart` hook: initializes a flight session, prints session ID to stderr
   - `SessionEnd` hook: triggers `flight log summary` for the completed session, runs auto-cleanup
4. Backs up original configs before any changes
5. Prints a summary of what was configured

**Hook integration (complements proxy, doesn't replace it):**

```json
// Installed into ~/.claude/settings.json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "flight hook session-start"
      }]
    }],
    "SessionEnd": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "flight hook session-end"
      }]
    }]
  }
}
```

- `flight hook session-start` — creates session log file, outputs session ID to stderr
- `flight hook session-end` — reads stdin for session_id, generates summary, triggers gc if needed

**Why both proxy AND hooks:**
- STDIO proxy: bidirectional JSON-RPC interception, latency tracking, hallucination detection, PD
- Hooks: session lifecycle management, auto-summary, cleanup triggers
- Hooks cannot replace the proxy — they don't capture raw MCP traffic or support `tools/list` interception

**Uninstall:** `flight setup --remove` reverses all changes, restores backups.

**Future:** Document that if Claude Code ships an extension/plugin API, Flight could migrate to that for even deeper integration. For now, proxy + hooks is the right approach.

### Files to create/modify
- `src/setup.ts` — setup orchestration (detect, wrap, install hooks, backup/restore)
- `src/hooks.ts` — `flight hook session-start` and `flight hook session-end` implementations
- `src/cli.ts` — add `flight setup` and `flight hook` commands
- `src/init.ts` — refactor shared logic used by both `init` and `setup`

---

## Feature 3: Inline Alerts + Smart Summary

### Problem
Users can't see problems during a session without running `flight log tail` in a separate terminal. After a session, there's no quick way to assess what happened.

### Design

**Inline alerts (during session):**

Flight proxy writes warnings to stderr when it detects problems:
```
[flight] hallucination hint: read_file after write_file error (call #7)
[flight] retry triggered: read_file (attempt 2/2)
[flight] loop detected: read_file called 5x with same args in 60s
```

- Alerts go to stderr (not stdout) so they don't interfere with MCP STDIO protocol
- Controlled by `--quiet` flag (already exists, currently unused) — suppresses inline alerts
- Loop detection: new heuristic — same tool + same argument hash called N times (default 5) within a window (default 60s)

**Smart summary (`flight log summary`):**

```
Session: session_20260315_142201 (14 min 23s)
  Calls: 47  |  Errors: 3  |  Retries: 2  |  Hallucination hints: 1
  Top tools: read_file (22), write_file (11), list_dir (8)
  Token savings: ~12,400 tokens saved (PD active)
  Timeline: [===========x===x=====!======]
            x = error, ! = hallucination hint
  Alerts:
    14:22:08  hallucination hint — read_file after write_file error
    14:25:31  retry success — read_file recovered on attempt 2
```

- Works on completed and in-progress sessions
- `flight log summary` (no args) shows latest session
- `flight log summary --all` shows one-line summaries for all recent sessions

**Auto-summary on session end (via hook):**
- The `SessionEnd` hook triggers `flight log summary` automatically
- Output goes to stderr so user sees it after Claude Code exits

### Files to create/modify
- `src/proxy.ts` — stderr alert output, loop detection logic
- `src/logger.ts` — loop detection state tracking
- `src/log-commands.ts` — add `summarySession` function
- `src/cli.ts` — add `flight log summary` command

---

## Feature 4: Export + Auto-Cleanup

### Problem
Logs pile up with no lifecycle management. Researchers can't easily get data into analysis tools.

### Design

**Export (`flight export`):**

```bash
flight export <session> --format csv    # Flattened CSV
flight export <session> --format jsonl  # Filtered JSONL passthrough
flight export --all --format csv        # All sessions combined
flight export <session> --output ./data/session.csv
```

CSV columns: `session_id, call_id, timestamp, direction, method, tool_name, latency_ms, error, hallucination_hint, pd_active, schema_tokens_saved`

- Payload field excluded from CSV by default (too large), included with `--include-payload`
- JSONL format passes through entries with optional filtering (`--tool`, `--errors`, `--hallucinations`)

**Auto-cleanup:**

Triggered automatically by `SessionEnd` hook and available manually:

```bash
flight log gc              # Compress old sessions, enforce limits
flight log prune --before 2026-03-01   # Delete sessions before date
flight log prune --keep 20             # Keep only N most recent
```

Lifecycle rules (configurable in `~/.flight/config.json`):
- Compress (gzip) sessions older than 24 hours
- Cap: 100 sessions or 2 GB compressed, whichever hit first
- Oldest sessions deleted first when cap exceeded
- `flight log gc --dry-run` shows what would be cleaned up

`log-commands.ts` already handles `.gz` extension stripping via `sessionIdFromFile` — decompression support needs to be added for reading compressed logs.

### Files to create/modify
- `src/export.ts` — CSV/JSONL export logic
- `src/lifecycle.ts` — compression, gc, prune logic
- `src/log-commands.ts` — update read functions to handle `.gz` files
- `src/cli.ts` — add `flight export`, `flight log gc`, `flight log prune` commands
- `~/.flight/config.json` — lifecycle configuration (created by `flight setup`)

---

## Implementation Order

1. **Zero-config setup** — unblocks everything else, simplest to validate
2. **Inline alerts + smart summary** — immediate user value, builds on existing alert system
3. **Export + auto-cleanup** — research enablement + housekeeping
4. **Progressive disclosure** — highest impact but highest risk, needs validation gate

## Future: Claude Code Extension

Document in plan.md: if Claude Code ships a formal extension/plugin API, Flight could migrate from proxy+hooks to a native extension. This would enable:
- Deeper UI integration (inline panels, status indicators)
- Direct access to Claude's context window for smarter PD
- No MCP config wrapping needed at all

For now, proxy + hooks is the pragmatic choice that works today.
