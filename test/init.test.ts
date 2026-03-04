import { describe, it, expect } from "vitest";
import { wrapWithFlight } from "../src/init.js";

describe("wrapWithFlight", () => {
  it("wraps a simple server entry", () => {
    const result = wrapWithFlight({
      filesystem: {
        command: "mcp-server-filesystem",
        args: ["--root", "/workspace"],
      },
    });

    expect(result.filesystem.command).toBe("flight");
    expect(result.filesystem.args).toEqual([
      "proxy",
      "--cmd",
      "mcp-server-filesystem",
      "--",
      "--root",
      "/workspace",
    ]);
  });

  it("preserves env vars", () => {
    const result = wrapWithFlight({
      github: {
        command: "mcp-server-github",
        args: [],
        env: { GITHUB_TOKEN: "abc123" },
      },
    });

    expect(result.github.env).toEqual({ GITHUB_TOKEN: "abc123" });
    expect(result.github.command).toBe("flight");
  });

  it("skips already-wrapped servers", () => {
    const result = wrapWithFlight({
      already: {
        command: "flight",
        args: ["proxy", "--cmd", "some-server"],
      },
    });

    expect(result.already.command).toBe("flight");
    expect(result.already.args).toEqual(["proxy", "--cmd", "some-server"]);
  });

  it("handles server with no args", () => {
    const result = wrapWithFlight({
      simple: {
        command: "my-server",
      },
    });

    expect(result.simple.args).toEqual(["proxy", "--cmd", "my-server"]);
  });

  it("wraps multiple servers", () => {
    const result = wrapWithFlight({
      a: { command: "server-a", args: ["--flag"] },
      b: { command: "server-b" },
    });

    expect(Object.keys(result)).toEqual(["a", "b"]);
    expect(result.a.command).toBe("flight");
    expect(result.b.command).toBe("flight");
  });
});
