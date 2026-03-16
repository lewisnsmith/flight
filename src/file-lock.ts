/**
 * Advisory file locking using atomic O_CREAT|O_EXCL.
 * Caller provides the full lock file path, making this module reusable.
 */

import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_RETRY_MS = 50;
const LOCK_MAX_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;

/**
 * Acquire an advisory file lock at `lockPath`.
 * Returns the lock path on success, or "" on timeout (best-effort — don't block the caller).
 */
export async function acquireLock(lockPath: string): Promise<string> {
  await mkdir(dirname(lockPath), { recursive: true });

  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      // O_CREAT | O_EXCL — atomic creation, fails if file exists
      const handle = await open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return lockPath;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Check for stale lock
        try {
          const content = await readFile(lockPath, "utf-8");
          const lockStat = await stat(lockPath);
          const age = Date.now() - lockStat.mtimeMs;
          if (age > LOCK_STALE_MS) {
            // Stale lock — remove and retry
            try { await unlink(lockPath); } catch { /* race with another cleaner */ }
            continue;
          }
          // Check if the PID is still alive
          const pid = parseInt(content, 10);
          if (pid && !isNaN(pid)) {
            try { process.kill(pid, 0); } catch {
              // Process is dead — stale lock
              try { await unlink(lockPath); } catch { /* race */ }
              continue;
            }
          }
        } catch {
          // Can't read lock file, will retry
        }
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
        continue;
      }
      throw err;
    }
  }
  // Timeout — proceed without lock (best-effort, don't block the session)
  return "";
}

/**
 * Release an advisory file lock. No-op if lockPath is empty (lock was never acquired).
 */
export async function releaseLock(lockPath: string): Promise<void> {
  if (!lockPath) return;
  try { await unlink(lockPath); } catch { /* already removed */ }
}
