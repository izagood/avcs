// A bounded wait. Runs `fn` but never waits longer than `ms`; on timeout it returns
// a sentinel so the caller can decide what to do (the git-bridge hooks fail open —
// see #33: a hook must never hard-block the underlying git operation indefinitely).
//
// This bounds *async* work that makes progress through the event loop (store scans,
// file I/O, reduction). It cannot interrupt a purely synchronous CPU-bound section,
// which would also starve the timer — but the observed hook hangs are I/O-bound
// loops over the object store, which this covers.

export type DeadlineResult<T> = { ok: true; value: T } | { ok: false; timedOut: true };

/** Default bound for a git-bridge hook phase (#33). Generous enough for a large-diff
 *  ingest under contention, short enough that a hung hook never strands `git`. */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/**
 * Resolve the git-hook deadline from the environment. `AVCS_HOOK_TIMEOUT_MS=0`
 * explicitly disables the bound (restores the old block-forever behavior); a missing,
 * empty, non-numeric, or negative value falls back to {@link DEFAULT_HOOK_TIMEOUT_MS}.
 */
export function hookTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AVCS_HOOK_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_HOOK_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_HOOK_TIMEOUT_MS;
  return n;
}

/**
 * Await `fn()` for at most `ms` milliseconds. Resolves `{ok:true, value}` if it
 * finishes in time, or `{ok:false, timedOut:true}` if the deadline elapses first.
 * A non-positive `ms` disables the bound (await `fn` to completion). Errors thrown
 * by `fn` propagate unchanged — a timeout is distinct from a failure.
 */
export async function withDeadline<T>(fn: () => Promise<T>, ms: number): Promise<DeadlineResult<T>> {
  if (!(ms > 0)) return { ok: true, value: await fn() };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DeadlineResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
  });
  try {
    return await Promise.race([fn().then((value): DeadlineResult<T> => ({ ok: true, value })), timeout]);
  } finally {
    // Always clear the timer so it never outlives the call (no unref needed: a live
    // timer here means we're still racing, which is exactly when it must stay armed).
    if (timer) clearTimeout(timer);
  }
}

/**
 * The hard deadline that backs a cooperative stop at `ms` (#181). The capture is asked to stop
 * at `ms` and needs a moment to finish the op in flight and flush its staged batch; only if it
 * cannot stop on its own does the process get exited, at this later bound. `0` (unbounded)
 * stays unbounded.
 */
export function hardDeadlineMs(ms: number): number {
  return ms > 0 ? ms + Math.min(ms, 15_000) : 0;
}
