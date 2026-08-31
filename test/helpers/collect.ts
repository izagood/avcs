/**
 * Event-driven waiting for a push-based stream (issue #55).
 *
 * `until` polls, and polling cannot distinguish "the condition is false" from "there was no
 * turn to evaluate it". #55 handled the second with `minPolls`, correctly. But the recent
 * failures report **160 polls / 8001 ms** — 160 evaluations means there were turns, and the
 * condition really was false for eight seconds.
 *
 * The cause is work, not starvation. Under `AVCS_VERIFY_INCREMENTAL=1` a full reduce runs per
 * operation, so the watch cycle itself slows down; miss four cycles and the budget is gone.
 * Raising the budget makes the same defect rarer and delays every genuine failure by the same
 * amount — the tradeoff `until`'s own doc argues against.
 *
 * So this changes HOW the wait works rather than how long it waits. `runSyncWatch` already
 * hands every event to a callback; feeding that callback here wakes the waiter the instant the
 * event arrives, and how many cycles it took stops mattering. The timeout survives only as a
 * backstop for a genuine hang, and it reports how many events it did see — which separates
 * "nothing arrived" from "things arrived, none matched".
 */
export interface WaitOptions {
  label?: string;
  /** Backstop for a genuine hang. Generous on purpose: it no longer paces the wait. */
  timeoutMs?: number;
}

export interface Collector<T> {
  /** Feed this to the producer's callback. */
  push: (event: T) => void;
  /** Everything seen so far, in arrival order. */
  readonly all: readonly T[];
  /** Waiters not yet settled — a test can assert none leak. */
  readonly pending: number;
  /** Resolve as soon as some event satisfies `match`, including one already seen. */
  waitFor: (match: (event: T) => boolean, opts?: WaitOptions) => Promise<T>;
}

export function collector<T>(): Collector<T> {
  const all: T[] = [];
  const waiters = new Set<{ match: (e: T) => boolean; resolve: (e: T) => void }>();

  return {
    push(event: T): void {
      all.push(event);
      // Copy before iterating: a resolved waiter is removed from the set inside the loop.
      for (const w of [...waiters]) {
        if (w.match(event)) {
          waiters.delete(w);
          w.resolve(event);
        }
      }
    },
    get all(): readonly T[] {
      return all;
    },
    get pending(): number {
      return waiters.size;
    },
    waitFor(match: (event: T) => boolean, opts: WaitOptions = {}): Promise<T> {
      // Already here? Then the wait is not a wait. Checking first is what makes this safe to
      // call after the event may have landed — a polling wait got that for free.
      const seen = all.find(match);
      if (seen !== undefined) return Promise.resolve(seen);

      const label = opts.label ?? "event";
      const timeoutMs = opts.timeoutMs ?? 30_000;
      return new Promise<T>((resolve, reject) => {
        const waiter = { match, resolve: (e: T) => { clearTimeout(timer); resolve(e); } };
        waiters.add(waiter);
        const timer = setTimeout(() => {
          // Drop the waiter, or a later `push` wakes a promise nobody is holding.
          waiters.delete(waiter);
          reject(new Error(
            `timed out waiting for ${label} after ${timeoutMs}ms; saw ${all.length} event(s)`,
          ));
        }, timeoutMs);
        // NOT unref'd. An unref'd timer does not fire when the loop has nothing else to do,
        // so the backstop silently stops being one — and the test runner then cancels the
        // test for an unsettled promise rather than failing it, which reads as green
        // (`# fail 0` with `# cancelled 3`). Both paths clear the timer, so it holds the
        // process only while a wait is genuinely outstanding.
      });
    },
  };
}
