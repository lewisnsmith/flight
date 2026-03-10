import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcParser extends EventEmitter {
  on(event: "message", listener: (msg: JsonRpcMessage) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: () => void): this;
}

export function parseJsonRpcStream(input: Readable): JsonRpcParser {
  const emitter = new EventEmitter() as JsonRpcParser;

  const rl = createInterface({ input, crlfDelay: Infinity });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const msg: JsonRpcMessage = JSON.parse(trimmed);
      emitter.emit("message", msg);
    } catch {
      emitter.emit("error", new Error(`Invalid JSON-RPC: ${trimmed.slice(0, 100)}`));
    }
  });

  rl.on("close", () => {
    emitter.emit("close");
  });

  return emitter;
}

export function isRequest(msg: JsonRpcMessage): boolean {
  return msg.method !== undefined && msg.id !== undefined;
}

export function isResponse(msg: JsonRpcMessage): boolean {
  return msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined);
}

export function isNotification(msg: JsonRpcMessage): boolean {
  return msg.method !== undefined && msg.id === undefined;
}

export function extractToolName(msg: JsonRpcMessage): string | undefined {
  if (msg.method === "tools/call" && msg.params && typeof msg.params === "object") {
    const params = msg.params as Record<string, unknown>;
    if (typeof params.name === "string") return params.name;
  }
  return undefined;
}
