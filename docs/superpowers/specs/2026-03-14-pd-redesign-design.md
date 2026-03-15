# Progressive Disclosure Redesign

**Date:** 2026-03-14
**Status:** Approved, pending implementation
**Author:** Lewis + Claude

## Problem

Current PD replaces all upstream tools with 2 meta-tools (`discover_tools` + `execute_tool`), forcing the AI into extra discovery round trips before it can do actual work. Validation against real Claude API showed:

- **0% PD completion** (before bugfix) / **100% after bugfix** — but with 1-3 extra round trips per task
- Tasks take 50-80% longer in PD mode
- More API calls = more cost, negating token savings
- With only 10 tools, the discovery overhead outweighs the 360 tokens/task saved

PD should reduce context window bloat from large tool schemas **without adding latency, round trips, or API calls**.

## Design

### Three-Phase Progressive System

PD operates in three phases, automatically selected based on accumulated usage history per upstream server.

#### Phase 1: Observation (session 1, no history)

- `tools/list` → pass through **unmodified**
- `tools/call` → pass through, record tool name + timestamp in usage accumulator
- Usage accumulator written to disk at session end
- **Token savings: none. Purpose: build usage baseline.**

#### Phase 2: Compression (sessions 2+)

- `tools/list` → compress each tool's `inputSchema`, return all tools
- `tools/call` → pass through unmodified, continue tracking usage
- **Token savings: ~40-60% of schema tokens depending on upstream verbosity**

#### Phase 3: Compression + Filtering (sessions 3+ / configurable)

- `tools/list` → compress schemas + omit tools with zero usage in last K sessions + append `discover_tools` meta-tool (only when hidden tools exist)
- `tools/call` for any known tool (visible or hidden) → forward to upstream transparently
- `tools/call` for `discover_tools` → return name + description of hidden tools matching query (local, no upstream call)
- `tools/call` for unknown tool (not in cached schemas at all) → JSON-RPC error
- **Token savings: compression + elimination of unused tool schemas**

### Schema Compression

Applied in Phase 2 and 3. Modifies each tool's `inputSchema` in the intercepted `tools/list` response. Original schemas cached in memory.

**Strip (recursively on all non-root schema nodes):**
- `description` fields on individual properties (not the tool-level description)
- `examples` / `default` values
- `$comment` fields
- Redundant `additionalProperties: false` on nested objects

**Keep:**
- Tool `name` and top-level `description`
- Property names, `type`, `required`, `enum`
- `oneOf` / `anyOf` / `allOf` structure

**Example — before (388 chars):**
```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "The absolute file path to read from the filesystem"
    },
    "encoding": {
      "type": "string",
      "description": "The file encoding to use when reading",
      "default": "utf-8",
      "enum": ["utf-8", "ascii", "base64"]
    }
  },
  "required": ["path"]
}
```

**After compression (150 chars):**
```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "encoding": { "type": "string", "enum": ["utf-8", "ascii", "base64"] }
  },
  "required": ["path"]
}
```

### Hidden Tool Handling (Phase 3)

When the AI calls a tool that was filtered out, the proxy does **not** error. It checks the cached schema map and forwards transparently:

1. Is tool in visible tools? → forward normally
2. Is tool in cached schemas (hidden)? → forward to upstream, log `pd_tool_hidden: true`
3. Not in cached schemas at all? → JSON-RPC error (unknown tool)

The AI can call any real tool at any time. Filtering only affects what shows up in `tools/list`. `discover_tools` is a convenience for browsing hidden tools, not a gate.

If a hidden tool gets called frequently, the usage store promotes it back to visible in subsequent sessions.

### `discover_tools` in Phase 3

- Only appended to `tools/list` when there are hidden tools
- Returns `{ name, description }` for hidden tools matching the query
- Does NOT return full schemas — the AI calls the tool directly after discovering its name
- Purely local (no upstream call)
- Uses keyword matching: splits query on whitespace/underscore/hyphen, matches if all keywords appear in tool name or description

### Usage Store

Persists at `~/.flight/usage/` with one JSON file per upstream server.

```typescript
interface UsageStore {
  serverKey: string;           // SHA-256 of `${command} ${args.join(" ")}` (trimmed, no trailing slashes)
  tools: Record<string, ToolUsage>;
  sessions: number;            // total sessions tracked
  lastUpdated: string;         // ISO timestamp
}

interface ToolUsage {
  name: string;
  callCount: number;           // total calls across all sessions
  lastSessionUsed: number;     // session index when tool was last called (0-based)
  lastUsed: string;            // ISO timestamp
  errors: number;              // total error responses
}
```

**Filtering threshold:** A tool is hidden when `sessions - lastSessionUsed >= K` (i.e., K consecutive sessions of non-use). Default K = 3. Tools not present in the usage store (new upstream tools) are always visible until they accumulate K sessions of non-use.

**Phase detection** uses separate thresholds — K controls filtering, not phase transitions:
- `sessions === 0` → Phase 1 (observation)
- `sessions >= 1` → Phase 2 (compression)
- `sessions >= K` AND at least one tool meets the filtering threshold → Phase 3 (compression + filtering)

Phase 3 only activates when there are actually tools to filter. If all tools are actively used, Phase 2 persists indefinitely.

**Tool list evolution:** When upstream adds new tools not in the usage store, they are treated as visible (no history = no filtering). When upstream removes tools that are in the usage store, stale entries are pruned on the next session end write.

**Updates:** Written once at session end during existing flush/cleanup. In-memory accumulator during the session.

**Empty `discover_tools` query:** Returns all hidden tools (empty keyword list matches everything). This is intentional — allows the AI to browse all available tools.

### CLI Interface

```
flight proxy --cmd <command> [--pd] [--pd-history <n>] [args...]
```

- `--pd` — enables PD (unchanged, off by default)
- `--pd-history <n>` — sessions with zero usage before hiding a tool (default: 3)

Phase selection is automatic. No manual phase override.

### Logging

`schema_tokens_saved` is logged once per `tools/list` interception (as today), comparing original full schemas vs. the compressed/filtered response actually sent to the client. The stats command reads both log entries and the usage store file at `~/.flight/usage/`.

Existing log entry fields preserved. New fields:

| Field | Type | Description |
|-------|------|-------------|
| `pd_active` | `boolean` | Already exists, keeps working |
| `schema_tokens_saved` | `number` | Already exists, reflects compression savings |
| `pd_phase` | `1 \| 2 \| 3` | New — which phase this session used |
| `pd_tool_hidden` | `boolean` | New — true if called tool was filtered from tools/list |

### Stats

`flight stats <session-id>` additions:
```
PD Phase:           2 (compression)
Schema tokens:      847 → 312 (63% reduction)
Tools shown:        10/10
Tools used:         4 (read_file, write_file, search_files, list_directory)
Tools never used:   6
```

`flight stats` (aggregate) additions:
```
PD Summary (last 5 sessions):
  Avg schema reduction:  58%
  Most used tools:       read_file (23), write_file (11), search_files (8)
  Never used (3+ sessions): delete_file, move_file, create_directory
  Ready for filtering:   3 tools
```

### Backward Compatibility

The current `discover_tools` + `execute_tool` meta-tool pair is **replaced entirely**. PD is documented as experimental (`--pd` flag), so this is a clean break with no migration path.

## Comparison: Current vs New

| | Current PD | New PD |
|---|---|---|
| Session 1 | 2 meta-tools, discovery required | Full passthrough, observation only |
| Tool access | Must use execute_tool wrapper | Direct tool calls, always |
| Extra round trips | 1-3 per task (discovery) | Zero for known tools |
| Token savings | Fixed (meta-tools vs full schemas) | Grows with usage history |
| Hidden tool handling | Error if not discovered | Transparent forwarding |
| Usage tracking | None | Per-server persistent store |

## Files to Modify

- `src/progressive-disclosure.ts` — rewrite: compression logic, phase detection, usage store
- `src/proxy.ts` — update interception: remove execute_tool routing, add transparent forwarding for hidden tools, add phase-aware tools/list rewriting
- `src/logger.ts` — add `pd_phase` and `pd_tool_hidden` fields to LogEntry
- `src/cli.ts` — add `--pd-history` option
- `src/index.ts` — update exports if interfaces change
- `test/pd-token-reduction.test.ts` — rewrite for new compression behavior
- `test/simulate/validate-claude-api.ts` — update for new PD behavior (no execute_tool wrapper)

## Validation

Re-run `validate-claude-api.ts` after implementation. Success criteria:
- PD completion rate equal to passthrough (100%)
- Zero extra round trips vs passthrough for Phase 1 and Phase 2
- Phase 3: at most 1 extra round trip (only if AI needs discover_tools)
- Measurable token savings in Phase 2+ (>30% schema reduction)
