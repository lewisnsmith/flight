# Implementation Plan: Flight Proxy

**Timeline:** 8 weeks to v1.0
**Stack:** Node.js (TypeScript) with potential Rust rewrite for v2
**Architecture:** Transparent STDIO proxy with progressive disclosure layer

> **Dual purpose:** Flight Proxy is simultaneously a developer debugging tool and research infrastructure for systematic study of agent behavior, tool-calling policies, and hallucinations. The log format and dataset structure should be designed with both use cases in mind from day one.

---

## Phase 0: Scope & Design (Week 1)

### Objectives
- Lock down v1.0 feature set
- Design core architecture
- Design log schema as both a debugging artifact and an analyzable research dataset

### Tasks

**Architecture Design**
- [ ] Create system architecture diagram (Client ⇄ Proxy ⇄ Upstream)
- [ ] Design JSON-RPC message flow and interception points
- [ ] Spec out `.jsonl` log format with all required fields (see below — designed for both debugging and empirical analysis)
- [ ] Design progressive disclosure meta-tool API contract
- [ ] Define `~/.flight/metrics.jsonl` schema for cross-session usage analytics

**Log Schema Design (research-grade)**

The `.jsonl` format must serve two audiences: developers replaying individual calls, and researchers running aggregate analysis across sessions. Design it once, right:
```typescript
interface LogEntry {
  // Identity
  session_id: string;          // UUID per proxy invocation
  call_id: string;             // UUID per request/response pair
  install_id: string;          // Random UUID, set once at install (no PII)

  // Timing
  timestamp: string;           // ISO 8601, ms precision
  latency_ms: number;          // Round-trip time, upstream only

  // Traffic
  direction: 'client->server' | 'server->client';
  method: string;              // e.g. "tools/call", "tools/list"
  payload: unknown;            // Full JSON-RPC — redacted version in logs

  // Outcome
  error?: string;              // Error message if failed
  hallucination_hint?: boolean; // True if client proceeded after server error

  // Research fields
  tool_name?: string;          // Extracted from payload for easy grouping
  pd_active: boolean;          // Was progressive disclosure enabled?
  schema_tokens_saved?: number; // Per-call PD token delta (if known)
}
```

**Tech Stack Decisions**
- [ ] Choose runtime: Node.js TypeScript vs Rust
  - Node.js pros: Faster iteration, better ecosystem for JSON/CLI
  - Rust pros: Performance, smaller binary, better systems control
  - **Recommendation:** Start with Node.js, consider Rust port for v2
- [ ] Select libraries:
  - CLI: `commander` or `yargs`
  - TUI: `blessed`, `ink`, or `tui-rs` (if Rust)
  - JSON streaming: Native or `JSONStream`
  - Logging: `pino` (preferred — structured, fast, async)

**Setup**
- [ ] Initialize repo with TypeScript config
- [ ] Set up testing framework (Jest or Vitest)
- [ ] Create example `claude_desktop_config.json` snippets
- [ ] Write initial `ARCHITECTURE.md` doc

### Deliverables
- Architecture diagram (Mermaid or ASCII)
- Finalized log schema (covers both debugging and research analysis)
- Example config showing before/after proxy setup
- Dev environment ready with first test passing

---

## Phase 1: Core Proxy & Recording (Weeks 1–2)

### Objectives
- Build transparent STDIO proxy that can intercept MCP traffic
- Implement structured logging to `.jsonl`
- Verify zero functional regressions
- Establish explicit I/O performance constraints from the start

### Tasks

**Proxy Core**
- [ ] Implement STDIO bidirectional pipe
  ```typescript
  // Pseudocode structure
  process.stdin → [Intercept & Log] → upstream.stdin
  upstream.stdout → [Intercept & Log] → process.stdout
  ```
- [ ] Parse JSON-RPC messages from streams as **streaming NDJSON** — never fully buffer a message before forwarding
- [ ] Handle partial messages and streaming chunks correctly
- [ ] Forward first byte downstream before log write completes (log is fire-and-forget)
- [ ] Handle upstream process lifecycle (spawn, crash, exit)

**Configuration**
- [ ] Support CLI args: `flight-proxy --cmd <upstream> -- <args>`
- [ ] `flight init claude` — auto-generate a ready-to-use `claude_desktop_config.json` snippet
- [ ] Read config from `flight.config.json` (optional):
  ```json
  {
    "upstream": {
      "command": "mcp-server-filesystem",
      "args": ["--root", "/workspace"]
    },
    "logging": {
      "enabled": true,
      "path": "~/.flight/logs",
      "rotation": "session"
    }
  }
  ```

**Logging System**
- [ ] Implement async `.jsonl` writer using a dedicated write queue (never blocks proxy I/O)
- [ ] Write queue max depth: 1,000 entries. If queue fills (disk stall), drop entries with stderr warning — never stall the proxy
- [ ] Flush policy: write buffered, flush every 100ms or on session close
- [ ] Generate unique `session_id` per proxy invocation
- [ ] Generate unique `call_id` per request/response pair
- [ ] Measure and log latency for each round-trip
- [ ] Capture stderr from upstream process separately
- [ ] Log rotation: new `.jsonl` file per session
- [ ] On startup: check free disk space; if < 100MB, warn and disable logging (do not crash)
- [ ] Secret redaction: strip configured env var values and regex patterns before writing

**I/O Performance Constraints (must be validated in Phase 1, not deferred)**
- [ ] Latency budget: <5ms between first-byte-from-upstream and first-byte-to-client
- [ ] Backpressure: proxy slows upstream reads proportionally when client is slow (pass-through, no unbounded buffering)
- [ ] Throughput: sustain 10 MB/s log write without proxy latency degradation
- [ ] Benchmark two load profiles before moving to Phase 1.5:
  - *Small frequent:* 500 calls × ~1KB each (tool chatter baseline)
  - *Large single:* 10 calls × ~1MB each (file reads, DB dumps)

**Research Dataset Quality**
- [ ] Emit `hallucination_hint: true` when client sends a follow-up after upstream returned an error (detectable pattern: error response → next client message does not retry)
- [ ] Include `tool_name` as a top-level field (extracted from payload) so researchers can `jq '.[] | select(.tool_name == "write_file")'` without parsing payload

**Testing**
- [ ] Unit tests for JSON-RPC parser
- [ ] Integration test with mock MCP server
- [ ] Benchmark added latency (<5ms target) across both load profiles
- [ ] Verify log queue drop behavior under simulated disk stall
- [ ] Test with real `mcp-server-filesystem` and Claude Desktop

### Deliverables
- Working proxy that is functionally transparent
- Structured research-grade logs capturing all traffic
- Benchmark results for both load profiles confirming <5ms latency
- Secret redaction working from day one
- `flight init claude` command functional
- README quickstart section

---

## Phase 1.5: First User MVP (Weeks 2–3)

> **Gate:** Do not proceed to Phase 3 (PD) until at least 2 of 3 early users confirm the flight recorder is independently valuable.

### Objectives
- Ship the smallest slice that proves core value
- Get real sessions into logs for empirical validation
- Gather feedback before investing in PD and TUI

### What's In

- [ ] Transparent STDIO proxy (passthrough, no PD)
- [ ] Append-only `.jsonl` logging (full research-grade schema)
- [ ] `flight log tail` — live stream of current session
- [ ] `flight log view <session>` — paginated post-mortem inspection
- [ ] `flight init claude` — zero-config Claude Desktop setup
- [ ] Secret redaction (on by default)
- [ ] One fully documented workflow: **"Debug a Hallucinated File Write"**
- [ ] 5-minute README quickstart

### What's Explicitly Out
- TUI dashboard
- Progressive disclosure
- Replay functionality
- Token metrics
- Log compression / gc automation

### Deliverables
- Working proxy shipped to 3 target users
- At least 1 real captured session demonstrating hallucination detection
- Written notes from early user conversations (the first empirical data)

---

## Phase 2: CLI & Replay (Weeks 3–4)

### Objectives
- Build CLI for inspecting logged sessions
- Implement replay functionality for debugging and research reproducibility
- Create terminal-friendly output formatting

### Tasks

**CLI Commands**
- [ ] `flight log list`
  - List all sessions with metadata (timestamp, duration, call count, error count, PD enabled)
  - Table format: Session ID | Date | Duration | Calls | Errors | PD
- [ ] `flight log tail [--session <id>]`
  - Live stream current or specified session
  - Color-coded output (green=success, red=error, yellow=hallucination hint)
- [ ] `flight log view <session-id>`
  - Paginated timeline of all calls
  - Columns: timestamp, tool name, latency, status, PD flag
- [ ] `flight log filter --tool <name>` — filter by tool name
- [ ] `flight log filter --errors` — show only failed calls
- [ ] `flight log filter --hallucinations` — show calls where `hallucination_hint: true`
- [ ] `flight log inspect <call-id>` — pretty-print full request/response JSON
- [ ] `flight log gc` — garbage collect logs, report reclaimed space
- [ ] `flight log prune [--max-sessions N] [--max-disk-mb N]` — trim to retention policy

**Replay Functionality**
- [ ] `flight replay <call-id>` — re-execute specific request against current upstream
- [ ] `flight replay <call-id> --dry-run` — parse and validate without executing
- [ ] `flight replay <session-id> --range <start>..<end>` — replay sequence for reproducing multi-step failures

**Research Export**
- [ ] `flight export <session-id> --format csv` — export session as flat CSV for analysis in R/Python/MATLAB
- [ ] `flight export <session-id> --format jsonl` — re-export cleaned JSONL (redaction applied, no internal fields)
- [ ] Include `hallucination_hint`, `tool_name`, `latency_ms` as first-class CSV columns

**Output Formatting**
- [ ] Color scheme: blue (client), green (success), red (error), yellow (hallucination hint)
- [ ] Pretty-print JSON with syntax highlighting
- [ ] Truncate large payloads with `--full` flag

### Deliverables
- Functional CLI with all core commands
- Replay capability for debugging and research reproducibility
- CSV/JSONL export for empirical analysis
- CLI usage documentation

---

## Phase 3: Progressive Disclosure v0 (Weeks 3–4)

> **Scope:** Single upstream server only. The goal is to ship the core differentiator correctly, not completely. Multi-server orchestration and advanced analytics are post-v1.0.

### Objectives
- Implement meta-tool pattern for the single-server case
- Reduce `tools/list` schema token overhead by 10–50x
- Measure token savings per session
- Validate that PD does not break functional correctness

### Tasks

**Meta-Tool Implementation (PD v0 scope)**
- [ ] Create `discover_tools` synthetic tool:
  ```json
  {
    "name": "discover_tools",
    "description": "Search available tools by capability or domain",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {"type": "string"},
        "domain": {"type": "string"}
      }
    }
  }
  ```
- [ ] Create `execute_tool` synthetic tool:
  ```json
  {
    "name": "execute_tool",
    "description": "Execute a discovered tool",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tool_name": {"type": "string"},
        "arguments": {"type": "object"}
      },
      "required": ["tool_name", "arguments"]
    }
  }
  ```

**Schema Management (PD v0 scope)**
- [ ] On proxy startup: fetch all upstream tool schemas via `tools/list`, cache in memory
- [ ] Intercept `tools/list`: return only `discover_tools` + `execute_tool` when PD enabled
- [ ] Intercept `discover_tools` call: return matching tool names + short descriptions (no full schemas)
- [ ] Intercept `execute_tool` call: look up real tool in cache, forward to upstream in original JSON-RPC format
- [ ] Fallback: if schema interception fails for any reason, silently drop to passthrough mode and log a warning

**Token Metrics (session-level only in v0)**
- [ ] Estimate baseline token count: raw schema size ÷ 4 (chars per token approximation)
- [ ] Estimate disclosed token count: meta-tool schema + any schemas injected via `discover_tools`
- [ ] Log `schema_tokens_saved` per `discover_tools` call
- [ ] `flight stats <session-id>` command: show before/after token estimate and savings %

**Configuration**
- [ ] Flag: `--progressive-disclosure` or `--pd`
- [ ] Config option: `progressiveDisclosure: { enabled: true }`

**Deferred to Post-v1.0 (do not build now)**
- ❌ Multi-server routing (routing `execute_tool` across N upstream servers)
- ❌ Per-tool usage frequency stats
- ❌ Cross-session disclosure analytics
- ❌ Fuzzy / embedding-based tool search
- ❌ Schema diff detection across MCP server versions

**Testing**
- [ ] Test with 1 tool (must work identically to passthrough)
- [ ] Test with 10+ tools (verify token reduction claim)
- [ ] Test with real Claude Desktop session
- [ ] Verify zero functional regressions vs passthrough
- [ ] Confirm fallback to passthrough on schema parse failure

### Deliverables
- Working PD mode for single-server case
- Measured token savings (target: 10–50x for large toolsets)
- `flight stats` command showing per-session savings
- Documentation explaining the PD v0 pattern and its scope limitations

---

## Phase 4: Terminal UI / TUI (Week 5)

> **Priority:** Deprioritized relative to PD. If timeline slips, defer TUI. The CLI (`flight log tail`, `flight log view`) is sufficient for the MVP and early research use.

### Objectives
- Create interactive TUI for live monitoring
- Enable keyboard-driven navigation and filtering

### Tasks

**TUI Components** (using `blessed` or `ink`)
- [ ] Header panel: Session info, duration, status, PD active flag
- [ ] Main panel: Scrollable timeline of tool calls
- [ ] Detail panel: Selected call's full request/response
- [ ] Metrics sidebar: total calls, error rate, avg latency, token savings, disk usage %
- [ ] Footer: Keyboard shortcuts, active filters

**Keyboard Navigation**
- [ ] `↑/↓`: Navigate timeline
- [ ] `Enter`: Inspect selected call
- [ ] `/`: Filter by text or tool name
- [ ] `e`: Toggle errors-only
- [ ] `h`: Toggle hallucination-hints-only
- [ ] `q`: Quit

**Launch**
- [ ] `flight tui` or `flight log view --tui`
- [ ] Auto-detect terminal size, adapt layout

**Testing**
- [ ] Test in various terminal emulators (iTerm2, Ghostty, Windows Terminal)
- [ ] Verify keyboard shortcuts
- [ ] Test with high-frequency call streams (500+ calls)

### Deliverables
- Interactive TUI with live monitoring
- Keyboard-driven navigation
- Disk usage indicator (warns at 80% of configured budget)

---

## Phase 5: Safety & Hardening (Weeks 6–7)

### Objectives
- Add security features (secret redaction — already in Phase 1, harden here)
- Improve error handling and edge cases
- Ensure production-ready reliability

### Tasks

**Secret Redaction (hardening)**
- [ ] Configurable redaction patterns:
  ```json
  {
    "redaction": {
      "env_vars": ["API_KEY", "DATABASE_URL"],
      "patterns": ["sk-[a-zA-Z0-9]+", "ghp_[a-zA-Z0-9]+"]
    }
  }
  ```
- [ ] Verify redaction is applied before any write (not post-processing)
- [ ] Show `[REDACTED]` in place of secrets in CLI/TUI output

**Error Handling**
- [ ] Graceful upstream crash handling
- [ ] Clear error messages for common issues (upstream not found, JSON-RPC parse errors, permission issues)

**Rate Limiting**
- [ ] Detect infinite loops (same call + same args repeated N times)
- [ ] Optional circuit breaker to halt runaway agents (configurable N threshold)

**Log Lifecycle Hardening**
- [ ] Compress sessions older than 1 day to `.jsonl.gz`
- [ ] `flight log gc` command: trim to retention policy, report reclaimed bytes
- [ ] Auto-prune on startup if total log size > 5GB (configurable)

**Testing**
- [ ] Fuzz test with malformed JSON inputs
- [ ] Test with upstream that crashes mid-session
- [ ] Test redaction with real secrets (in isolated environment)
- [ ] Test disk-full and low-disk conditions

### Deliverables
- Hardened proxy ready for production use
- Security documentation
- Error handling guide

---

## Phase 6: Documentation & Release (Week 7–8)

### Objectives
- Write documentation serving both developer and researcher audiences
- Create demo materials for GitHub
- Prepare v1.0 release

### Tasks

**Documentation**
- [ ] `README.md`:
  - Origin story: MathWorks M3 competition, hallucination problem, no ground-truth trace
  - Dual framing: developer debugging tool + research infrastructure
  - Demo GIF showing TUI detecting a hallucination
  - Quick install: `npm install -g flight-proxy`
  - Quick start: `flight init claude` → 3-step setup
  - Feature overview with examples
- [ ] `ARCHITECTURE.md`:
  - System diagram
  - JSON-RPC interception details
  - Progressive disclosure algorithm
  - Log schema field reference (for researchers)
- [ ] `RESEARCH.md`:
  - How to use Flight Proxy as a data collection instrument
  - Example jq / Python queries for analyzing hallucination patterns
  - Guidance on building a session dataset for policy modeling
  - Link to any published empirical study once available
- [ ] `CONTRIBUTING.md` and `FAQ.md`

**Demo Materials**
- [ ] Record GIF: TUI catching a hallucinated file write in real time
- [ ] Record GIF: token savings comparison (50 tools, PD on vs off)
- [ ] Example datasets: 2–3 anonymized sample sessions (`.jsonl.gz`) showing hallucination patterns

**Release Prep**
- [ ] Version bump to v1.0.0
- [ ] GitHub release with changelog
- [ ] Publish to npm: `npm publish`
- [ ] Launch announcement: HN "Show HN", r/ClaudeAI, r/LocalLLaMA, r/MachineLearning, Twitter/X

### Deliverables
- Published v1.0.0 package
- Complete documentation (developer + researcher paths)
- Demo materials on GitHub
- Sample anonymized session datasets

---

## Success Criteria

### Technical
- ✅ <5ms added latency per tool call (both load profiles)
- ✅ 100% JSON-RPC message fidelity (zero dropped messages)
- ✅ 10–50x token reduction with progressive disclosure (single-server)
- ✅ Sustains 1,000+ tool calls per session without memory leaks
- ✅ 10 MB/s log write throughput under large-response load

### Research Quality
- ✅ `hallucination_hint` field emitted correctly in >90% of detectable cases
- ✅ Log schema stable and documented for external analysis
- ✅ CSV/JSONL export produces clean, analyzable datasets
- ✅ At least 1 real captured session demonstrating a hallucination pattern in sample data

### Adoption
- ✅ 200+ GitHub stars within 3 months
- ✅ 10+ issues/PRs from community
- ✅ 3+ public testimonials
- ✅ Featured in at least 1 newsletter or blog

### User Experience
- ✅ Install in <2 minutes (from zero to first proxy run)
- ✅ Zero-config default mode with `flight init claude`
- ✅ TUI is intuitive without reading docs

---

## Post-v1.0 Roadmap

### v1.1: Enhanced Observability & Research Tooling
- Multi-server progressive disclosure orchestration
- `flight analyze` command: local statistical summary of hallucination rates, tool-call patterns, error clusters across N sessions
- Export to Pandas-friendly Parquet format for research datasets

### v1.2: Empirical Study Support
- Structured experiment mode: tag sessions with condition labels (e.g., `--condition baseline`, `--condition pd-enabled`) for A/B analysis
- Local classifier trained on captured logs to predict hallucination probability before it occurs
- Anomaly detection in tool-call sequences

### v2.0: Multi-Protocol & Platform
- HTTP transport in addition to STDIO
- Support for non-MCP agent frameworks
- Plugin system for custom transformations

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| MCP spec changes break proxy | High | Pin to specific version, provide migration guide |
| Adoption slower than expected | Medium | Focus on killer demo + research angle for academic audiences |
| Performance issues with large logs | Medium | Aggressive compression, gc, 5GB cap |
| Claude Desktop updates break integration | High | Monitor Claude releases, test pre-release |
| Competition from Anthropic native tooling | High | Differentiate with offline-first, open-source, research-grade logging |
| PD ships late | High | Narrow scope to single-server v0; ship without TUI before shipping without PD |

---

## Resources Required

- **Time:** 8 weeks at ~20–30 hours/week
- **Compute:** Local dev machine (no cloud required)
- **Tools:** Claude Code for rapid iteration, GitHub for hosting
- **Cost:** $0 (open source, local-first)

---

## Notes

- Prioritize working prototype over perfection in Phases 1–1.5
- TUI can be deferred if timeline slips (CLI is core)
- Progressive disclosure is the key differentiator — ensure it's rock solid even at narrow v0 scope
- The log schema is also a research dataset — design it right in Phase 0, not as an afterthought
- Documentation quality is critical for GitHub and academic reception — allocate a full week
