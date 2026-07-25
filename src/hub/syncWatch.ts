// Phase 15.2 (docs/17 §15.2): the live-convergence daemon behind `avcs sync --watch`.
//
// Loop: long-poll the hub's GET /events (the objlog cursor shared with /sync) → on a
// wake, one incremental sync (cursor pull + redaction propagation + governance-ref
// adoption, then push local deltas) → early conflict warning when an incoming op's keys
// cross local work (Phase 15.3) → structured log. Network errors back off with jitter;
// a hub without /events (pre-v4) degrades to plain periodic polling.
//
// Exactly ONE watcher per repo: the loop runs under the cross-process "syncd" lock,
// kept fresh by the lock heartbeat so a live daemon is never reclaimed as stale while
// a crashed one frees the lock via the normal stale path.

import { keysOf } from "../reducer/reducer.ts";
import type { Repo } from "../api/repo.ts";
import type { Operation } from "../objects/types.ts";

export type SyncWatchEvent =
  | { type: "started"; remote: string; url: string; legacyPolling: boolean }
  | { type: "synced"; pulled: number; pushed: number }
  | { type: "heartbeat"; cursor: number }
  | { type: "head"; view: string; checkpoint: string }
  | {
      type: "contention";
      key: string;
      incomingOp: string;
      incomingActor: string;
      localOps: { op: string; actor: string; purpose: string }[];
    }
  | { type: "error"; error: string; backoffMs: number }
  | { type: "stopped"; reason: "aborted" | "loop-exit" };

export interface SyncWatchOpts {
  /** Remote name (or literal hub URL); default "origin". */
  remote?: string;
  /** Actor identity used to sign pushes (same as `avcs sync --as`). */
  as?: string;
  /** Long-poll parking time per round (also the legacy polling period). */
  timeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Abort to stop the daemon; runSyncWatch resolves after the loop exits. */
  signal?: AbortSignal;
  /** Structured event callback (the CLI prints these; tests observe them). Every event
   *  is also emitted on repo.logger as `watch.<type>`. */
  onEvent?: (ev: SyncWatchEvent) => void;
}

interface EventsPayload {
  cursor: number;
  oids: string[];
  refs: Record<string, string>;
}

/** Abortable sleep that never rejects — an abort just wakes it early. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The client side of the shared objlog cursor: what pullFromHub last recorded. */
async function readCursor(repo: Repo, url: string): Promise<number> {
  const raw = await repo.store.readAux("sync-cursors.json");
  if (!raw) return 0;
  try {
    const cursors = JSON.parse(raw.toString("utf8")) as Record<string, number>;
    return cursors[url] ?? 0;
  } catch {
    return 0;
  }
}

async function longPoll(base: string, since: number, timeoutMs: number, signal?: AbortSignal): Promise<EventsPayload> {
  const res = await fetch(`${base}/events?since=${since}&timeoutMs=${timeoutMs}`, signal ? { signal } : {});
  if (!res.ok) throw new Error(`GET /events failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as EventsPayload;
}

/** Local protected-head refs, view → checkpoint oid. */
async function headRefs(repo: Repo): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [name, oid] of await repo.store.listRefs()) {
    if (name.startsWith("head:")) out.set(name.slice("head:".length), oid);
  }
  return out;
}

/**
 * Run the live-convergence loop until `opts.signal` aborts. Throws immediately when
 * another watcher already holds this repo's "syncd" lock — one instance per repo.
 */
export async function runSyncWatch(repo: Repo, opts: SyncWatchOpts = {}): Promise<void> {
  const remote = opts.remote ?? "origin";
  const url = await repo.remoteUrl(remote);
  try {
    await repo.store.withLock(
      "syncd",
      () => watchLoop(repo, remote, url, opts),
      // The heartbeat keeps the live daemon's stamp fresh; a crashed daemon stops
      // stamping and is reclaimed after staleMs by the next starter.
      { maxWaitMs: 100, staleMs: 60_000, heartbeatMs: 10_000 },
    );
  } catch (e) {
    if (/lock timeout/.test(String((e as Error).message))) {
      throw new Error('sync --watch is already running for this repo (lock "syncd" is held) — one watcher per repo');
    }
    throw e;
  }
}

async function watchLoop(repo: Repo, remote: string, url: string, opts: SyncWatchOpts): Promise<void> {
  const signal = opts.signal;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const minBackoff = opts.minBackoffMs ?? 500;
  const maxBackoff = opts.maxBackoffMs ?? 30_000;
  const emit = (ev: SyncWatchEvent): void => {
    repo.logger.info(`watch.${ev.type}`, ev as unknown as Record<string, unknown>);
    opts.onEvent?.(ev);
  };

  // Capability detection: a pre-v4 hub has no /events — degrade to periodic polling.
  let live = false;
  try {
    const v = (await (await fetch(`${url}/version`, signal ? { signal } : {})).json()) as { events?: boolean };
    live = v.events === true;
  } catch { /* unreachable /version → the loop's error path will report and back off */ }
  emit({ type: "started", remote, url, legacyPolling: !live });

  let backoff = minBackoff;
  let lastHeads = new Map<string, string>();

  // Initial full convergence — also seeds the shared objlog cursor for the long-poll.
  try {
    const r = await repo.sync(remote, { as: opts.as });
    emit({ type: "synced", pulled: r.pulled, pushed: r.pushed });
    lastHeads = await headRefs(repo);
    for (const [view, cp] of lastHeads) emit({ type: "head", view, checkpoint: cp });
  } catch (e) {
    emit({ type: "error", error: String((e as Error).message), backoffMs: backoff });
    await sleep(backoff + Math.floor(Math.random() * backoff), signal);
    backoff = Math.min(backoff * 2, maxBackoff);
  }

  while (!signal?.aborted) {
    let payload: EventsPayload | null = null;
    if (live) {
      const since = await readCursor(repo, url);
      try {
        payload = await longPoll(url, since, timeoutMs, signal);
        backoff = minBackoff;
      } catch (e) {
        if (signal?.aborted) break;
        emit({ type: "error", error: String((e as Error).message), backoffMs: backoff });
        await sleep(backoff + Math.floor(Math.random() * backoff), signal);
        backoff = Math.min(backoff * 2, maxBackoff);
        continue;
      }
      // Heartbeat (nothing new, no head movement) — just park again.
      const headsMoved = Object.entries(payload.refs).some(
        ([name, oid]) => name.startsWith("head:") && lastHeads.get(name.slice("head:".length)) !== oid,
      );
      if (!payload.oids.length && !headsMoved) {
        emit({ type: "heartbeat", cursor: payload.cursor });
        continue;
      }
    } else {
      await sleep(timeoutMs, signal);
      if (signal?.aborted) break;
    }

    // Which of the announced oids are genuinely new HERE? Decided before the pull so
    // the contention pass below only inspects actual arrivals (not our own echoes).
    const incoming: string[] = [];
    if (payload) for (const oid of payload.oids) if (!(await repo.store.has(oid))) incoming.push(oid);

    try {
      const r = await repo.sync(remote, { as: opts.as });
      emit({ type: "synced", pulled: r.pulled, pushed: r.pushed });
      backoff = minBackoff;

      const heads = await headRefs(repo);
      for (const [view, cp] of heads) if (lastHeads.get(view) !== cp) emit({ type: "head", view, checkpoint: cp });
      lastHeads = heads;

      // Early conflict warning (Phase 15.3): an incoming op landed on a key that has
      // live local work by someone else — "agent B's op arrived on your key K", raised
      // at ARRIVAL time instead of at finalize. Perspective is the incoming actor's, so
      // `theirs` is exactly the local work the arrival did not build on.
      for (const oid of incoming) {
        if (!(await repo.store.has(oid))) continue; // announced but not transferred (raced eviction)
        const obj = await repo.store.get(oid);
        if (obj.type !== "operation") continue;
        const op = obj as Operation;
        if (op.private) continue;
        const warnings = await repo.contention({ keys: keysOf(op), actorId: op.actor.id, line: op.line });
        for (const w of warnings) {
          if (!w.theirs.length) continue;
          emit({
            type: "contention",
            key: w.key,
            incomingOp: oid,
            incomingActor: op.actor.id,
            localOps: w.theirs.map((t) => ({ op: t.op, actor: t.actor, purpose: t.purpose })),
          });
        }
      }
    } catch (e) {
      if (signal?.aborted) break;
      emit({ type: "error", error: String((e as Error).message), backoffMs: backoff });
      await sleep(backoff + Math.floor(Math.random() * backoff), signal);
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  }

  emit({ type: "stopped", reason: signal?.aborted ? "aborted" : "loop-exit" });
}
