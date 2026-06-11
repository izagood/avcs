// Logical + wall clock.
//
// Causal ordering in AVCS is driven by `causal_deps` (a DAG), but the reducer needs
// a deterministic tie-break for genuinely concurrent operations. We use a Lamport
// timestamp carried on each operation, with the object id as the final tie-break so
// that ordering is total and replica-independent.
//
// Wall-clock time is recorded for humans/telemetry only; it is never used to decide
// who wins a conflict (last-write-wins is a Phase-N fallback, not a default).

export interface Stamp {
  /** Lamport logical time. */
  lamport: number;
  /** Wall clock, ISO-8601. Advisory only. */
  wall: string;
}

/** Monotonic Lamport clock for a single actor/process. */
export class LamportClock {
  #t: number;
  constructor(start = 0) {
    this.#t = start;
  }
  /** Local event: advance and return. */
  tick(): number {
    return ++this.#t;
  }
  /** Receiving a remote stamp: merge then advance. */
  observe(remote: number): number {
    this.#t = Math.max(this.#t, remote) + 1;
    return this.#t;
  }
  get value(): number {
    return this.#t;
  }
}

export function nowStamp(clock: LamportClock): Stamp {
  return { lamport: clock.tick(), wall: new Date().toISOString() };
}
