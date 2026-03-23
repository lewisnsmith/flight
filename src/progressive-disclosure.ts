import { readFile, writeFile, mkdir } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { JsonRpcMessage } from "./json-rpc.js";
import { compressSchema, estimateTokens } from "./pd-schema.js";
import { acquireLock, releaseLock } from "./file-lock.js";

export { compressSchema } from "./pd-schema.js";

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DiscoverResult {
  name: string;
  description: string;
}

export interface TokenSavings {
  originalTokens: number;
  reducedTokens: number;
  savedTokens: number;
}

export interface UsageStore {
  serverKey: string;
  tools: Record<string, ToolUsage>;
  sessions: number;
  lastUpdated: string;
}

export interface ToolUsage {
  name: string;
  callCount: number;
  lastSessionUsed: number;
  lastUsed: string;
  errors: number;
}

export type PDPhase = 1 | 2 | 3;

/**
 * Merge per-session tool usage into a persistent usage store.
 * Pure function — mutates `store.tools` in place but has no I/O side effects.
 */
export function mergeSessionUsage(
  store: UsageStore,
  sessionUsage: Map<string, { calls: number; errors: number }>,
  currentSession: number,
  now: string,
): void {
  for (const [toolName, usage] of sessionUsage) {
    const existing = store.tools[toolName];
    if (existing) {
      store.tools[toolName] = {
        ...existing,
        callCount: existing.callCount + usage.calls,
        errors: existing.errors + usage.errors,
        lastSessionUsed: currentSession,
        lastUsed: now,
      };
    } else {
      store.tools[toolName] = {
        name: toolName,
        callCount: usage.calls,
        lastSessionUsed: currentSession,
        lastUsed: now,
        errors: usage.errors,
      };
    }
  }
}

export interface PDResponseResult {
  /** If set, send this rewritten response instead of the original */
  rewrittenResponse?: JsonRpcMessage;
  /** Whether the responding tool was hidden from tools/list */
  toolHidden: boolean;
  /** Log metadata for the rewritten tools/list response */
  logMeta?: { pd_active: boolean; schema_tokens_saved: number; pd_phase: PDPhase };
  /** Status message for stderr (e.g., phase info) */
  statusMessage?: string;
  /** Error during processing (PD should fall back to passthrough) */
  error?: string;
}

export interface PDHandler {
  /** Load upstream tool schemas and determine phase */
  loadSchemas(tools: ToolSchema[]): void;
  /** Whether PD has been initialized with schemas */
  isActive(): boolean;
  /** Current phase (1=observation, 2=compression, 3=compression+filtering) */
  getPhase(): PDPhase;
  /** Number of original upstream tools */
  getToolCount(): number;
  /** Get the tools/list response tools (compressed/filtered as appropriate) */
  getResponseTools(): ToolSchema[];
  /** Check if a tool name is known (visible or hidden) */
  isKnownTool(name: string): boolean;
  /** Check if a tool was hidden from tools/list */
  isHiddenTool(name: string): boolean;
  /** Search hidden tools by keyword (Phase 3 only) */
  discoverTools(query: string): DiscoverResult[];
  /** Record a tool call for usage tracking */
  recordToolCall(toolName: string, isError: boolean): void;
  /** Estimate token savings from current phase's transformation */
  estimateTokenSavings(): TokenSavings;
  /**
   * Process an upstream response through PD logic.
   * Handles tools/list interception, usage tracking, and hidden tool detection in one call.
   * originalRequest is the client request that triggered this response.
   */
  processResponse(originalRequest: JsonRpcMessage | undefined, response: JsonRpcMessage): PDResponseResult;
  /** Flush usage data to disk (call at session end) */
  flushUsage(): Promise<void>;
  /** Sync best-effort flush for signal handler fallback — no locking */
  flushUsageSync(): void;
}

// Similar to getToolNameFromRequest in retry.ts — kept separate to avoid coupling PD to retry
function getToolNameFromParams(params: unknown): string | undefined {
  if (params && typeof params === "object") {
    return (params as Record<string, unknown>).name as string | undefined;
  }
  return undefined;
}

function computeServerKey(command: string, args: string[]): string {
  const input = `${command} ${args.join(" ")}`.trim().replace(/\/+$/, "");
  return createHash("sha256").update(input).digest("hex");
}

function getUsageDir(): string {
  return join(homedir(), ".flight", "usage");
}

async function loadUsageFromDisk(serverKey: string): Promise<UsageStore | null> {
  const path = join(getUsageDir(), `${serverKey}.json`);
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as UsageStore;
  } catch {
    // File may not exist on first run — return null to trigger Phase 1
    return null;
  }
}

async function saveUsageStore(store: UsageStore): Promise<void> {
  const dir = getUsageDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${store.serverKey}.json`);
  await writeFile(path, JSON.stringify(store, null, 2));
}

const discoverToolSchema: ToolSchema = {
  name: "discover_tools",
  description: "Search available tools by keyword. Returns tool names and descriptions matching the query. Use this to find tools that may not be shown in the tools list.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keyword to search tool names and descriptions. Empty string returns all hidden tools.",
      },
    },
    required: ["query"],
  },
};

export interface PDHandlerOptions {
  serverCommand: string;
  serverArgs: string[];
  historyThreshold?: number;
  /** Pre-loaded usage store (avoids async load during construction) */
  usageStore?: UsageStore | null;
}

export function createPDHandler(options: PDHandlerOptions): PDHandler {
  const { serverCommand, serverArgs, historyThreshold = 3 } = options;
  const serverKey = computeServerKey(serverCommand, serverArgs);
  const schemas = new Map<string, ToolSchema>();
  const hiddenTools = new Set<string>();
  const visibleTools = new Set<string>();
  let active = false;
  let phase: PDPhase = 1;
  const usageStore: UsageStore | null = options.usageStore ?? null;
  let originalSchemas: ToolSchema[] = [];

  // In-memory usage accumulator for this session
  const sessionUsage = new Map<string, { calls: number; errors: number }>();

  const handler: PDHandler = {
    loadSchemas(tools: ToolSchema[]) {
      schemas.clear();
      hiddenTools.clear();
      visibleTools.clear();
      originalSchemas = tools;

      for (const tool of tools) {
        schemas.set(tool.name, tool);
      }

      // Determine phase based on usage store
      if (!usageStore || usageStore.sessions === 0) {
        phase = 1;
        for (const tool of tools) {
          visibleTools.add(tool.name);
        }
      } else if (usageStore.sessions >= 1) {
        let hasFilterCandidates = false;

        if (usageStore.sessions >= historyThreshold) {
          for (const tool of tools) {
            const usage = usageStore.tools[tool.name];
            if (usage) {
              const sessionsSinceUse = usageStore.sessions - usage.lastSessionUsed;
              if (sessionsSinceUse >= historyThreshold) {
                hasFilterCandidates = true;
                break;
              }
            }
          }
        }

        if (hasFilterCandidates) {
          phase = 3;
          for (const tool of tools) {
            const usage = usageStore.tools[tool.name];
            if (!usage) {
              // New tool not in usage store — always visible
              visibleTools.add(tool.name);
            } else {
              const sessionsSinceUse = usageStore.sessions - usage.lastSessionUsed;
              if (sessionsSinceUse >= historyThreshold) {
                hiddenTools.add(tool.name);
              } else {
                visibleTools.add(tool.name);
              }
            }
          }
        } else {
          phase = 2;
          for (const tool of tools) {
            visibleTools.add(tool.name);
          }
        }
      }

      active = true;
    },

    isActive() {
      return active;
    },

    getPhase() {
      return phase;
    },

    getToolCount() {
      return schemas.size;
    },

    getResponseTools(): ToolSchema[] {
      if (!active) return [];

      if (phase === 1) {
        return originalSchemas;
      }

      // Phase 2 & 3: compress schemas for visible tools
      const tools: ToolSchema[] = [];
      for (const name of visibleTools) {
        const schema = schemas.get(name);
        if (schema) {
          tools.push({
            name: schema.name,
            description: schema.description,
            inputSchema: compressSchema(schema.inputSchema),
          });
        }
      }

      // Phase 3: append discover_tools if there are hidden tools
      if (phase === 3 && hiddenTools.size > 0) {
        tools.push(discoverToolSchema);
      }

      return tools;
    },

    isKnownTool(name: string): boolean {
      return schemas.has(name);
    },

    isHiddenTool(name: string): boolean {
      return hiddenTools.has(name);
    },

    discoverTools(query: string): DiscoverResult[] {
      const keywords = query.toLowerCase().split(/[\s_-]+/).filter(Boolean);
      const results: DiscoverResult[] = [];

      for (const name of hiddenTools) {
        const tool = schemas.get(name);
        if (!tool) continue;

        const nameLower = tool.name.toLowerCase();
        const descLower = tool.description.toLowerCase();

        // Empty query returns all hidden tools
        if (keywords.length === 0) {
          results.push({ name: tool.name, description: tool.description });
          continue;
        }

        const allMatch = keywords.every(
          (kw) => nameLower.includes(kw) || descLower.includes(kw),
        );

        if (allMatch) {
          results.push({ name: tool.name, description: tool.description });
        }
      }

      // Sort: name matches first
      const allKeywordsInName = (n: string) =>
        keywords.every((kw) => n.toLowerCase().includes(kw));
      results.sort((a, b) => {
        const aName = allKeywordsInName(a.name) ? 0 : 1;
        const bName = allKeywordsInName(b.name) ? 0 : 1;
        return aName - bName;
      });

      return results;
    },

    recordToolCall(toolName: string, isError: boolean) {
      const existing = sessionUsage.get(toolName) ?? { calls: 0, errors: 0 };
      existing.calls++;
      if (isError) existing.errors++;
      sessionUsage.set(toolName, existing);
    },

    estimateTokenSavings(): TokenSavings {
      const originalTokens = estimateTokens(originalSchemas);
      const responseTools = this.getResponseTools();
      const reducedTokens = estimateTokens(responseTools);

      return {
        originalTokens,
        reducedTokens,
        savedTokens: Math.max(0, originalTokens - reducedTokens),
      };
    },

    // Note: on first tools/list response, this calls loadSchemas() to initialize the handler.
    // This is intentional — PD activation is lazy, triggered by the upstream's first tool listing.
    processResponse(originalRequest: JsonRpcMessage | undefined, response: JsonRpcMessage): PDResponseResult {
      const result: PDResponseResult = { toolHidden: false };

      if (!originalRequest) return result;

      // Handle tools/list interception — rewrite with phase-aware schemas
      // Note: handler may not be active yet — tools/list is what triggers loadSchemas
      if (originalRequest.method === "tools/list" && response.result && !response.error) {
        try {
          const responseResult = response.result as Record<string, unknown>;
          const tools = responseResult.tools as ToolSchema[] | undefined;
          if (tools && Array.isArray(tools)) {
            handler.loadSchemas(tools);

            const responseTools = handler.getResponseTools();
            const savings = handler.estimateTokenSavings();
            const pdPhase = handler.getPhase();

            result.rewrittenResponse = {
              jsonrpc: "2.0",
              id: response.id,
              result: { tools: responseTools },
            } as unknown as JsonRpcMessage;

            result.logMeta = {
              pd_active: true,
              schema_tokens_saved: savings.savedTokens,
              pd_phase: pdPhase,
            };

            result.statusMessage = `PD Phase ${pdPhase}: ${tools.length} tools → ${responseTools.length} tools (${savings.savedTokens} tokens saved)`;
            return result;
          }
        } catch (err) {
          result.error = `Schema interception failed: ${err instanceof Error ? err.message : err}`;
          return result;
        }
      }

      // Track tool usage on response (only when active)
      if (active && originalRequest.method === "tools/call") {
        const toolName = getToolNameFromParams(originalRequest.params);
        if (toolName) {
          handler.recordToolCall(toolName, !!response.error);
          if (handler.isHiddenTool(toolName)) {
            result.toolHidden = true;
          }
        }
      }

      return result;
    },

    async flushUsage() {
      const now = new Date().toISOString();

      // Acquire advisory file lock for atomic read-merge-write
      const lockPath = await acquireLock(join(getUsageDir(), `${serverKey}.lock`));
      try {
        const freshStore = await loadUsageFromDisk(serverKey);
        const store: UsageStore = freshStore
          ? { ...freshStore, tools: { ...freshStore.tools } }
          : { serverKey, tools: {}, sessions: 0, lastUpdated: now };

        const currentSession = store.sessions;
        store.sessions++;
        store.lastUpdated = now;

        mergeSessionUsage(store, sessionUsage, currentSession, now);

        // Prune tools that no longer exist upstream
        if (active) {
          for (const toolName of Object.keys(store.tools)) {
            if (!schemas.has(toolName)) {
              delete store.tools[toolName];
            }
          }
        }

        await saveUsageStore(store);
      } finally {
        await releaseLock(lockPath);
      }
    },

    flushUsageSync() {
      try {
        const now = new Date().toISOString();
        const dir = getUsageDir();
        const path = join(dir, `${serverKey}.json`);

        let store: UsageStore;
        try {
          const content = readFileSync(path, "utf-8");
          const existing = JSON.parse(content) as UsageStore;
          store = { ...existing, tools: { ...existing.tools } };
        } catch {
          // Usage file may not exist yet — start fresh
          store = { serverKey, tools: {}, sessions: 0, lastUpdated: now };
        }

        const currentSession = store.sessions;
        store.sessions++;
        store.lastUpdated = now;

        mergeSessionUsage(store, sessionUsage, currentSession, now);

        mkdirSync(dir, { recursive: true });
        writeFileSync(path, JSON.stringify(store, null, 2));
      } catch {
        // Best-effort — signal handler path, don't throw
      }
    },
  };

  return handler;
}

/**
 * Create a PD handler pre-loaded with usage history from disk.
 */
export async function createPDHandlerWithHistory(
  serverCommand: string,
  serverArgs: string[],
  historyThreshold: number = 3,
): Promise<PDHandler> {
  const serverKey = computeServerKey(serverCommand, serverArgs);
  const usageStore = await loadUsageFromDisk(serverKey);
  return createPDHandler({
    serverCommand,
    serverArgs,
    historyThreshold,
    usageStore,
  });
}
