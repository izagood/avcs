// Network object-gossip client against an AVCS hub (see hubServer.ts).
//
// Content-addressed union semantics, mirroring Repo.pull: only transfer what's missing,
// never mutate an existing object. push = send objects the hub lacks; pull = fetch
// objects we lack. Uses the global fetch available in Node 22.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ObjectStore } from "../store/objectStore.ts";
import { keysOf } from "../reducer/reducer.ts";
import { buildAuthHeader } from "./transportAuth.ts";
import type { AnyObject, Operation } from "../objects/types.ts";

/** The local actor key used to authenticate a write to a hub (SSH-style transport auth,
 *  see transportAuth.ts). Optional: omit against a read-public/ungated hub that requires
 *  no transport credential. The same keypair already used to sign objects is reused. */
export interface HubSigner {
  keyId: string;
  privateKey: string;
}

/**
 * The repository this remote addresses, as the signed `scope` (issue #49).
 *
 * The pathname of the remote base: `https://host/acme/web` → "/acme/web", and a rootless
 * `https://host` → "" (unscoped, exactly as before). A multi-tenant hub mounts per
 * repository, so this is the same prefix it strips to recover the endpoint the client
 * signed — which is why both sides can agree on it without the client knowing the
 * server's routing.
 */
function scopeOf(hubUrl: string): string {
  try {
    const p = new URL(hubUrl).pathname.replace(/\/$/, "");
    return p === "/" ? "" : p;
  } catch {
    return "";
  }
}

/** Build fetch headers for a hub write, attaching an AVCS-Sig Authorization header when a
 *  signer is supplied. `path` must equal the server's pathname or the signature won't verify. */
function writeHeaders(signer: HubSigner | undefined, method: string, path: string, body: string, scope = ""): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signer) headers["authorization"] = buildAuthHeader({ keyId: signer.keyId, privateKey: signer.privateKey, method, path, body, scope });
  return headers;
}

/**
 * Headers for a hub READ (issue #50).
 *
 * The reference hub is read-public (D2), so reads went out bare and the omission was
 * invisible against it. It stops being invisible for an embedder with per-repo access
 * control, which necessarily gates reads — and the failure there is total rather than
 * partial, because `pushToHub` opens with GET /have, so a 401 on reads breaks push too.
 *
 * Best-effort by design: no signer, no header, and a read-public hub is unaffected. The
 * signature covers the method, so a captured GET credential cannot be replayed as a write.
 */
function readHeaders(signer: HubSigner | undefined, path: string, scope = ""): Record<string, string> {
  if (!signer) return {};
  return { authorization: buildAuthHeader({ keyId: signer.keyId, privateKey: signer.privateKey, method: "GET", path, body: "", scope }) };
}

// ── Batched transfer + throttle handling (issue #99) ──────────────────────────
//
// The protocol moved ONE object per HTTP request, so any per-request budget was a throughput
// ceiling: pushing 11,048 objects meant 11,048 POSTs, and the first 429 aborted the lot.
// Widening the hub's bucket does not fix that shape — against a sub-millisecond-RTT hub the
// client outruns any sane refill rate. So the delta travels as bundle-shaped chunks
// (`Repo.exportBundle`'s `{ version, objects }`, the primitive that already existed) after the
// negotiation `GET /have` was already doing, and the wanted set comes back the same way.

/** Bound on the exponential backoff for a throttled request. */
export interface RetryOptions {
  /** Extra attempts after the first, on 429 only. Default 6. */
  attempts?: number;
  /** First backoff step, doubled per attempt. Default 250 ms. */
  baseMs?: number;
  /** Ceiling for a single wait, `Retry-After` included. Default 30 s. */
  maxMs?: number;
  /** Ceiling for the TOTAL time spent waiting on one request. Default 60 s. Without it a hub
   *  answering `Retry-After: 60` to every attempt would stall a push for minutes; with it the
   *  client waits a bounded amount and then reports the throttle. */
  budgetMs?: number;
}

/** Tuning for a push/pull. Every field has a default; callers normally pass nothing. */
export interface TransferOptions {
  /** Cap on the JSON bytes of one batched push request. Default 4 MiB, lowered to whatever
   *  smaller `batchMaxBytes` the hub advertises. */
  maxBatchBytes?: number;
  /** Cap on how many oids one batched fetch asks for. Default 512. */
  maxFetchOids?: number;
  retry?: RetryOptions;
}

/**
 * 4 MiB, chosen against the three things that actually bound it:
 *  - the reference hub refuses a body over 64 MiB, so this sits 16× under its hard limit;
 *  - reverse proxies in front of real hubs cap bodies far lower (nginx ships 1 MiB), so a 413
 *    halves the cap and retries rather than failing the push — see `sendBatch`;
 *  - the client holds one chunk's JSON in memory, and a few MiB is free on any machine that
 *    can run a materialize.
 * At avcs object sizes (operations and small blobs, a few hundred bytes each) it puts the
 * 11,048-object push of issue #99 in a handful of requests instead of 11,048.
 */
const DEFAULT_BATCH_BYTES = 4 * 1024 * 1024;
/** Oids per batched fetch. The hub bounds its own RESPONSE size (`truncated`), so this only
 *  keeps the request in the region where one round trip usually suffices. */
const DEFAULT_FETCH_OIDS = 512;
const DEFAULT_RETRY = { attempts: 6, baseMs: 250, maxMs: 30_000, budgetMs: 60_000 };

/** `Retry-After`, in ms: both the delta-seconds and the HTTP-date form (RFC 9110 §10.2.3). */
function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const v = raw.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const when = Date.parse(v);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

/**
 * Every request this file makes, with 429 treated as a WAIT rather than a failure.
 *
 * It wraps the request instead of being sprinkled per call site because every endpoint here
 * can be throttled — `/have`, `/sync`, `/refs`, `/integrate`, `/finalize`, not just the object
 * POST — and one wrapper cannot forget one of them. `Retry-After` wins when the hub sends one;
 * otherwise exponential backoff with equal jitter (half the delay fixed so progress is
 * bounded, half random so a fleet of clients does not resynchronize into the next burst).
 * Attempts AND total wait time are bounded, and the final response is returned unchanged, so a
 * hub that throttles forever — or answers `Retry-After: 3600` — produces the caller's honest
 * error instead of a push that appears to hang.
 *
 * ONLY 429 is retried. A 5xx is not: for a batched write it is ambiguous about what landed,
 * and silently re-sending is a worse answer than reporting it (see `sendBatch`).
 */
async function hubFetch(url: string, init: RequestInit, retry?: RetryOptions): Promise<Response> {
  const attempts = Math.max(0, retry?.attempts ?? DEFAULT_RETRY.attempts);
  const baseMs = Math.max(1, retry?.baseMs ?? DEFAULT_RETRY.baseMs);
  const maxMs = Math.max(1, retry?.maxMs ?? DEFAULT_RETRY.maxMs);
  const budgetMs = Math.max(0, retry?.budgetMs ?? DEFAULT_RETRY.budgetMs);
  let spent = 0;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= attempts) return res;
    const backoff = Math.min(baseMs * 2 ** attempt, maxMs);
    const hinted = parseRetryAfter(res.headers.get("retry-after"));
    const waitMs = Math.min(hinted ?? backoff / 2 + Math.random() * (backoff / 2), maxMs);
    if (spent + waitMs > budgetMs) return res; // out of patience — report the throttle
    spent += waitMs;
    await res.arrayBuffer().catch(() => undefined); // drain, or the socket stays checked out
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/**
 * Capability detection over `GET /version` — the pattern `integrateHub` already uses for the
 * integration queue. avcs is a public client against deployments it does not control, so
 * batching happens only when the hub advertises `batch: true`; anything else (an older hub, an
 * unreachable or gated `/version`) keeps the per-object protocol exactly as it was.
 */
async function hubCaps(base: string, signer: HubSigner | undefined, retry?: RetryOptions): Promise<{ batch: boolean; maxBytes: number | null }> {
  try {
    const res = await hubFetch(`${base}/version`, { headers: readHeaders(signer, "/version", scopeOf(base)) }, retry);
    if (!res.ok) return { batch: false, maxBytes: null };
    const v = (await res.json()) as { batch?: unknown; batchMaxBytes?: unknown };
    const max = typeof v.batchMaxBytes === "number" && v.batchMaxBytes > 0 ? Math.floor(v.batchMaxBytes) : null;
    return { batch: v.batch === true, maxBytes: max };
  } catch {
    return { batch: false, maxBytes: null };
  }
}

/** GET /have → the set of oids the hub holds. */
async function hubHave(hubUrl: string, signer?: HubSigner, retry?: RetryOptions): Promise<Set<string>> {
  const res = await hubFetch(`${hubUrl.replace(/\/$/, "")}/have`, { headers: readHeaders(signer, "/have", scopeOf(hubUrl)) }, retry);
  if (!res.ok) throw new Error(`GET /have failed: ${res.status} ${res.statusText}`);
  const oids = (await res.json()) as string[];
  return new Set(oids);
}

/** Per-hub sync cursors persisted under .avcs/sync-cursors.json (E5). */
async function readCursors(root: string): Promise<Record<string, number>> {
  const p = join(root, "sync-cursors.json");
  if (!existsSync(p)) return {};
  try { return JSON.parse(await readFile(p, "utf8")) as Record<string, number>; } catch { return {}; }
}

/**
 * Discover the oids to consider pulling. Tries the incremental `GET /sync?since=N`
 * endpoint (E5): only the oids appended since the client's last cursor, plus the new
 * cursor. Falls back to the full `GET /have` against an older hub (cursor stays null).
 * Correctness never depends on the cursor — a wrong/stale one at worst transfers more.
 */
async function discover(base: string, since: number, signer?: HubSigner, retry?: RetryOptions): Promise<{ oids: string[]; cursor: number | null }> {
  try {
    const res = await hubFetch(`${base}/sync?since=${since}`, { headers: readHeaders(signer, "/sync", scopeOf(base)) }, retry);
    if (res.ok) {
      const j = (await res.json()) as { oids: string[]; cursor: number };
      return { oids: j.oids, cursor: j.cursor };
    }
  } catch {
    // fall through to /have
  }
  return { oids: [...(await hubHave(base, signer, retry))], cursor: null };
}

/**
 * The push-side ledger (issue #91): op oid → the hub base URLs it was accepted by.
 *
 * `sync-cursors.json` above is a PULL cursor — it says how far this replica has read, and
 * nothing at all about what has left it. Local `undo` needs the other direction: once an op
 * has been replicated, evicting it is a governance act (`redact`), not a local one. Push is
 * a diff against `GET /have` rather than a sequence, so there is no cursor to reuse — the
 * accepted oids are recorded explicitly instead.
 *
 * Records only OPERATIONS: they are what a view selects and therefore what an undo can
 * remove. Blobs travel with them, so an op-level record covers the bytes too.
 */
const PUSHED_OPS = "pushed-ops.json";

async function readPushedOps(store: ObjectStore): Promise<Record<string, string[]>> {
  const raw = await store.readAux(PUSHED_OPS);
  if (!raw) return {};
  try { return JSON.parse(raw.toString("utf8")) as Record<string, string[]>; } catch { return {}; }
}

async function recordPushedOps(store: ObjectStore, base: string, oids: string[]): Promise<void> {
  if (!oids.length) return;
  // Locked: this is read-modify-write, and two concurrent pushes dropping each other's
  // entries would under-record — the one direction this ledger must not fail in.
  await store.withLock("pushed-ops", async () => {
    const ledger = await readPushedOps(store);
    for (const oid of oids) {
      const urls = ledger[oid] ?? [];
      if (!urls.includes(base)) urls.push(base);
      ledger[oid] = urls;
    }
    await store.writeAux(PUSHED_OPS, JSON.stringify(ledger, null, 2) + "\n");
  });
}

/** Mirror Repo.pull's import side-effect: maintain the entity index for imported ops. */
async function indexIfOperation(store: ObjectStore, obj: AnyObject, oid: string): Promise<void> {
  if (obj.type === "operation") {
    for (const k of keysOf(obj as Operation)) await store.appendEntityIndex(k, oid);
  }
}

/**
 * Push objects the hub lacks: diff our local oids against GET /have and send the missing
 * ones — as byte-bounded bundle-shaped chunks (`POST /objects/batch`) when the hub advertises
 * batching, else one POST per object exactly as before. Private (stash) ops are local-only
 * and never gossiped — same rule as Repo.pull. Returns how many objects were pushed and how
 * many the hub refused.
 */
export async function pushToHub(localRepoDir: string, hubUrl: string, signWith?: HubSigner, opts?: TransferOptions): Promise<{ pushed: number; rejected: number }> {
  const base = hubUrl.replace(/\/$/, "");
  const scope = scopeOf(base);
  const store = new ObjectStore(localRepoDir);
  const retry = opts?.retry;
  const have = await hubHave(base, signWith, retry);
  const caps = await hubCaps(base, signWith, retry);
  let mode: "batch" | "single" = caps.batch ? "batch" : "single";
  let cap = Math.max(1, Math.min(opts?.maxBatchBytes ?? DEFAULT_BATCH_BYTES, caps.maxBytes ?? Number.MAX_SAFE_INTEGER));
  let pushed = 0;
  let rejected = 0;
  const acceptedOps: string[] = [];

  /** The original protocol, one POST per object — kept verbatim for a hub without batching. */
  const sendSingles = async (items: ChunkItem[]): Promise<void> => {
    for (const it of items) {
      const res = await hubFetch(`${base}/objects`, {
        method: "POST",
        headers: writeHeaders(signWith, "POST", "/objects", it.json, scope),
        body: it.json,
      }, retry);
      if (res.status === 401) {
        // Transport auth failed (no/invalid request signature): a write-auth hub refused the
        // connection itself. Distinct from 403 (signed in, but this object's role/signature
        // is insufficient). Surface it loudly — retrying object-by-object would all fail.
        throw new Error(`POST /objects unauthorized (401) for ${it.oid}: ${(await res.json().catch(() => ({})) as { error?: string }).error ?? "transport auth required"}`);
      }
      if (res.status === 403) {
        rejected++; // gated hub refused an unauthorized op (object-level role/signature)
        continue;
      }
      if (!res.ok) throw new Error(`POST /objects failed for ${it.oid}: ${res.status} ${res.statusText}`);
      if (it.isOp) acceptedOps.push(it.oid);
      pushed++;
    }
  };

  /**
   * One bundle-shaped request for many objects, preserving every verdict the per-object loop
   * distinguished — that is the whole difficulty of batching here, not the transfer:
   *   401 → transport auth, whole request refused before any work → abort loudly
   *   403 → this hub refused these ops → `rejected`, keep going
   *   per-oid `rejected` → same, for exactly the objects the hub named
   *   per-oid `stored`   → `pushed`, and an operation joins the push ledger
   * Returns "unsupported" when the hub turns out not to speak it after advertising it, so the
   * caller can drop to the per-object protocol instead of failing the push.
   */
  const sendBatch = async (items: ChunkItem[]): Promise<"done" | "unsupported"> => {
    const raw = `{"version":1,"objects":[${items.map((i) => i.json).join(",")}]}`;
    const res = await hubFetch(`${base}/objects/batch`, {
      method: "POST",
      headers: writeHeaders(signWith, "POST", "/objects/batch", raw, scope),
      body: raw,
    }, retry);
    // Advertised but absent (a proxy that does not route it, a downgraded hub behind a LB).
    if (res.status === 404 || res.status === 405 || res.status === 501) return "unsupported";
    if (res.status === 401) {
      // Refused before the hub did any work, so nothing landed and nothing is recorded.
      throw new Error(`POST /objects/batch unauthorized (401): ${(await res.json().catch(() => ({})) as { error?: string }).error ?? "transport auth required"}`);
    }
    if (res.status === 413) {
      // The chunk exceeded a body limit nobody advertised (a reverse proxy, typically).
      // Halve and retry: content-addressed writes are idempotent, so re-sending costs
      // nothing, and the push survives a hub we cannot interrogate.
      if (items.length > 1) {
        cap = Math.max(1, Math.floor(cap / 2));
        const mid = Math.ceil(items.length / 2);
        if ((await sendBatch(items.slice(0, mid))) === "unsupported") return "unsupported";
        return sendBatch(items.slice(mid));
      }
      throw new Error(`POST /objects/batch refused a single ${items[0]!.json.length}-byte object as too large (413): ${items[0]!.oid}`);
    }
    if (res.status === 403) {
      // Whole-request refusal by a gated hub — the same verdict the per-object loop gave
      // each object, so the same accounting: refused, not failed, and nothing recorded.
      rejected += items.length;
      return "done";
    }
    if (!res.ok) {
      // AMBIGUOUS: the hub may have stored part of the chunk before failing, and the wire
      // says nothing about which part. Record the chunk's ops — see the ledger note on the
      // `finally` below for why over-recording is the survivable direction — then report it.
      for (const it of items) if (it.isOp) acceptedOps.push(it.oid);
      throw new Error(`POST /objects/batch failed: ${res.status} ${res.statusText} (${items.length} objects)`);
    }
    const body = (await res.json().catch(() => null)) as { results?: unknown } | null;
    const results = Array.isArray(body?.results) ? (body.results as { oid?: unknown; status?: unknown }[]) : null;
    if (!results || results.length !== items.length) {
      for (const it of items) if (it.isOp) acceptedOps.push(it.oid);
      throw new Error(`POST /objects/batch returned ${results ? String(results.length) : "no"} verdicts for ${items.length} objects — cannot tell what was accepted`);
    }
    // Positional, cross-checked by oid. Attributing a verdict to the wrong object is exactly
    // how the ledger would come to under-record, so a mismatch is not tolerated.
    const unverdicted: ChunkItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const r = results[i]!;
      if (typeof r.oid === "string" && r.oid !== it.oid) { unverdicted.push(it); continue; }
      if (r.status === "stored") {
        if (it.isOp) acceptedOps.push(it.oid);
        pushed++;
      } else if (r.status === "rejected") {
        rejected++;
      } else {
        unverdicted.push(it);
      }
    }
    if (unverdicted.length) {
      for (const it of unverdicted) if (it.isOp) acceptedOps.push(it.oid);
      throw new Error(`POST /objects/batch returned an unusable verdict for ${unverdicted.length} object(s) (first: ${unverdicted[0]!.oid})`);
    }
    return "done";
  };

  const send = async (items: ChunkItem[]): Promise<void> => {
    if (!items.length) return;
    if (mode === "batch") {
      if ((await sendBatch(items)) === "done") return;
      mode = "single";
    }
    await sendSingles(items);
  };

  try {
    let chunk: ChunkItem[] = [];
    let bytes = 2; // the enclosing `[]`
    for await (const obj of store.list()) {
      const oid = obj.oid as string;
      if (have.has(oid)) continue;
      if (obj.type === "operation" && (obj as Operation).private) continue; // stash stays local
      const json = JSON.stringify(obj);
      // Chunked by BYTES, not object count: a single large blob must not blow the request
      // size, and a thousand tiny operations should ride in one request. An object that alone
      // exceeds the cap goes out by itself — it cannot be split, and does not need to be: the
      // per-object protocol would have put exactly those bytes on the wire.
      if (chunk.length && bytes + json.length + 1 > cap) {
        await send(chunk);
        chunk = [];
        bytes = 2;
      }
      chunk.push({ oid, json, isOp: obj.type === "operation" });
      bytes += json.length + 1;
    }
    await send(chunk);
  } finally {
    // In `finally` on purpose: a push that throws part-way still left everything before the
    // throw on the hub, and an undo must refuse those. Under-recording here would let the
    // local path silently rewrite replicated history.
    //
    // Batching adds one case the per-object loop never had: a chunk whose outcome is
    // AMBIGUOUS (a 5xx, an unparseable body, a verdict list that does not line up). The two
    // errors are not symmetric — over-recording refuses an `undo` that would have been legal
    // and points at `redact`, which is recoverable and loud; under-recording lets `undo`
    // rewrite history another replica already holds, which is neither. So every ambiguous
    // chunk is recorded as accepted, and only outcomes where the hub demonstrably did no work
    // (401, 413, no such route) are not.
    await recordPushedOps(store, base, acceptedOps);
  }
  return { pushed, rejected };
}

/** One object queued for transfer: its local oid, its serialized JSON (built once — it is both
 *  the size input for chunking and the request payload), and whether the push ledger cares. */
type ChunkItem = { oid: string; json: string; isOp: boolean };

/**
 * Fetch `wanted` into `store` in as few requests as the hub allows, calling `onObject` for each
 * object that arrives (the caller owns indexing, clock observation and counting).
 *
 * `POST /objects/fetch` when the hub advertises batching, else the original
 * `GET /objects/:oid` loop. POST for a READ deliberately: a wanted set of hundreds of oids does
 * not fit in a URL, and the body is signed exactly as a write body is — the signature covers
 * method, path and body, so the credential cannot be replayed against anything else.
 *
 * Absent oids are simply not returned, mirroring the 404-skip of the per-oid path: a raced
 * eviction is not an error. `truncated` lets the hub bound its own response size, and the
 * remainder is asked for again — bounded by the slice length, so it always terminates.
 */
async function fetchObjects(
  store: ObjectStore,
  base: string,
  wanted: string[],
  signWith: HubSigner | undefined,
  canBatch: boolean,
  opts: TransferOptions | undefined,
  onObject: (obj: AnyObject, oid: string) => Promise<void>,
): Promise<void> {
  const scope = scopeOf(base);
  const retry = opts?.retry;
  const perRequest = Math.max(1, opts?.maxFetchOids ?? DEFAULT_FETCH_OIDS);
  let batch = canBatch;
  for (let i = 0; i < wanted.length; ) {
    const slice = wanted.slice(i, i + perRequest);
    i += slice.length;
    if (batch) {
      let ask = slice;
      for (let round = 0; ask.length && round <= slice.length; round++) {
        const raw = JSON.stringify({ oids: ask });
        const res = await hubFetch(`${base}/objects/fetch`, {
          method: "POST",
          headers: writeHeaders(signWith, "POST", "/objects/fetch", raw, scope),
          body: raw,
        }, retry);
        // Advertised but absent: redo this slice with the per-oid protocol.
        if (res.status === 404 || res.status === 405 || res.status === 501) { batch = false; break; }
        if (!res.ok) throw new Error(`POST /objects/fetch failed: ${res.status} ${res.statusText} (${ask.length} oids)`);
        const j = (await res.json()) as { objects?: unknown; truncated?: unknown };
        const got = Array.isArray(j.objects) ? (j.objects as AnyObject[]) : [];
        const arrived = new Set<string>();
        for (const obj of got) {
          // put() recomputes the content address, so a hub returning something other than
          // what was asked for lands it at its own oid rather than poisoning ours.
          const oid = await store.put(obj as never);
          arrived.add(oid);
          await onObject(obj, oid);
        }
        if (j.truncated !== true) break;
        const remaining = ask.filter((o) => !arrived.has(o));
        if (remaining.length === ask.length) break; // no progress on what we asked for — don't spin
        ask = remaining;
      }
      if (batch) continue;
      i -= slice.length; // fall through to the per-oid loop for this same slice
      continue;
    }
    for (const oid of slice) {
      const path = `/objects/${encodeURIComponent(oid)}`;
      const res = await hubFetch(`${base}${path}`, { headers: readHeaders(signWith, path, scope) }, retry);
      if (res.status === 404) continue; // raced eviction; skip
      if (!res.ok) throw new Error(`GET /objects/${oid} failed: ${res.status} ${res.statusText}`);
      const obj = (await res.json()) as AnyObject;
      await store.put(obj as never);
      await onObject(obj, oid);
    }
  }
}

/**
 * Pull objects the local store lacks: discover what the hub has, then fetch the wanted set
 * and put it locally (idempotent, content-addressed) — batched via POST /objects/fetch when
 * the hub advertises it, else the original GET per oid. Returns how many were pulled,
 * plus the highest Lamport timestamp among the imported operations (0 when none) so
 * the caller can advance its clock past the imported history (Phase 13.2
 * observe-on-import — subsequently issued lamports sort after what was pulled).
 */
export async function pullFromHub(localRepoDir: string, hubUrl: string, signWith?: HubSigner, opts?: TransferOptions): Promise<{ pulled: number; maxLamport: number }> {
  const base = hubUrl.replace(/\/$/, "");
  const store = new ObjectStore(localRepoDir);
  await store.init(); // tolerate a fresh local repo dir
  // Incremental discovery (E5): only consider oids the hub added since our last pull.
  const cursors = await readCursors(store.root);
  const since = cursors[base] ?? 0;
  const { oids, cursor } = await discover(base, since, signWith, opts?.retry);
  const caps = await hubCaps(base, signWith, opts?.retry);
  const wanted: string[] = [];
  for (const oid of oids) if (!(await store.has(oid))) wanted.push(oid);
  let pulled = 0;
  let maxLamport = 0;
  await fetchObjects(store, base, wanted, signWith, caps.batch, opts, async (obj, oid) => {
    await indexIfOperation(store, obj, oid);
    if (obj.type === "operation") maxLamport = Math.max(maxLamport, (obj as Operation).lamport);
    pulled++;
  });
  // Advance the cursor only after the transfer completed (a throw aborts before this, so a
  // failed pull retries from the same cursor next time — never a permanent miss).
  if (cursor !== null) { cursors[base] = cursor; await store.writeAux("sync-cursors.json", JSON.stringify(cursors)); }

  // Governance distribution: adopt the hub's authoritative governance refs (policy,
  // membership, protection, protected heads). The objects they point to were just
  // pulled above, so the refs resolve. Working refs (view:*/checkpoint:*) stay local.
  const refsRes = await hubFetch(`${base}/refs`, { headers: readHeaders(signWith, "/refs", scopeOf(base)) }, opts?.retry);
  if (refsRes.ok) {
    const { refs } = (await refsRes.json()) as { refs: Record<string, string> };
    for (const [name, refOid] of Object.entries(refs)) {
      if (!/^(policy$|member:|protection:|head:)/.test(name)) continue;
      if (await store.has(refOid)) await store.setRef(name, refOid);
    }
  }
  // Propagate redactions: evict plaintext for blobs redacted after we pulled them.
  const { applyRedactions } = await import("./../store/applyRedactions.ts");
  await applyRedactions(store);
  return { pulled, maxLamport };
}

/**
 * Submit a draft checkpoint to the hub's integration queue (Phase 14, docs/17 §14.4):
 * push the local delta, POST /integrate, and on `needs_evidence` pull ONLY the
 * `missingLocally` oids the hub says are needed to reproduce the integrated tree.
 * NO retry loop, NO re-proposal, NO redo — the caller's next action is at most "run
 * validation once against exactly the integrated tree → attach evidence → resubmit the
 * same ticket". Returns the hub's structured verdict plus the HTTP status.
 */
export async function integrateWithHub(
  localRepoDir: string,
  hubUrl: string,
  args: { view: string; checkpoint: string; by: string; ticketId?: string; signWith?: HubSigner },
): Promise<{ status: number; verdict: string } & Record<string, unknown>> {
  const base = hubUrl.replace(/\/$/, "");
  // 1. Delta push: whatever the hub lacks (the draft checkpoint, its ops/blobs, evidence).
  await pushToHub(localRepoDir, hubUrl, args.signWith);
  // 2. One judgment call. Two signatures as with finalize: body.sig authenticates the
  // integrate INTENT (object layer), the Authorization header the REQUEST (transport).
  const body: Record<string, unknown> = { view: args.view, checkpoint: args.checkpoint, by: args.by, ...(args.ticketId ? { ticketId: args.ticketId } : {}) };
  if (args.signWith) {
    const { signMessage } = await import("../core/identity.ts");
    const msg = `integrate:${args.view}:${args.checkpoint}:${args.ticketId ?? ""}`;
    body.sig = { keyId: args.signWith.keyId, alg: "ed25519", sig: signMessage(args.signWith.privateKey, msg) };
  }
  const raw = JSON.stringify(body);
  const res = await hubFetch(`${base}/integrate`, { method: "POST", headers: writeHeaders(args.signWith, "POST", "/integrate", raw, scopeOf(base)), body: raw });
  const j = (await res.json().catch(() => ({}))) as { verdict?: string; missingLocally?: string[] } & Record<string, unknown>;
  // 3. needs_evidence: fetch exactly the head-side delta so `materializeAt` can reproduce
  // the integrated tree locally (determinism guarantees the same treeHash). Same batched
  // read path as `pullFromHub` — this delta is small, but it is the same mechanism, and a
  // raced eviction is skipped there exactly as it was here.
  if (Array.isArray(j.missingLocally) && j.missingLocally.length) {
    const store = new ObjectStore(localRepoDir);
    const wanted: string[] = [];
    for (const oid of j.missingLocally) {
      if (typeof oid !== "string" || (await store.has(oid))) continue;
      wanted.push(oid);
    }
    const caps = await hubCaps(base, args.signWith);
    await fetchObjects(store, base, wanted, args.signWith, caps.batch, undefined, async (obj, oid) => {
      await indexIfOperation(store, obj, oid);
    });
  }
  return { status: res.status, verdict: j.verdict ?? "rejected", ...j };
}

/**
 * Request a finalize (= PR merge) on the hub (E6): POST /finalize with the view, the new
 * checkpoint, the parent head being compare-and-swapped, and the finalizer. The hub runs
 * the authoritative CAS+lock+gates. When `signWith` is given the request is signed so a
 * gated hub can authenticate the finalizer. Returns the HTTP status + the hub's verdict.
 */
export async function finalizeOnHub(
  hubUrl: string,
  args: { view: string; newCheckpoint: string; parentHead: string | null; by: string; signWith?: { keyId: string; privateKey: string } },
): Promise<{ status: number; finalized: boolean; head?: string; reason?: string }> {
  const base = hubUrl.replace(/\/$/, "");
  const body: Record<string, unknown> = { view: args.view, newCheckpoint: args.newCheckpoint, parentHead: args.parentHead, by: args.by };
  if (args.signWith) {
    const { signMessage } = await import("../core/identity.ts");
    const msg = `finalize:${args.view}:${args.newCheckpoint}:${args.parentHead ?? ""}`;
    body.sig = { keyId: args.signWith.keyId, alg: "ed25519", sig: signMessage(args.signWith.privateKey, msg) };
  }
  // The finalize request also carries a transport-auth header (write-auth hubs require it).
  // Two distinct signatures: body.sig authenticates the finalize INTENT (object layer), the
  // Authorization header authenticates the REQUEST (transport layer). Both use one keypair.
  const raw = JSON.stringify(body);
  const res = await hubFetch(`${base}/finalize`, { method: "POST", headers: writeHeaders(args.signWith, "POST", "/finalize", raw, scopeOf(base)), body: raw });
  const j = (await res.json().catch(() => ({}))) as { finalized?: boolean; head?: string; reason?: string };
  return { status: res.status, finalized: j.finalized ?? false, head: j.head, reason: j.reason };
}
