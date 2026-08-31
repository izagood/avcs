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

  // Early-warning inspection cursor (#55): an index into the LOCAL objlog.
  //
  // The alert used to inspect "oids this iteration's long-poll announced that are not yet in
  // the store". That is a delta of ONE pull — but ops arrive through several: the initial
  // sync below, the echo iteration's sync, a user's manual `avcs pull`. Whichever of those
  // got the op first made `store.has` true, dropping it from the delta; and once the shared
  // pull cursor moved past it, every later long-poll was a heartbeat, which `continue`d
  // before the alert pass. The alert was not late — it was never coming. Measured before the
  // fix: 5/5 alerts delivered without a racing pull, 5/5 lost with one.
  //
  // The local objlog is the definition that does not care which path delivered the object:
  // `store.put` appends every newly-written object in arrival order, so "what this replica
  // has not inspected yet" is exactly `objlog.slice(inspected)`. Snapshot BEFORE the initial
  // sync so work that predates the watcher (a restart, a late start) is inspected too.
  // `readObjLog` backfills itself when the file is missing, so the snapshot is never partial
  // in a way that would leak old history into the first delta.
  let inspected = (await repo.store.readObjLog()).length;

  /**
   * Alert on every not-yet-inspected arrival. Grouped per (actor, line) rather than one
   * `contention()` call per op: the query is keyed on (keys, actor, line) anyway, and per-op
   * calls made the first pass after a big initial sync quadratic-ish. Grouping keeps the
   * same warnings — only a same-key duplicate (two fresh ops by one actor on one key)
   * collapses to the latest op, which is a dedupe rather than a loss.
   */
  const alertPass = async (): Promise<void> => {
    const log = await repo.store.readObjLog();
    if (log.length <= inspected) return;
    const fresh = log.slice(inspected);
    inspected = log.length;

    const groups = new Map<string, { actorId: string; line: string; keys: Set<string>; opByKey: Map<string, string> }>();
    for (const oid of fresh) {
      let obj;
      try { obj = await repo.store.get(oid); } catch { continue; }
      if (obj.type !== "operation") continue;
      const op = obj as Operation;
      if (op.private) continue;
      // Our own authorings and their hub echoes are not "incoming" — the alert's meaning is
      // "someone ELSE's op landed on your key". Known only when the daemon says who it is.
      if (opts.as && op.actor.id === opts.as) continue;
      const gk = `${op.actor.id}\n${op.line ?? "main"}`;
      let g = groups.get(gk);
      if (!g) { g = { actorId: op.actor.id, line: op.line ?? "main", keys: new Set(), opByKey: new Map() }; groups.set(gk, g); }
      for (const k of keysOf(op)) { g.keys.add(k); g.opByKey.set(k, oid); }
    }

    for (const g of groups.values()) {
      const warnings = await repo.contention({ keys: [...g.keys], actorId: g.actorId, line: g.line });
      for (const w of warnings) {
        if (!w.theirs.length) continue;
        const incomingOp = g.opByKey.get(w.key);
        if (!incomingOp) continue;
        emit({
          type: "contention",
          key: w.key,
          incomingOp,
          incomingActor: g.actorId,
          localOps: w.theirs.map((t) => ({ op: t.op, actor: t.actor, purpose: t.purpose })),
        });
      }
    }
  };

  // Initial full convergence — also seeds the shared objlog cursor for the long-poll.
  try {
    const r = await repo.sync(remote, { as: opts.as });
    emit({ type: "synced", pulled: r.pulled, pushed: r.pushed });
    lastHeads = await headRefs(repo);
    for (const [view, cp] of lastHeads) emit({ type: "head", view, checkpoint: cp });
    await alertPass(); // work that predates the watcher arrives HERE, not via a long-poll
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
        // The hub saw nothing new PAST OUR SHARED CURSOR — but a racing pull (the echo
        // iteration's own sync, a manual `avcs pull`) may have both delivered ops and moved
        // that cursor past them. Those arrivals exist only in the local objlog now, and this
        // is the only place they can still be inspected: every later long-poll is another
        // heartbeat. So look before parking again.
        await alertPass();
        emit({ type: "heartbeat", cursor: payload.cursor });
        continue;
      }
    } else {
      await sleep(timeoutMs, signal);
      if (signal?.aborted) break;
    }


    try {
      const r = await repo.sync(remote, { as: opts.as });
      emit({ type: "synced", pulled: r.pulled, pushed: r.pushed });
      backoff = minBackoff;

      const heads = await headRefs(repo);
      for (const [view, cp] of heads) if (lastHeads.get(view) !== cp) emit({ type: "head", view, checkpoint: cp });
      lastHeads = heads;

      // Early conflict warning (Phase 15.3): an incoming op landed on a key that has
      // live local work by someone else — "agent B's op arrived on your key K", raised
      // at ARRIVAL time instead of at finalize. Driven by the local objlog delta (#55),
      // so it holds no matter which path delivered the op.
      await alertPass();
    } catch (e) {
      if (signal?.aborted) break;
      emit({ type: "error", error: String((e as Error).message), backoffMs: backoff });
      await sleep(backoff + Math.floor(Math.random() * backoff), signal);
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  }

  emit({ type: "stopped", reason: signal?.aborted ? "aborted" : "loop-exit" });
}
