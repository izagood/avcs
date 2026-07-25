// Phase 16 M4.3 (docs/18 §4.3) — the local repo watcher behind MCP notifications.
//
// Why polling is the correctness path: a MISSED head advance is precisely the failure this
// feature exists to prevent, and `fs.watch` drops events differently on every platform
// (coalescing, missing subdirectories, silently dying on some network mounts). So state is
// compared on an interval, and fs.watch — if wired at all — only pokes the loop early.
//
// The detector is separated from the SDK notification plumbing so it can be driven directly
// in tests: `poll()` returns the events, the server decides how to send them.
//
// Scope note for foreign-op alerts: a stdio MCP server is one process per client, so the
// keys this client authored on (fed in via trackKeys) are exactly the right hot set.

import { keysOf } from "../reducer/reducer.ts";
import type { Repo } from "../api/repo.ts";
import type { Operation } from "../objects/types.ts";

export type WatchEvent =
  | { type: "objects-arrived"; count: number }
  | { type: "head-advanced"; view: string; head: string }
  | { type: "foreign-op-hot-key"; key: string; op: string; actor: string }
  | { type: "conflict-opened"; key: string; id: string };

export interface WatcherOpts {
  /** This client's actor id — its own operations are never a "foreign op" alert. */
  selfActor?: string;
  /** Views whose head to watch; default ["main"]. */
  views?: string[];
}

export class RepoWatcher {
  readonly #repo: Repo;
  readonly #selfActor: string | undefined;
  readonly #views: string[];
  #hotKeys = new Set<string>();

  // Baseline state. `#primed` is the distinction between "arrived at a repo that already
  // had history" (not an event) and "something changed while we watched" (an event).
  #primed = false;
  #logLength = 0;
  #heads = new Map<string, string>();
  #conflicts = new Set<string>();
  #seenOps = new Set<string>();

  constructor(repo: Repo, opts: WatcherOpts = {}) {
    this.#repo = repo;
    this.#selfActor = opts.selfActor;
    this.#views = opts.views ?? ["main"];
  }

  /** Keys this client is working on; a foreign op on one of them is worth interrupting for. */
  trackKeys(keys: string[]): void {
    for (const k of keys) this.#hotKeys.add(k);
  }

  /**
   * Compare current state against the baseline and return what changed. The first call
   * only primes. Never throws: a watcher that takes the server down with it when the repo
   * is deleted or mid-write is worse than one that misses a tick.
   */
  async poll(): Promise<WatchEvent[]> {
    try {
      return await this.#poll();
    } catch {
      return [];
    }
  }

  async #poll(): Promise<WatchEvent[]> {
    const events: WatchEvent[] = [];
    const log = await this.#repo.store.readObjLog();
    const ops = await this.#repo.store.collect<Operation>("operation");

    const heads = new Map<string, string>();
    const conflicts = new Set<string>();
    const conflictRows: { key: string; id: string }[] = [];
    for (const view of this.#views) {
      const head = await this.#repo.protectedHead(view);
      if (head) heads.set(view, head);
      const res = await this.#repo.materialize(view);
      for (const c of res.conflicts) {
        conflicts.add(c.id);
        conflictRows.push({ key: c.key, id: c.id });
      }
    }

    if (!this.#primed) {
      this.#primed = true;
      this.#logLength = log.length;
      this.#heads = heads;
      this.#conflicts = conflicts;
      this.#seenOps = new Set(ops.map((o) => o.oid as string));
      return [];
    }

    if (log.length > this.#logLength) events.push({ type: "objects-arrived", count: log.length - this.#logLength });

    for (const [view, head] of heads) {
      if (this.#heads.get(view) !== head) events.push({ type: "head-advanced", view, head });
    }

    for (const op of ops) {
      const oid = op.oid as string;
      if (this.#seenOps.has(oid)) continue;
      if (this.#selfActor && op.actor.id === this.#selfActor) continue;
      for (const key of keysOf(op)) {
        if (this.#hotKeys.has(key)) events.push({ type: "foreign-op-hot-key", key, op: oid, actor: op.actor.id });
      }
    }

    for (const c of conflictRows) {
      if (!this.#conflicts.has(c.id)) events.push({ type: "conflict-opened", key: c.key, id: c.id });
    }

    this.#logLength = log.length;
    this.#heads = heads;
    this.#conflicts = conflicts;
    this.#seenOps = new Set(ops.map((o) => o.oid as string));
    return events;
  }
}

/** Poll interval from the environment. 0 disables the watcher entirely. */
export function watchIntervalMs(): number {
  const raw = Number(process.env.AVCS_MCP_WATCH_MS ?? "3000");
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 3000;
}
