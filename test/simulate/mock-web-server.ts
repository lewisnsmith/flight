/**
 * Mock Web/API MCP server for Flight Proxy simulation.
 * Reads NDJSON from stdin, responds on stdout.
 * Supports: initialize, tools/list, tools/call
 *
 * Env vars:
 *   MOCK_ERROR_RATE (0-1) — randomly fail with -32000 errors at this rate
 *   MOCK_LATENCY_MS — add artificial delay before responding
 */

import { createInterface } from "node:readline";

const ERROR_RATE = parseFloat(process.env.MOCK_ERROR_RATE ?? "0");
const LATENCY_MS = parseInt(process.env.MOCK_LATENCY_MS ?? "0", 10);

const TOOLS = [
  {
    name: "fetch_url",
    description: "Fetch the contents of a URL",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to fetch" } },
      required: ["url"],
    },
  },
  {
    name: "search_web",
    description: "Search the web for a query",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  },
  {
    name: "parse_html",
    description: "Parse HTML and extract content using a CSS selector",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "HTML content to parse" },
        selector: { type: "string", description: "CSS selector to extract" },
      },
      required: ["html"],
    },
  },
  {
    name: "http_request",
    description: "Make an HTTP request",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method" },
        url: { type: "string", description: "Request URL" },
        body: { type: "string", description: "Request body" },
      },
      required: ["method", "url"],
    },
  },
  {
    name: "download_file",
    description: "Download a file from a URL",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to download from" },
        path: { type: "string", description: "Local path to save to" },
      },
      required: ["url", "path"],
    },
  },
  {
    name: "check_url_status",
    description: "Check the HTTP status of a URL",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to check" } },
      required: ["url"],
    },
  },
  {
    name: "extract_links",
    description: "Extract all links from a URL",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to extract links from" } },
      required: ["url"],
    },
  },
  {
    name: "screenshot_url",
    description: "Take a screenshot of a URL",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to screenshot" } },
      required: ["url"],
    },
  },
  {
    name: "api_request",
    description: "Make an API request with JSON handling",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", description: "API endpoint URL" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method" },
        headers: { type: "object", description: "Request headers" },
        body: { type: "object", description: "Request body as JSON" },
      },
      required: ["endpoint"],
    },
  },
  {
    name: "websocket_connect",
    description: "Connect to a WebSocket server",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "WebSocket URL (ws:// or wss://)" } },
      required: ["url"],
    },
  },
];

// --- Canned content generators ---

function generateHtmlContent(url: string): string {
  const domain = url.replace(/^https?:\/\//, "").split("/")[0] || "example.com";
  return [
    "<!DOCTYPE html>",
    `<html lang="en">`,
    "<head>",
    `  <title>${domain} - Home</title>`,
    `  <meta charset="utf-8">`,
    `  <meta name="viewport" content="width=device-width, initial-scale=1">`,
    "</head>",
    "<body>",
    `  <header><h1>Welcome to ${domain}</h1></header>`,
    "  <nav>",
    `    <a href="https://${domain}/about">About</a>`,
    `    <a href="https://${domain}/docs">Documentation</a>`,
    `    <a href="https://${domain}/blog">Blog</a>`,
    "  </nav>",
    "  <main>",
    "    <p>This is the main content of the page.</p>",
    "    <p>It contains multiple paragraphs and sections.</p>",
    "    <section>",
    "      <h2>Features</h2>",
    "      <ul>",
    "        <li>Fast and reliable</li>",
    "        <li>Easy to use</li>",
    "        <li>Well documented</li>",
    "      </ul>",
    "    </section>",
    "  </main>",
    `  <footer><p>&copy; 2026 ${domain}</p></footer>`,
    "</body>",
    "</html>",
  ].join("\n");
}

function generateJsonResponse(url: string): string {
  if (url.includes("/api/users")) {
    return JSON.stringify({
      users: [
        { id: 1, name: "Alice Smith", email: "alice@example.com", role: "admin" },
        { id: 2, name: "Bob Johnson", email: "bob@example.com", role: "user" },
        { id: 3, name: "Carol Williams", email: "carol@example.com", role: "user" },
      ],
      total: 3,
      page: 1,
    }, null, 2);
  }
  if (url.includes("/api/")) {
    return JSON.stringify({
      status: "success",
      data: { id: 42, message: "Resource retrieved successfully", timestamp: "2026-03-14T10:30:00Z" },
    }, null, 2);
  }
  return generateHtmlContent(url);
}

function generateSearchResults(query: string): object[] {
  return [
    { title: `${query} - Official Documentation`, url: `https://docs.example.com/${query.toLowerCase().replace(/\s+/g, "-")}`, snippet: `Comprehensive guide to ${query}. Learn everything you need to know.` },
    { title: `Understanding ${query} | Dev Blog`, url: `https://blog.example.com/${query.toLowerCase().replace(/\s+/g, "-")}`, snippet: `A deep dive into ${query} with practical examples and best practices.` },
    { title: `${query} Tutorial - Getting Started`, url: `https://tutorial.example.com/${query.toLowerCase().replace(/\s+/g, "-")}`, snippet: `Step-by-step tutorial for beginners covering the fundamentals of ${query}.` },
    { title: `${query} vs Alternatives - Comparison`, url: `https://compare.example.com/${query.toLowerCase().replace(/\s+/g, "-")}`, snippet: `Detailed comparison of ${query} with popular alternatives. Pros and cons.` },
    { title: `GitHub - awesome-${query.toLowerCase().replace(/\s+/g, "-")}`, url: `https://github.com/awesome/${query.toLowerCase().replace(/\s+/g, "-")}`, snippet: `A curated list of ${query} resources, tools, and libraries.` },
  ];
}

function generateLinks(url: string): string[] {
  const domain = url.replace(/^https?:\/\//, "").split("/")[0] || "example.com";
  return [
    `https://${domain}/`,
    `https://${domain}/about`,
    `https://${domain}/docs`,
    `https://${domain}/blog`,
    `https://${domain}/contact`,
    `https://${domain}/pricing`,
    `https://${domain}/changelog`,
    "https://github.com/example/repo",
    "https://twitter.com/example",
    `https://${domain}/terms`,
  ];
}

function getStatusCode(url: string): number {
  if (url.includes("/missing") || url.includes("/404")) return 404;
  if (url.includes("/error") || url.includes("/500")) return 500;
  if (url.includes("/redirect")) return 301;
  if (url.includes("/forbidden")) return 403;
  if (url.includes("/unauthorized")) return 401;
  return 200;
}

// --- Tool dispatch ---

function handleToolCall(name: string, args: Record<string, unknown>): { result?: unknown; error?: { code: number; message: string }; delayMs?: number } {
  switch (name) {
    case "fetch_url": {
      const url = (args.url as string) ?? "";
      if (url.includes("timeout")) {
        return { result: { content: [{ type: "text", text: generateJsonResponse(url) }] }, delayMs: 5000 };
      }
      if (url.includes("error")) {
        return { error: { code: -32000, message: `HTTP 500 Internal Server Error fetching ${url}` } };
      }
      const content = url.includes("/api/") ? generateJsonResponse(url) : generateHtmlContent(url);
      return { result: { content: [{ type: "text", text: content }] } };
    }

    case "search_web": {
      const query = (args.query as string) ?? "";
      const results = generateSearchResults(query);
      return { result: { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] } };
    }

    case "parse_html": {
      const html = (args.html as string) ?? "";
      const selector = (args.selector as string) ?? "body";
      // Simple fake parse: just extract text between common tags
      const textContent = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        result: {
          content: [{ type: "text", text: JSON.stringify({ selector, matchCount: 1, text: textContent.slice(0, 500) }) }],
        },
      };
    }

    case "http_request": {
      const method = (args.method as string) ?? "GET";
      const url = (args.url as string) ?? "";
      const body = args.body as string | undefined;
      const status = getStatusCode(url);

      if (status >= 400) {
        return {
          result: {
            content: [{ type: "text", text: JSON.stringify({ status, statusText: status === 404 ? "Not Found" : status === 500 ? "Internal Server Error" : "Error", body: null }) }],
          },
        };
      }

      let responseBody: string;
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        responseBody = JSON.stringify({ status: "created", id: Math.floor(Math.random() * 1000) + 1, received: body ? JSON.parse(body) : null }, null, 2);
      } else if (method === "DELETE") {
        responseBody = JSON.stringify({ status: "deleted", message: "Resource deleted successfully" });
      } else {
        responseBody = generateJsonResponse(url);
      }

      return {
        result: {
          content: [{ type: "text", text: JSON.stringify({ status, statusText: "OK", body: responseBody }, null, 2) }],
        },
      };
    }

    case "download_file": {
      const url = (args.url as string) ?? "";
      const path = (args.path as string) ?? "";
      const sizeKB = 128 + Math.floor(Math.random() * 512);
      return {
        result: {
          content: [{ type: "text", text: `Downloaded ${url} to ${path} (${sizeKB} KB)` }],
        },
      };
    }

    case "check_url_status": {
      const url = (args.url as string) ?? "";
      const status = getStatusCode(url);
      const statusTexts: Record<number, string> = { 200: "OK", 301: "Moved Permanently", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error" };
      return {
        result: {
          content: [{ type: "text", text: JSON.stringify({ url, status, statusText: statusTexts[status] ?? "Unknown", responseTimeMs: 50 + Math.floor(Math.random() * 200) }) }],
        },
      };
    }

    case "extract_links": {
      const url = (args.url as string) ?? "";
      const links = generateLinks(url);
      return { result: { content: [{ type: "text", text: JSON.stringify(links, null, 2) }] } };
    }

    case "screenshot_url": {
      const url = (args.url as string) ?? "";
      // Return a small fake base64 PNG header
      const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      return {
        result: {
          content: [
            { type: "text", text: `Screenshot captured for ${url}` },
            { type: "image", data: fakeBase64, mimeType: "image/png" },
          ],
        },
      };
    }

    case "api_request": {
      const endpoint = (args.endpoint as string) ?? "";
      const method = (args.method as string) ?? "GET";
      const body = args.body as Record<string, unknown> | undefined;

      const status = getStatusCode(endpoint);
      if (status >= 400) {
        return {
          result: {
            content: [{ type: "text", text: JSON.stringify({ status, error: status === 404 ? "Resource not found" : "Internal server error" }, null, 2) }],
          },
        };
      }

      let responseData: unknown;
      if (method === "GET") {
        responseData = JSON.parse(generateJsonResponse(endpoint));
      } else if (method === "POST" || method === "PUT" || method === "PATCH") {
        responseData = { status: "success", id: Math.floor(Math.random() * 1000) + 1, created: true, data: body ?? {} };
      } else {
        responseData = { status: "success", deleted: true };
      }

      return {
        result: {
          content: [{ type: "text", text: JSON.stringify({ status: 200, headers: { "content-type": "application/json", "x-request-id": fullHash().slice(0, 16) }, body: responseData }, null, 2) }],
        },
      };
    }

    case "websocket_connect": {
      const url = (args.url as string) ?? "";
      const protocol = url.startsWith("wss://") ? "wss" : "ws";
      return {
        result: {
          content: [{ type: "text", text: JSON.stringify({ status: "connected", protocol, url, readyState: 1, extensions: "permessage-deflate" }) }],
        },
      };
    }

    default:
      return { error: { code: -32601, message: `Unknown tool: ${name}` } };
  }
}

// --- JSON-RPC helpers ---

function fullHash(): string {
  const chars = "0123456789abcdef";
  let hash = "";
  for (let i = 0; i < 40; i++) hash += chars[Math.floor(Math.random() * 16)];
  return hash;
}

function respond(id: string | number, result: unknown) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function respondError(id: string | number, code: number, message: string) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}

function shouldInjectError(): boolean {
  return ERROR_RATE > 0 && Math.random() < ERROR_RATE;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Main ---

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (LATENCY_MS > 0) {
    await delay(LATENCY_MS);
  }

  if (msg.method === "initialize") {
    respond(msg.id as string | number, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "mock-web", version: "1.0.0" },
    });
  } else if (msg.method === "notifications/initialized") {
    // No response for notifications
  } else if (msg.method === "tools/list") {
    respond(msg.id as string | number, { tools: TOOLS });
  } else if (msg.method === "tools/call") {
    const toolName = (msg.params as Record<string, unknown>)?.name as string;
    const args = ((msg.params as Record<string, unknown>)?.arguments as Record<string, unknown>) ?? {};
    const id = msg.id as string | number;

    if (shouldInjectError()) {
      respondError(id, -32000, `Injected error (MOCK_ERROR_RATE=${ERROR_RATE}) for tool: ${toolName}`);
      return;
    }

    const outcome = handleToolCall(toolName, args);

    // Handle tool-specific delays (e.g., timeout simulation for fetch_url)
    if (outcome.delayMs && outcome.delayMs > 0) {
      await delay(outcome.delayMs);
    }

    if (outcome.error) {
      respondError(id, outcome.error.code, outcome.error.message);
    } else {
      respond(id, outcome.result);
    }
  } else {
    respondError(msg.id as string | number, -32601, `Method not found: ${msg.method}`);
  }
});
