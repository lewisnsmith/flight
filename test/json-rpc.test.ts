import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import {
  parseJsonRpcStream,
  isRequest,
  isResponse,
  isNotification,
  extractToolName,
  type JsonRpcMessage,
} from "../src/json-rpc.js";

function streamFromLines(lines: string[]): Readable {
  return Readable.from(lines.map((l) => l + "\n"));
}

describe("parseJsonRpcStream", () => {
  it("parses valid JSON-RPC request", async () => {
    const messages: JsonRpcMessage[] = [];
    const stream = streamFromLines([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    ]);

    const parser = parseJsonRpcStream(stream);
    parser.on("message", (msg) => messages.push(msg));

    await new Promise((resolve) => parser.on("close", resolve));

    expect(messages).toHaveLength(1);
    expect(messages[0].method).toBe("tools/list");
    expect(messages[0].id).toBe(1);
  });

  it("parses multiple messages", async () => {
    const messages: JsonRpcMessage[] = [];
    const stream = streamFromLines([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    ]);

    const parser = parseJsonRpcStream(stream);
    parser.on("message", (msg) => messages.push(msg));

    await new Promise((resolve) => parser.on("close", resolve));

    expect(messages).toHaveLength(3);
  });

  it("skips empty lines", async () => {
    const messages: JsonRpcMessage[] = [];
    const stream = streamFromLines([
      "",
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }),
      "",
      "   ",
    ]);

    const parser = parseJsonRpcStream(stream);
    parser.on("message", (msg) => messages.push(msg));

    await new Promise((resolve) => parser.on("close", resolve));

    expect(messages).toHaveLength(1);
  });

  it("emits error for invalid JSON", async () => {
    const errors: Error[] = [];
    const stream = streamFromLines(["not valid json"]);

    const parser = parseJsonRpcStream(stream);
    parser.on("error", (err) => errors.push(err));

    await new Promise((resolve) => parser.on("close", resolve));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Invalid JSON-RPC");
  });
});

describe("message type detection", () => {
  it("detects request", () => {
    expect(isRequest({ id: 1, method: "tools/call" })).toBe(true);
    expect(isRequest({ method: "notification" })).toBe(false);
    expect(isRequest({ id: 1, result: "ok" })).toBe(false);
  });

  it("detects response", () => {
    expect(isResponse({ id: 1, result: {} })).toBe(true);
    expect(isResponse({ id: 1, error: { code: -1, message: "fail" } })).toBe(true);
    expect(isResponse({ method: "test" })).toBe(false);
  });

  it("detects notification", () => {
    expect(isNotification({ method: "update" })).toBe(true);
    expect(isNotification({ id: 1, method: "request" })).toBe(false);
  });
});

describe("extractToolName", () => {
  it("extracts tool name from tools/call", () => {
    const msg: JsonRpcMessage = {
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "/test" } },
    };
    expect(extractToolName(msg)).toBe("read_file");
  });

  it("returns undefined for non-tool-call methods", () => {
    expect(extractToolName({ method: "tools/list" })).toBeUndefined();
    expect(extractToolName({ method: "initialize" })).toBeUndefined();
  });

  it("returns undefined when params missing name", () => {
    expect(extractToolName({ method: "tools/call", params: {} })).toBeUndefined();
  });
});
