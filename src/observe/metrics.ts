// Phase/M4 (docs/10 WS-F): minimal in-process metrics. Counters for events and
// timings for latencies, with a JSON snapshot for /metrics-style scraping or a CLI.
// No dependency, no I/O — production would forward `snapshot()` to Prometheus/OTel.

export interface Timing {
  count: number;
  totalMs: number;
  maxMs: number;
}

export class Metrics {
  #counters = new Map<string, number>();
  #timings = new Map<string, Timing>();

  inc(name: string, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  observe(name: string, ms: number): void {
    const t = this.#timings.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    t.count += 1;
    t.totalMs += ms;
    t.maxMs = Math.max(t.maxMs, ms);
    this.#timings.set(name, t);
  }

  /** Time an async operation, recording its duration under `name`. */
  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.observe(name, performance.now() - start);
    }
  }

  snapshot(): { counters: Record<string, number>; timings: Record<string, Timing & { avgMs: number }> } {
    const counters: Record<string, number> = {};
    for (const [k, v] of [...this.#counters].sort()) counters[k] = v;
    const timings: Record<string, Timing & { avgMs: number }> = {};
    for (const [k, t] of [...this.#timings].sort()) {
      timings[k] = { ...t, avgMs: t.count ? t.totalMs / t.count : 0 };
    }
    return { counters, timings };
  }

  reset(): void {
    this.#counters.clear();
    this.#timings.clear();
  }
}
