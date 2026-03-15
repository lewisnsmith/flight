import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_LOG_DIR = join(tmpdir(), "flight-disk-test-" + Date.now());

// We need to mock statfs from node:fs/promises before importing the logger
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    statfs: vi.fn().mockImplementation(actual.statfs),
  };
});

import { statfs } from "node:fs/promises";
import { createSessionLogger } from "../src/logger.js";

const mockedStatfs = vi.mocked(statfs);

beforeEach(() => {
  mockedStatfs.mockReset();
});

afterEach(async () => {
  try {
    await rm(TEST_LOG_DIR, { recursive: true });
  } catch {
    // ignore
  }
});

describe("Disk-full conditions", () => {
  describe("Startup disk check", () => {
    it("disables logging when available disk space is below 100MB", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      // Return stats indicating ~50MB available (below the 100MB threshold)
      mockedStatfs.mockResolvedValueOnce({
        bavail: 50 * 256, // 50MB worth of blocks
        bsize: 4096,      // 4KB block size => 50*256*4096 = 50MB
        type: 0,
        blocks: 1000000,
        bfree: 50 * 256,
        files: 100000,
        ffree: 50000,
      } as any);

      const logger = await createSessionLogger(TEST_LOG_DIR);

      // Verify warning was written to stderr
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("low disk space"),
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("Logging disabled"),
      );

      // Log some messages -- they should be silently dropped
      logger.log(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file" } },
        "client->server",
      );

      await logger.close();

      // The log file should not have been created since logging was disabled
      await expect(readFile(logger.logPath, "utf-8")).rejects.toThrow();

      stderrSpy.mockRestore();
    });

    it("enables logging when disk space is above 100MB", async () => {
      // Return stats indicating ~500MB available (above the 100MB threshold)
      mockedStatfs.mockResolvedValueOnce({
        bavail: 500 * 256, // 500MB worth of blocks
        bsize: 4096,
        type: 0,
        blocks: 1000000,
        bfree: 500 * 256,
        files: 100000,
        ffree: 50000,
      } as any);

      const logger = await createSessionLogger(TEST_LOG_DIR);

      logger.log(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file" } },
        "client->server",
      );

      await logger.close();

      const content = await readFile(logger.logPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
    });
  });

  describe("Per-session size cap (50MB)", () => {
    it("stops writing after session log exceeds MAX_LOG_SIZE_BYTES", async () => {
      // Allow statfs to pass (plenty of space)
      mockedStatfs.mockResolvedValueOnce({
        bavail: 500 * 256,
        bsize: 4096,
        type: 0,
        blocks: 1000000,
        bfree: 500 * 256,
        files: 100000,
        ffree: 50000,
      } as any);

      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const logger = await createSessionLogger(TEST_LOG_DIR);

      // Build a payload large enough that a few writes will exceed 50MB
      // Each entry will be ~1MB of payload
      const bigPayload = "x".repeat(1024 * 1024); // 1MB string
      const MAX_LOG_SIZE_BYTES = 50 * 1024 * 1024;

      let entriesWritten = 0;
      // Write 55 entries of ~1MB each to exceed the 50MB cap
      for (let i = 0; i < 55; i++) {
        logger.log(
          { jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "test", data: bigPayload } },
          "client->server",
        );
        entriesWritten++;
      }

      await logger.close();

      // Verify the cap warning was emitted
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("50MB cap"),
      );

      // Verify the log file exists but is smaller than what 55 entries would be
      const content = await readFile(logger.logPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      // Should have fewer than 55 lines since the cap kicked in
      expect(lines.length).toBeLessThan(55);
      expect(lines.length).toBeGreaterThan(0);

      // Total file size should be roughly around 50MB (the entries that fit)
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(MAX_LOG_SIZE_BYTES + 2 * 1024 * 1024); // small margin

      stderrSpy.mockRestore();
    });
  });

  describe("Graceful degradation", () => {
    it("proxy functions normally when logging is disabled due to disk space", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      // Simulate low disk space
      mockedStatfs.mockResolvedValueOnce({
        bavail: 10 * 256, // ~10MB, well below threshold
        bsize: 4096,
        type: 0,
        blocks: 1000000,
        bfree: 10 * 256,
        files: 100000,
        ffree: 50000,
      } as any);

      const logger = await createSessionLogger(TEST_LOG_DIR);

      // All of these should not throw, even though logging is disabled
      expect(() => {
        logger.log(
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file" } },
          "client->server",
        );
      }).not.toThrow();

      expect(() => {
        logger.log(
          { jsonrpc: "2.0", id: 1, result: { content: "file contents" } },
          "server->client",
        );
      }).not.toThrow();

      expect(() => {
        logger.log(
          { jsonrpc: "2.0", id: 2, error: { code: -32600, message: "Permission denied" } },
          "server->client",
        );
      }).not.toThrow();

      expect(() => {
        logger.logError("upstream-stderr", "something went wrong");
      }).not.toThrow();

      // close() should also work without error
      await expect(logger.close()).resolves.not.toThrow();

      // closeSync should also not throw
      // (already closed, but double-close should be safe)
      expect(() => logger.closeSync()).not.toThrow();

      // Session ID should still be valid
      expect(logger.sessionId).toMatch(/^session_\d{8}_\d{6}_[a-f0-9]{8}$/);

      stderrSpy.mockRestore();
    });

    it("alert callbacks still fire when logging is disabled", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      mockedStatfs.mockResolvedValueOnce({
        bavail: 5 * 256,
        bsize: 4096,
        type: 0,
        blocks: 1000000,
        bfree: 5 * 256,
        files: 100000,
        ffree: 50000,
      } as any);

      const logger = await createSessionLogger(TEST_LOG_DIR);
      const alerts: unknown[] = [];
      logger.onAlert = (alert) => alerts.push(alert);

      // Send an error response -- should trigger the alert callback
      logger.log(
        { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Tool not found" } },
        "server->client",
      );

      // The alert callback should have fired even though disk logging is off
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toEqual(
        expect.objectContaining({
          severity: "error",
          message: "Tool not found",
        }),
      );

      await logger.close();
      stderrSpy.mockRestore();
    });

    it("handles statfs failure gracefully by keeping logging enabled", async () => {
      // If statfs itself fails, logging should remain enabled
      mockedStatfs.mockRejectedValueOnce(new Error("ENOSYS: function not implemented"));

      const logger = await createSessionLogger(TEST_LOG_DIR);

      logger.log(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file" } },
        "client->server",
      );

      await logger.close();

      // Log file should exist and contain the entry
      const content = await readFile(logger.logPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
    });
  });
});
