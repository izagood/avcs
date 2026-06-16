// Cross-process advisory lock for the few read-modify-write paths that genuinely
// race (lease acquisition). Most of the store is append-only + content-addressed
// and needs no lock; this is only for "read the current set, decide, then write".
//
// Implemented with mkdir, which is atomic create-if-not-exists on POSIX and Windows:
// exactly one caller wins the directory creation. A stale lock (holder crashed) is
// reclaimed after `staleMs`. Always released in a finally.

import { mkdir, writeFile, readFile, rm, rename } from "node:fs/promises";
import { join } from "node:path";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface LockOptions {
  /** Give up acquiring after this long. */
  maxWaitMs?: number;
  /** Treat a held lock older than this as abandoned and reclaim it. */
  staleMs?: number;
}

/**
 * Run `fn` while holding the named lock under `locksDir`. Serializes concurrent
 * callers (same process or different processes) on the same name.
 */
export async function withLock<T>(
  locksDir: string,
  name: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const maxWaitMs = opts.maxWaitMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  const lockPath = join(locksDir, `${name}.lock`);
  const ownerFile = join(lockPath, "owner");
  const start = Date.now();

  for (;;) {
    try {
      await mkdir(lockPath); // atomic; EEXIST if already held
      // Publish the owner stamp atomically: a waiter must never read a half-written
      // owner file. A torn read (e.g. "pid:" with the timestamp truncated) parses to
      // a tiny number that looks ancient, which would wrongly reclaim a *live* lock
      // and double-grant. writeFile is not atomic, so write-then-rename instead:
      // a reader sees either no owner file (ENOENT → fresh) or the full stamp.
      const tmpOwner = join(lockPath, `owner.${process.pid}.tmp`);
      await writeFile(tmpOwner, `${process.pid}:${Date.now()}`, "utf8");
      await rename(tmpOwner, ownerFile);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        await mkdir(locksDir, { recursive: true }); // locks dir not there yet
        continue;
      }
      if (code !== "EEXIST") throw e;
      // Held by someone — reclaim if stale, else back off.
      let stale = false;
      try {
        const ts = Number((await readFile(ownerFile, "utf8")).split(":")[1]);
        // Only a valid, genuinely-old stamp counts as stale. A missing/garbled stamp
        // (NaN, ≤0, or a future time from a skewed clock) means acquire-in-progress
        // or just-written → treat as fresh, never reclaim.
        if (Number.isFinite(ts) && ts > 0 && Date.now() - ts > staleMs) stale = true;
      } catch {
        // owner file not written yet (acquire-in-progress) → treat as fresh
      }
      if (stale) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > maxWaitMs) throw new Error(`lock timeout acquiring "${name}"`);
      await sleep(5 + Math.floor(Math.random() * 15)); // jittered backoff
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
