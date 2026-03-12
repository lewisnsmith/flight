import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdir, rm, readdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compressOldSessions, garbageCollect, pruneSessions } from "../src/lifecycle.js";

describe("compressOldSessions", () => {
  const testDir = join(tmpdir(), `flight-lifecycle-${Date.now()}`);

  afterEach(async () => {
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("compresses .jsonl files older than maxAgeMs", async () => {
    await mkdir(testDir, { recursive: true });
    const oldFile = join(testDir, "session_old.jsonl");
    await writeFile(oldFile, '{"test": true}\n');

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(oldFile, twoDaysAgo, twoDaysAgo);

    const result = await compressOldSessions(testDir, { maxAgeMs: 24 * 60 * 60 * 1000 });

    expect(result.compressed).toBe(1);
    const files = await readdir(testDir);
    expect(files.some((f) => f.endsWith(".jsonl.gz"))).toBe(true);
    expect(files.some((f) => f === "session_old.jsonl")).toBe(false);
  });

  it("does not compress recent files", async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, "session_new.jsonl"), '{"test": true}\n');

    const result = await compressOldSessions(testDir, { maxAgeMs: 24 * 60 * 60 * 1000 });

    expect(result.compressed).toBe(0);
    const files = await readdir(testDir);
    expect(files).toContain("session_new.jsonl");
  });
});

describe("garbageCollect", () => {
  const testDir = join(tmpdir(), `flight-gc-${Date.now()}`);

  afterEach(async () => {
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("deletes oldest sessions when count exceeds maxSessions", async () => {
    await mkdir(testDir, { recursive: true });

    for (let i = 0; i < 5; i++) {
      const file = join(testDir, `session_${String(i).padStart(3, "0")}.jsonl`);
      await writeFile(file, `{"i": ${i}}\n`);
      const mtime = new Date(Date.now() - (5 - i) * 1000);
      await utimes(file, mtime, mtime);
    }

    const result = await garbageCollect(testDir, { maxSessions: 3 });

    expect(result.deleted).toBe(2);
    const files = await readdir(testDir);
    expect(files.length).toBe(3);
  });
});

describe("pruneSessions", () => {
  const testDir = join(tmpdir(), `flight-prune-${Date.now()}`);

  afterEach(async () => {
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it("prunes sessions before a given date", async () => {
    await mkdir(testDir, { recursive: true });

    const oldFile = join(testDir, "session_old.jsonl");
    const newFile = join(testDir, "session_new.jsonl");
    await writeFile(oldFile, '{"test": true}\n');
    await writeFile(newFile, '{"test": true}\n');

    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    await utimes(oldFile, twoWeeksAgo, twoWeeksAgo);

    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await pruneSessions(testDir, { before: oneWeekAgo });

    expect(result.deleted).toBe(1);
    const files = await readdir(testDir);
    expect(files).toContain("session_new.jsonl");
    expect(files).not.toContain("session_old.jsonl");
  });
});
