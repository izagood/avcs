/**
 * Poll until a condition holds (issue #55).
 *
 * A wall-clock budget alone cannot tell "the condition is false" apart from "the event loop
 * was too busy to evaluate it". Under the full suite other tests block the loop with
 * synchronous work — a full reduce under AVCS_VERIFY_INCREMENTAL=1 especially — so the poll
 * does not get to run, the deadline passes having sampled the condition a couple of times,
 * and a healthy piece of work is reported as a timeout.
 *
 * For scale: the sync-watch contention alert lands in 51–306 ms with a free loop, against an
 * 8 s budget. A failure there was never a slow machine; it was a loop that got no turn.
 *
 * So the budget is spent in POLLS as well as milliseconds: the wait gives up only once it
 * has both run past the deadline AND actually looked `minPolls` times. Raising the
 * millisecond number instead would have made the flake rarer without making the wait honest
 * — and would have delayed every genuine failure by the same amount.
 *
 * The failure message reports the poll count, so a CI log distinguishes "false two hundred
 * times" from "false twice, because nothing ran".
 */
export interface UntilOptions {
  timeoutMs?: number;
  /** Minimum evaluations before a timeout may be declared. Default 20. */
  minPolls?: number;
  label?: string;
  intervalMs?: number;
  /** Injectable clock and start, for testing the starvation path deterministically. */
  now?: () => number;
  startedAt?: number;
}

export async function until(cond: () => Promise<boolean>, opts: UntilOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const minPolls = opts.minPolls ?? 20;
  const intervalMs = opts.intervalMs ?? 50;
  const label = opts.label ?? "condition";
  const now = opts.now ?? Date.now;
  const t0 = opts.startedAt ?? now();
  let polls = 0;
  for (;;) {
    // Errors propagate: a condition that throws is a broken test, not a slow one, and
    // folding it into a timeout hides the stack that explains it.
    if (await cond()) return;
    polls++;
    if (now() - t0 > timeoutMs && polls >= minPolls) {
      throw new Error(`timed out waiting for ${label} after ${polls} polls / ${now() - t0}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
