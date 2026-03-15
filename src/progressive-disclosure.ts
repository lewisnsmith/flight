export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DiscoverResult {
  name: string;
  description: string;
}

export interface ResolvedTool {
  toolName: string;
  arguments: Record<string, unknown>;
  schema: ToolSchema;
}

export interface TokenSavings {
  originalTokens: number;
  reducedTokens: number;
  savedTokens: number;
}

export interface PDHandler {
  loadSchemas(tools: ToolSchema[]): void;
  isActive(): boolean;
  getToolCount(): number;
  getMetaToolSchemas(): ToolSchema[];
  discoverTools(query: string): DiscoverResult[];
  resolveExecuteTool(toolName: string, args: Record<string, unknown>): ResolvedTool | null;
  estimateTokenSavings(): TokenSavings;
}

function estimateTokens(obj: unknown): number {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

export function createPDHandler(_cacheDir: string): PDHandler {
  const schemas = new Map<string, ToolSchema>();
  let active = false;

  const metaToolSchemas: ToolSchema[] = [
    {
      name: "discover_tools",
      description: "Search available tools by keyword. Returns tool names and descriptions matching the query. Use this to find the right tool before calling execute_tool.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keyword to search tool names and descriptions",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "execute_tool",
      description: "Execute a tool by name with the given arguments. Use discover_tools first to find available tools.",
      inputSchema: {
        type: "object",
        properties: {
          tool_name: {
            type: "string",
            description: "The name of the tool to execute (from discover_tools results)",
          },
          arguments: {
            type: "object",
            description: "Arguments to pass to the tool",
          },
        },
        required: ["tool_name", "arguments"],
      },
    },
  ];

  return {
    loadSchemas(tools: ToolSchema[]) {
      schemas.clear();
      for (const tool of tools) {
        schemas.set(tool.name, tool);
      }
      active = true;
    },

    isActive() {
      return active;
    },

    getToolCount() {
      return schemas.size;
    },

    getMetaToolSchemas() {
      return metaToolSchemas;
    },

    discoverTools(query: string): DiscoverResult[] {
      const q = query.toLowerCase();
      const keywords = q.split(/[\s_-]+/).filter(Boolean);
      const results: DiscoverResult[] = [];

      for (const tool of schemas.values()) {
        const nameLower = tool.name.toLowerCase();
        const descLower = tool.description.toLowerCase();

        // Match if the full query appears as substring (with _ treated as space)
        const nameNorm = nameLower.replace(/_/g, " ");
        const descNorm = descLower.replace(/_/g, " ");
        const fullMatch = nameNorm.includes(q) || descNorm.includes(q);

        // Or if all keywords appear somewhere in name or description
        const allKeywordsMatch = keywords.length > 0 && keywords.every(
          (kw) => nameLower.includes(kw) || descLower.includes(kw),
        );

        if (fullMatch || allKeywordsMatch) {
          results.push({ name: tool.name, description: tool.description });
        }
      }

      // Sort: name matches first, then description matches
      const allKeywordsInName = (name: string) =>
        keywords.every((kw) => name.toLowerCase().includes(kw));
      results.sort((a, b) => {
        const aName = allKeywordsInName(a.name) ? 0 : 1;
        const bName = allKeywordsInName(b.name) ? 0 : 1;
        return aName - bName;
      });

      return results;
    },

    resolveExecuteTool(toolName: string, args: Record<string, unknown>): ResolvedTool | null {
      const schema = schemas.get(toolName);
      if (!schema) return null;

      return {
        toolName,
        arguments: args,
        schema,
      };
    },

    estimateTokenSavings(): TokenSavings {
      const allSchemas = [...schemas.values()];
      const originalTokens = estimateTokens(allSchemas);
      const reducedTokens = estimateTokens(metaToolSchemas);

      return {
        originalTokens,
        reducedTokens,
        savedTokens: Math.max(0, originalTokens - reducedTokens),
      };
    },
  };
}
