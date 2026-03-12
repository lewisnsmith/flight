import { readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { homedir } from "node:os";

const DEFAULT_LOG_DIR = join(homedir(), ".flight", "logs");

export interface CompressOptions {
  maxAgeMs?: number;
}

export interface GcOptions {
  maxSessions?: number;
  maxBytes?: number;
  dryRun?: boolean;
}

export interface PruneOptions {
  before?: Date;
  keep?: number;
}

export async function compressOldSessions(
  logDir: string = DEFAULT_LOG_DIR,
  options: CompressOptions = {},
): Promise<{ compressed: number }> {
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  let compressed = 0;

  try {
    const files = await readdir(logDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl") && !f.startsWith("."));

    for (const file of jsonlFiles) {
      const filePath = join(logDir, file);
      const s = await stat(filePath);
      if (s.mtimeMs < cutoff) {
        const gzPath = filePath + ".gz";
        await pipeline(
          createReadStream(filePath),
          createGzip(),
          createWriteStream(gzPath),
        );
        await rm(filePath);
        compressed++;
      }
    }
  } catch {
    // Directory may not exist
  }

  return { compressed };
}

async function getSessionFiles(logDir: string): Promise<Array<{ name: string; path: string; mtimeMs: number; size: number }>> {
  try {
    const files = await readdir(logDir);
    const sessionFiles = files.filter((f) => (f.endsWith(".jsonl") || f.endsWith(".jsonl.gz")) && !f.startsWith("."));

    const result = [];
    for (const file of sessionFiles) {
      const filePath = join(logDir, file);
      const s = await stat(filePath);
      result.push({ name: file, path: filePath, mtimeMs: s.mtimeMs, size: s.size });
    }

    result.sort((a, b) => a.mtimeMs - b.mtimeMs);
    return result;
  } catch {
    return [];
  }
}

export async function garbageCollect(
  logDir: string = DEFAULT_LOG_DIR,
  options: GcOptions = {},
): Promise<{ deleted: number; freedBytes: number; dryRun: boolean }> {
  const maxSessions = options.maxSessions ?? 100;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
  const dryRun = options.dryRun ?? false;

  const files = await getSessionFiles(logDir);
  let totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  let deleted = 0;
  let freedBytes = 0;

  for (const file of files) {
    const overCount = (files.length - deleted) > maxSessions;
    const overSize = totalBytes > maxBytes;

    if (!overCount && !overSize) break;

    if (!dryRun) {
      await rm(file.path);
    }
    deleted++;
    freedBytes += file.size;
    totalBytes -= file.size;
  }

  return { deleted, freedBytes, dryRun };
}

export async function pruneSessions(
  logDir: string = DEFAULT_LOG_DIR,
  options: PruneOptions = {},
): Promise<{ deleted: number }> {
  const files = await getSessionFiles(logDir);
  let deleted = 0;

  if (options.before) {
    const cutoff = options.before.getTime();
    for (const file of files) {
      if (file.mtimeMs < cutoff) {
        await rm(file.path);
        deleted++;
      }
    }
  }

  if (options.keep !== undefined) {
    const remaining = await getSessionFiles(logDir);
    const toDelete = remaining.length - options.keep;
    if (toDelete > 0) {
      for (let i = 0; i < toDelete; i++) {
        await rm(remaining[i].path);
        deleted++;
      }
    }
  }

  return { deleted };
}
