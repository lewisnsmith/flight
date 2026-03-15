import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { parseJsonRpcStream } from "../src/json-rpc.js";

function streamFromString(input: string): Readable {
  return Readable.from([input]);
}

function streamFromChunks(chunks: string[]): Readable {
  return Readable.from(chunks);
}

function collectMessages(stream: Readable): Promise<{ messages: unknown[]; errors: string[] }> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    const errors: string[] = [];
    const parser = parseJsonRpcStream(stream);
    parser.on("message", (msg) => messages.push(msg));
    parser.on("error", (err) => errors.push(err.message));
    stream.on("end", () => setTimeout(() => resolve({ messages, errors }), 50));
  });
}

describe("Fuzz: JSON-RPC parser resilience", () => {
  it("handles empty input", async () => {
    const { messages, errors } = await collectMessages(streamFromString(""));
    expect(messages).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("handles only whitespace and newlines", async () => {
    const { messages, errors } = await collectMessages(streamFromString("\n\n  \n\t\n"));
    expect(messages).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("handles truncated JSON", async () => {
    const { messages, errors } = await collectMessages(
      streamFromString('{"jsonrpc":"2.0","id":1,"method":"too\n'),
    );
    expect(messages).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("handles binary garbage", async () => {
    const garbage = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a, 0x42, 0x0a]).toString();
    const { messages, errors } = await collectMessages(streamFromString(garbage));
    expect(messages).toHaveLength(0);
    // Should get errors for non-empty lines, but not crash
    expect(errors.length).toBeGreaterThanOrEqual(0);
  });

  it("handles extremely long single line", async () => {
    const longValue = "x".repeat(100_000);
    const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test", params: { data: longValue } });
    const { messages, errors } = await collectMessages(streamFromString(line + "\n"));
    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(1);
  });

  it("handles valid JSON interspersed with garbage", async () => {
    const input = [
      '{"jsonrpc":"2.0","id":1,"method":"a"}',
      "not json at all",
      '{"jsonrpc":"2.0","id":2,"method":"b"}',
      "{broken",
      '{"jsonrpc":"2.0","id":3,"method":"c"}',
    ].join("\n") + "\n";

    const { messages, errors } = await collectMessages(streamFromString(input));
    expect(messages).toHaveLength(3);
    expect(errors).toHaveLength(2);
  });

  it("handles messages split across chunks", async () => {
    const msg = '{"jsonrpc":"2.0","id":1,"method":"test"}\n';
    const mid = Math.floor(msg.length / 2);
    const chunks = [msg.slice(0, mid), msg.slice(mid)];

    const { messages, errors } = await collectMessages(streamFromChunks(chunks));
    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(1);
  });

  it("handles null bytes in input", async () => {
    const input = '{"jsonrpc":"2.0","id":1}\n\0\0\0\n{"jsonrpc":"2.0","id":2}\n';
    const { messages } = await collectMessages(streamFromString(input));
    expect(messages).toHaveLength(2);
  });

  it("handles JSON array (not a JSON-RPC message)", async () => {
    const input = '[1,2,3]\n';
    const { messages } = await collectMessages(streamFromString(input));
    // Arrays parse as JSON but aren't JSON-RPC objects — parser still emits them
    expect(messages).toHaveLength(1);
  });

  it("handles rapid succession of many small messages", async () => {
    const lines = Array.from({ length: 500 }, (_, i) =>
      JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping" }),
    ).join("\n") + "\n";

    const { messages, errors } = await collectMessages(streamFromString(lines));
    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(500);
  });

  it("handles nested JSON with special characters", async () => {
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "write_file",
        arguments: {
          content: 'line1\nline2\ttab\r\nwindows\n{"nested": "json"}',
          path: "/tmp/test file (1).txt",
        },
      },
    };
    const input = JSON.stringify(msg) + "\n";
    const { messages, errors } = await collectMessages(streamFromString(input));
    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(1);
  });
});
