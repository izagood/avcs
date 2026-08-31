// A self-contained HTTP hub for object-gossip over the network (M2 / docs/10 WS-B).
//
// The hub is just an ObjectStore behind a few minimal endpoints. Because objects are
// content-addressed and append-only, sync is a conflict-free union: clients diff their
// local oid set against the hub's "have" set and transfer only what's missing, in
// either direction. The hub never mutates an existing object (idempotent put).
//
//   GET  /have           → JSON array of every oid the hub holds (the "have" set)
//   GET  /objects/:oid   → the stored object JSON (404 if absent)
//   POST /objects        → store an object (body = object JSON), returns { oid }
//   POST /objects/batch  → store MANY objects in one request, with a per-oid verdict each
//   POST /objects/fetch  → return MANY objects for one wanted-oid list
//
// The two batched endpoints are the whole point of the negotiation (issue #99): moving N
// objects used to take N requests, which made any per-request budget a throughput ceiling.
// They are additive — `GET /version` advertises `batch: true` and a client without it keeps
// the per-object endpoints, which are unchanged.
//
// Node builtins only: node:http + the existing ObjectStore.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { ObjectStore } from "../store/objectStore.ts";
import { verifyMessage } from "../core/identity.ts";
import { computeOid } from "../core/canonical.ts";
import { silentLogger, type Logger } from "../observe/logger.ts";
import { Metrics } from "../observe/metrics.ts";
import { MATERIALIZER_VERSION } from "../reducer/policy.ts";
import { NonceCache, verifyAuth, type PublicKeyResolver } from "./transportAuth.ts";
import type { Signature } from "../core/identity.ts";
import type {
  AnyObject, Membership, Operation, Evidence, Decision, Approval, Promotion, Override, Redaction, RoleName,
} from "../objects/types.ts";

/** Wire-protocol version the hub speaks (have/objects/refs gossip). Bumped on breaking
 *  changes. v2 adds SSH-style transport auth: write endpoints may require an AVCS-Sig
 *  Authorization header (read endpoints stay public). v3 (additive) adds the integration
 *  queue: POST /integrate + GET /integrations/:ticketId; `GET /version` advertises
 *  `integrate: true` so a client can capability-detect before falling back to legacy
 *  POST /finalize (which is unchanged). v4 (additive) adds live convergence (Phase 15):
 *  GET /events long-poll sharing the objlog cursor with /sync; `GET /version` advertises
 *  `events: true` — a client without it falls back to periodic polling. v5 (additive) adds
 *  BATCHED object transfer (issue #99): POST /objects/batch moves many objects in one signed
 *  request with per-oid verdicts, POST /objects/fetch returns many objects for one wanted-oid
 *  list; `GET /version` advertises `batch: true` plus `batchMaxBytes` (the largest body this
 *  hub accepts) — a client without it keeps the per-object POST /objects and GET /objects/:oid
 *  protocol, which is unchanged. */
export const HUB_PROTOCOL_VERSION = 5;

export interface HubHandle {
  url: string;
  port: number;
  metrics: Metrics;
  close(): Promise<void>;
}

const ROLE_WEIGHT: Record<RoleName, number> = { reader: 0, proposer: 1, reviewer: 2, maintainer: 3, admin: 4 };

/**
 * Per-type push authorization for a gated hub (E2). Each MUTATING governance object
 * names the actor that must have signed it and the minimum role that actor needs:
 *  - operation  → its author, ≥ proposer
 *  - evidence   → its producer, ≥ proposer (it feeds trust scoring)
 *  - decision   → its decider, ≥ reviewer (it changes verdictMap on every replica)
 *  - approval / promotion → ≥ reviewer ; override / redaction → admin
 * `membership`/`protection`/`policy` are CENTRAL-authoritative — distributed via
 * `GET /refs`, never pushed by a client — so they are rejected outright. Everything
 * else (blob/intent/session/checkpoint/…) is inert content-addressed data: a forged
 * copy lands at its own oid and changes no replica's reduction, so it is allowed.
 */
type AuthReq = { signerId: string; minRole: RoleName } | "allow" | "reject";
function authRequirement(obj: AnyObject): AuthReq {
  switch (obj.type) {
    case "operation": return { signerId: (obj as Operation).actor.id, minRole: "proposer" };
    case "evidence": return { signerId: (obj as Evidence).producedBy.id, minRole: "proposer" };
    case "decision": return { signerId: (obj as Decision).decidedBy.id, minRole: "reviewer" };
    case "approval": return { signerId: (obj as Approval).by, minRole: "reviewer" };
    case "promotion": return { signerId: (obj as Promotion).by, minRole: "reviewer" };
    case "override": return { signerId: (obj as Override).by, minRole: "admin" };
    case "redaction": return { signerId: (obj as Redaction).by, minRole: "admin" };
    case "membership": case "protection": case "policy": return "reject";
    // Phase 14: integration verdicts are authored ONLY by the integration path (the hub
    // or a local finalize-lock holder). A pushed one would forge queue history — reject;
    // replicas receive genuine ones via normal pull.
    case "integration": return "reject";
    default: return "allow";
  }
}

/**
 * Authorize a pushed object against the hub's membership. Verifies the signer is a
 * non-revoked member with a sufficient role AND that the signature is valid over the
 * RECOMPUTED content oid (E1) — never the client-claimed oid — so hub-accept ⟹
 * replica-accept. Returns a reason string when denied (for the 403 body).
 */
async function authorizePush(store: ObjectStore, obj: AnyObject): Promise<{ ok: true } | { ok: false; reason: string }> {
  const req = authRequirement(obj);
  if (req === "allow") return { ok: true };
  if (req === "reject") return { ok: false, reason: `${obj.type} is central-authoritative; pull it via /refs, do not push` };
  const memRef = await store.getRef(`member:${req.signerId}`);
  if (!memRef || !(await store.has(memRef))) return { ok: false, reason: `signer ${req.signerId} is not a member` };
  const m = await store.get<Membership>(memRef);
  if (m.revokedAt || m.actorId !== req.signerId) return { ok: false, reason: "membership revoked or mismatched" };
  if (ROLE_WEIGHT[m.role] < ROLE_WEIGHT[req.minRole]) return { ok: false, reason: `role ${m.role} below required ${req.minRole}` };
  const sig = (obj as { sig?: Signature }).sig;
  if (!sig) return { ok: false, reason: "object is unsigned" };
  const oid = computeOid(obj.type, obj as unknown as Record<string, unknown>);
  if (!verifyMessage(m.publicKey, oid, sig.sig)) return { ok: false, reason: "signature does not verify over the content oid" };
  return { ok: true };
}

const MAX_BODY = 64 * 1024 * 1024; // 64 MiB guard against unbounded request bodies

/** Read a request body fully into a string, rejecting if it grows past MAX_BODY. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

// ── GET /events long-poll (Phase 15.1, docs/17 §15.1) ─────────────────────────
// Long-poll, not SSE, deliberately: zero-dep, proxy-friendly, the same fetch-loop
// shape hubClient already uses, and ONE cursor meaning — the objlog index shared
// with GET /sync?since=N. A parked waiter is woken by every successful mutation.

/** The state a waiter is answered with: new-since-cursor oids plus the FULL governance
 *  ref map. Refs ride every response because a finalize can move `head:<view>` without
 *  appending any object (the checkpoint was pushed earlier) — with oids alone a parked
 *  client would never see the head advance. Clients diff refs against their last copy. */
async function eventsSnapshot(store: ObjectStore, since: number): Promise<{ cursor: number; oids: string[]; refs: Record<string, string> }> {
  const all = await store.readObjLog();
  // Same cursor semantics as /sync: 0 / out-of-range ⇒ the full set (first poll or a
  // stale cursor); otherwise only what was appended after `since`.
  const oids = since > 0 && since <= all.length ? all.slice(since) : all;
  return { cursor: all.length, oids, refs: Object.fromEntries(await store.listRefs()) };
}

interface EventWaiter {
  fire(): void;
  cancel(): void;
}

/** Parked /events responses + the wake fan-out. Bounded (default 256 waiters, beyond
 *  which new polls get an immediate 503) so parked sockets can't exhaust the process. */
class EventHub {
  #waiters = new Set<EventWaiter>();
  readonly #store: ObjectStore;
  readonly #metrics: Metrics;
  readonly maxWaiters: number;

  constructor(store: ObjectStore, metrics: Metrics, maxWaiters = 256) {
    this.#store = store;
    this.#metrics = metrics;
    this.maxWaiters = maxWaiters;
  }

  get waiterCount(): number {
    return this.#waiters.size;
  }

  /** Park a caught-up poller until a mutation wakes it or `timeoutMs` elapses (then a
   *  heartbeat `{ cursor, oids: [] }` + refs). Sends 503 when the waiter cap is hit. */
  park(res: ServerResponse, since: number, timeoutMs: number): void {
    if (this.#waiters.size >= this.maxWaiters) {
      this.#metrics.inc("hub.events.rejected");
      sendJson(res, 503, { error: `too many event waiters (max ${this.maxWaiters}) — retry with backoff` });
      return;
    }
    let done = false;
    const finish = (respond: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.#waiters.delete(waiter);
      if (!respond || res.writableEnded || res.destroyed) return;
      eventsSnapshot(this.#store, since)
        .then((snap) => { if (!res.writableEnded && !res.destroyed) sendJson(res, 200, snap); })
        .catch(() => { if (!res.writableEnded) res.destroy(); });
    };
    const timer = setTimeout(() => { this.#metrics.inc("hub.events.timeout"); finish(true); }, timeoutMs);
    const waiter: EventWaiter = { fire: () => finish(true), cancel: () => finish(false) };
    this.#waiters.add(waiter);
    this.#metrics.inc("hub.events.parked");
    // The client went away — free the slot without writing to a dead socket.
    res.on("close", () => waiter.cancel());
  }

  /** Called after every successful mutation (object put / finalize / integrate): flush
   *  every parked waiter with a fresh snapshot. Waking on ref-only moves is the point. */
  wake(): void {
    if (!this.#waiters.size) return;
    this.#metrics.inc("hub.events.woken");
    for (const w of [...this.#waiters]) w.fire();
  }
}

/**
 * Start an HTTP hub backed by `new ObjectStore(opts.repoDir)`. The store is init()'d
 * so an empty repo dir works. Pass `port: 0` (or omit) to get an OS-assigned port,
 * read back from the returned handle.
 */
export async function startHub(opts: {
  repoDir: string; port?: number; gated?: boolean; logger?: Logger; metrics?: Metrics;
  /** App-layer per-actor push quota (E7). Omit to disable. */
  rateLimit?: { maxPerWindow: number; windowMs?: number };
  /** SSH-style transport authentication of write requests (read endpoints stay public).
   *  When `required` is true, POST /objects and /finalize must carry a valid AVCS-Sig
   *  Authorization header (see transportAuth.ts) or get a 401. `resolvePublicKey` is the
   *  pluggable hook (D3): an embedder injects its own keyId→publicKey lookup; when omitted
   *  the hub resolves against its own `member:<keyId>` registry. */
  auth?: { required?: boolean; resolvePublicKey?: PublicKeyResolver; windowMs?: number };
  /** Live-convergence long-poll tuning (Phase 15.1). `maxWaiters` bounds concurrently
   *  parked GET /events responses (default 256; beyond it new polls get a 503). */
  events?: { maxWaiters?: number };
}): Promise<HubHandle> {
  const store = new ObjectStore(opts.repoDir);
  await store.init(); // tolerate a fresh/empty repo dir
  const gated = opts.gated ?? false;
  const logger = opts.logger ?? silentLogger();
  const metrics = opts.metrics ?? new Metrics();

  // Transport auth (read-public, write-auth). The default resolver treats the hub's own
  // membership registry as its authorized_keys: a keyId is accepted iff member:<keyId> is a
  // live (non-revoked) membership whose actorId matches, and the request signature verifies
  // against that membership's publicKey — the same key the actor signs objects with.
  const authRequired = opts.auth?.required ?? false;
  const resolvePublicKey: PublicKeyResolver = opts.auth?.resolvePublicKey ?? (async (keyId: string) => {
    const memRef = await store.getRef(`member:${keyId}`);
    if (!memRef || !(await store.has(memRef))) return null;
    const m = await store.get<Membership>(memRef);
    if (m.revokedAt || m.actorId !== keyId) return null;
    return m.publicKey;
  });
  const authCtx: AuthCtx = { required: authRequired, resolve: resolvePublicKey, windowMs: opts.auth?.windowMs, nonceCache: new NonceCache(opts.auth?.windowMs) };

  // E7 operability: per-actor push quota (a rolling-window counter) + an append-only
  // audit log of accepted mutations (provenance beyond the signed object itself).
  const rl = opts.rateLimit;
  const windowMs = rl?.windowMs ?? 60_000;
  const hits = new Map<string, number[]>();
  const allow = (key: string): boolean => {
    if (!rl) return true;
    const now = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= rl.maxPerWindow) { hits.set(key, arr); return false; }
    arr.push(now);
    hits.set(key, arr);
    return true;
  };
  // How long until the oldest recorded hit leaves the window — i.e. when a token actually
  // frees up (issue #99). Sent as `Retry-After` so a throttled client waits the real amount
  // instead of guessing; at least 1, since a 0 would invite an immediate retry.
  const retryAfterSeconds = (key: string): number => {
    const arr = hits.get(key);
    if (!rl || !arr?.length) return 1;
    return Math.max(1, Math.ceil((windowMs - (Date.now() - arr[0]!)) / 1000));
  };
  const audit = async (rec: Record<string, unknown>): Promise<void> => {
    try { await store.appendAux("hub-audit.log", `${JSON.stringify({ ts: new Date().toISOString(), ...rec })}\n`); }
    catch (e) { logger.warn("hub.audit.fail", { error: String((e as Error).message) }); }
  };
  const events = new EventHub(store, metrics, opts.events?.maxWaiters ?? 256);
  const ctx: HubOps = { audit, allow, retryAfterSeconds, events };

  const server: Server = createServer((req, res) => {
    const startedAt = process.hrtime.bigint();
    const path = (req.url ?? "/").split("?")[0]!;
    metrics.inc("hub.requests");
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      metrics.observe("hub.request.ms", ms);
      metrics.inc(`hub.status.${Math.floor(res.statusCode / 100)}xx`);
      logger.info("hub.request", { method: req.method, path, status: res.statusCode, ms: Math.round(ms * 100) / 100 });
    });
    handle(store, req, res, gated, metrics, opts.repoDir, ctx, authCtx).catch((err) => {
      // Last-resort guard: never let a handler rejection crash the server.
      metrics.inc("hub.errors");
      logger.error("hub.error", { method: req.method, path, error: String(err?.message ?? err) });
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) });
      else res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    await new Promise<void>((r) => server.close(() => r()));
    throw new Error("hub failed to bind a TCP port");
  }
  const port = addr.port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    metrics,
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/** Authenticate a finalize request (E6): the signature must be by `by`'s registered
 *  membership key over the canonical finalize message. Role authorization is enforced
 *  separately by repo.finalize (finalizeRole). */
async function verifyFinalizeSig(store: ObjectStore, by: string, view: string, newCheckpoint: string, parentHead: string | null, sig: unknown): Promise<boolean> {
  const s = sig as Signature | undefined;
  if (!s || typeof s.sig !== "string") return false;
  const memRef = await store.getRef(`member:${by}`);
  if (!memRef || !(await store.has(memRef))) return false;
  const m = await store.get<Membership>(memRef);
  if (m.revokedAt || m.actorId !== by) return false;
  return verifyMessage(m.publicKey, `finalize:${view}:${newCheckpoint}:${parentHead ?? ""}`, s.sig);
}

/** Authenticate an integrate request (Phase 14) — the same member-signed pattern as
 *  finalize, over the canonical `integrate:<view>:<checkpoint>:<ticketId>` message. */
async function verifyIntegrateSig(store: ObjectStore, by: string, view: string, checkpoint: string, ticketId: string, sig: unknown): Promise<boolean> {
  const s = sig as Signature | undefined;
  if (!s || typeof s.sig !== "string") return false;
  const memRef = await store.getRef(`member:${by}`);
  if (!memRef || !(await store.has(memRef))) return false;
  const m = await store.get<Membership>(memRef);
  if (m.revokedAt || m.actorId !== by) return false;
  return verifyMessage(m.publicKey, `integrate:${view}:${checkpoint}:${ticketId}`, s.sig);
}

/** E7 operability hooks threaded into the request handler. */
interface HubOps {
  audit(rec: Record<string, unknown>): Promise<void>;
  allow(key: string): boolean;
  /** Seconds until `allow(key)` could succeed again, for a `Retry-After` header (issue #99).
   *  A throttled client should be told how long to wait rather than guess, and the client's
   *  backoff honors the header when it is present. */
  retryAfterSeconds(key: string): number;
  /** Parked GET /events waiters (Phase 15.1) — woken after every successful mutation. */
  events: EventHub;
}

/** Caps on one batched request, so a client cannot make the hub hold an unbounded amount in
 *  memory. Bytes are already bounded by MAX_BODY on the way in; these bound the COUNT of
 *  objects ingested per request and the SIZE of a fetch response the hub builds itself. */
const MAX_BATCH_OBJECTS = 50_000;
const MAX_FETCH_OIDS = 50_000;
const MAX_FETCH_BYTES = 8 * 1024 * 1024;

/** The oid an inbound object claims, for reporting a per-oid verdict on something that was
 *  never stored (so the hub cannot compute its content address). Only ever echoed back — the
 *  client cross-checks it against the oid IT computed and distrusts a mismatch. */
function oidOf(obj: unknown): string | null {
  const o = (obj as { oid?: unknown } | null)?.oid;
  return typeof o === "string" ? o : null;
}

/** E7 per-actor push quota key: the object's signer, else the remote address. */
function rateLimitKey(obj: unknown, req: IncomingMessage): string {
  const actor = typeof (obj as { type?: unknown } | null)?.type === "string" ? attributedActor(obj as AnyObject) : null;
  return actor ? `actor:${actor}` : `addr:${req.socket.remoteAddress ?? "?"}`;
}

/** The verdict on one inbound object: stored at its content address, refused by this hub, or
 *  not an object at all. A single POST /objects maps these to 200/403/400; a batch reports
 *  them per oid so one refusal never aborts the rest of the chunk (issue #99). */
type PutVerdict = { status: "stored"; oid: string } | { status: "rejected"; reason: string } | { status: "invalid"; reason: string };

/**
 * Ingest ONE inbound object — the whole POST /objects pipeline, extracted verbatim so the
 * batch endpoint cannot drift from it. Every gate that guarded the per-object protocol
 * (type shape, E2 push authorization, the always-on redaction check, the Phase 14 integration
 * refusal, oid recomputation, the redaction lock, the audit record, the /events wake) applies
 * identically to a batched object: batching changes how many objects share a request, and
 * nothing about what the hub will accept.
 */
async function ingestObject(store: ObjectStore, obj: unknown, gated: boolean, ops: HubOps): Promise<PutVerdict> {
  if (typeof obj !== "object" || obj === null || typeof (obj as { type?: unknown }).type !== "string") {
    return { status: "invalid", reason: "object must have a string `type`" };
  }
  // Authorize the push (E2). On a gated hub EVERY mutating governance object is
  // checked. A `redaction` is checked ALWAYS — even on an ungated hub (E3): it
  // overwrites blob bytes irrecoverably, so an unauthenticated redaction is a
  // data-destruction DoS. authorizePush requires an admin-signed redaction; an open
  // hub with no admin membership therefore rejects all redactions (no DoS) rather
  // than the old trust-all behavior.
  const isRedaction = (obj as AnyObject).type === "redaction";
  if (gated || isRedaction) {
    const verdict = await authorizePush(store, obj as AnyObject);
    if (!verdict.ok) return { status: "rejected", reason: verdict.reason ?? "unauthorized push" };
  }
  // Phase 14: integration objects are queue-authored only — reject even on an
  // ungated hub (a pushed one would forge queue history at its content address).
  if ((obj as AnyObject).type === "integration") {
    return { status: "rejected", reason: "integration objects are authored by the integration queue; they cannot be pushed" };
  }
  // put() recomputes the oid from content, so a forged/incorrect inbound oid cannot
  // poison the store — it lands at its true content address (or is a no-op if present).
  const oid = await store.put(obj as AnyObject);
  // A pushed (now admin-authorized) redaction evicts the hub's own copy of the blob.
  // Serialize the read-modify-write under a cross-process lock (E3): the scan +
  // overwriteAt over shared blob files must not interleave with a concurrent push or
  // a puller's applyRedactions, or two redactions could race on the same blob.
  if (isRedaction) {
    await store.withLock("redactions", async () => {
      const { applyRedactions } = await import("../store/applyRedactions.ts");
      await applyRedactions(store);
    });
  }
  await ops.audit({ action: "put", type: (obj as AnyObject).type, oid, actor: attributedActor(obj as AnyObject) }); // E7 provenance
  ops.events.wake(); // Phase 15.1: a new object (or re-put) is exactly what waiters wait for
  return { status: "stored", oid };
}

/** Transport-auth context threaded into the request handler (SSH-style write-auth). */
interface AuthCtx {
  required: boolean;
  resolve: PublicKeyResolver;
  windowMs: number | undefined;
  nonceCache: NonceCache;
}

/**
 * Enforce transport auth on a write request. No-op (returns true) when auth is not
 * required — a read-public/ungated hub still accepts unsigned writes, leaving object-level
 * `authorizePush` as the only gate. When required, verifies the AVCS-Sig header over the
 * exact raw body and sends a 401 on failure. A 401 here ("who are you") is deliberately
 * distinct from the 403 `authorizePush` returns ("you may not push THIS object").
 */
async function enforceTransportAuth(auth: AuthCtx, req: IncomingMessage, res: ServerResponse, method: string, path: string, rawBody: string, metrics: Metrics): Promise<boolean> {
  if (!auth.required) return true;
  const result = await verifyAuth({
    header: req.headers["authorization"],
    method, path, body: rawBody,
    resolvePublicKey: auth.resolve,
    now: Date.now(),
    windowMs: auth.windowMs,
    nonceCache: auth.nonceCache,
  });
  if (!result.ok) {
    metrics.inc("hub.unauthenticated");
    sendJson(res, 401, { error: result.reason });
    return false;
  }
  return true;
}

/** The actor a push is attributed to (for the audit log + quota): the object's signer
 *  field when there is one, else null (the caller falls back to the remote address). */
function attributedActor(obj: AnyObject): string | null {
  const req = authRequirement(obj);
  return typeof req === "object" ? req.signerId : null;
}

async function handle(store: ObjectStore, req: IncomingMessage, res: ServerResponse, gated: boolean, metrics: Metrics, repoDir: string, ops: HubOps, auth: AuthCtx): Promise<void> {
  // Parse path only (ignore query); the host is irrelevant for routing.
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // GET /healthz → liveness/readiness probe (O(1), no store scan) for LBs/orchestrators.
  if (method === "GET" && (path === "/healthz" || path === "/health")) {
    sendJson(res, 200, { status: "ok", gated });
    return;
  }

  // GET /version → identify the hub and the gossip protocol/materializer it speaks, so a
  // client can refuse to sync against an incompatible peer.
  if (method === "GET" && path === "/version") {
    // `auth` advertises that writes require an AVCS-Sig credential so a client can attach
    // one up front (and an old client gets a clear 401 instead of a silent rejection).
    // `integrate` advertises the Phase 14 integration queue (capability detection: a
    // client without it falls back to legacy POST /finalize).
    // `events` advertises the Phase 15 live-convergence long-poll (a client without it
    // falls back to periodic polling).
    // `batch` advertises the issue #99 batched object transfer (POST /objects/batch and
    // POST /objects/fetch); `batchMaxBytes` is the largest request body this hub accepts, so
    // a client can size its chunks instead of discovering the limit through a 413.
    sendJson(res, 200, { name: "avcs-hub", protocol: HUB_PROTOCOL_VERSION, materializer: MATERIALIZER_VERSION, gated, auth: auth.required ? "required" : "none", integrate: true, events: true, batch: true, batchMaxBytes: MAX_BODY });
    return;
  }

  // GET /events?since=N&timeoutMs=M → live-convergence long-poll (Phase 15.1, docs/17
  // §15.1). `since` is the SAME objlog cursor /sync uses (one cursor meaning). New oids
  // since the cursor ⇒ answer immediately; caught up ⇒ park until a mutation wakes us or
  // the timeout fires a `{ cursor, oids: [] }` heartbeat. Every response carries the full
  // governance ref map so a head advance is visible even when no object was appended.
  if (method === "GET" && path === "/events") {
    const sinceRaw = Number(url.searchParams.get("since") ?? "0");
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
    const toRaw = Number(url.searchParams.get("timeoutMs") ?? "30000");
    const timeoutMs = Math.min(Math.max(Number.isFinite(toRaw) ? Math.floor(toRaw) : 30_000, 10), 120_000);
    const snap = await eventsSnapshot(store, since);
    if (snap.oids.length > 0) {
      metrics.inc("hub.events.immediate");
      sendJson(res, 200, snap);
      return;
    }
    ops.events.park(res, since, timeoutMs);
    return;
  }

  // GET /metrics → in-process counters/timings snapshot (request counts, status classes,
  // latency). Production forwards this to Prometheus/OTel; here it's a scrapeable JSON.
  if (method === "GET" && path === "/metrics") {
    sendJson(res, 200, metrics.snapshot());
    return;
  }

  // GET /have → all oids the hub holds (full set; initial clone / older clients).
  if (method === "GET" && path === "/have") {
    // Names only — `list()` reads and decodes every object body to answer a question the
    // filename already answers. Measured: this made a no-change re-sync linear in history
    // (~1ms/object), which every watch cycle pays. `listOids` touches no bodies.
    sendJson(res, 200, await store.listOids());
    return;
  }

  // GET /sync?since=N → incremental object discovery (E5). Returns the oids appended to
  // the object-log after index N, plus the new cursor (log length). since=0 / out-of-range
  // returns the full set (a first sync or a client whose cursor is stale). The object-log
  // is append-only in normal operation, so the cursor is stable across syncs; the client
  // always falls back to /have if this endpoint is absent, so correctness never depends
  // on the cursor — it is a pure transfer optimization.
  if (method === "GET" && path === "/sync") {
    const sinceRaw = Number(url.searchParams.get("since") ?? "0");
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
    const all = await store.readObjLog();
    const oids = since > 0 && since <= all.length ? all.slice(since) : all;
    sendJson(res, 200, { oids, cursor: all.length });
    return;
  }

  // GET /refs → governance refs the hub is authoritative for (policy/membership/
  // protection/head). Clients pull these to adopt the org's canonical governance.
  if (method === "GET" && path === "/refs") {
    sendJson(res, 200, { refs: Object.fromEntries(await store.listRefs()) });
    return;
  }

  // GET /objects/:oid → the object JSON (404 if absent).
  if (method === "GET" && path.startsWith("/objects/")) {
    const oid = decodeURIComponent(path.slice("/objects/".length));
    if (!oid) {
      sendJson(res, 400, { error: "missing oid" });
      return;
    }
    if (!(await store.has(oid))) {
      sendJson(res, 404, { error: "not found", oid });
      return;
    }
    sendJson(res, 200, await store.get(oid));
    return;
  }

  // POST /objects → store the object, return its oid.
  if (method === "POST" && path === "/objects") {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      sendJson(res, 413, { error: String((err as Error).message) });
      return;
    }
    // Transport auth (SSH-style): on a write-auth hub the request must be signed by a
    // registered member before we do any work. Verified over the raw body so a captured
    // header can't be replayed against different content.
    if (!(await enforceTransportAuth(auth, req, res, "POST", "/objects", raw, metrics))) return;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: "invalid JSON" });
      return;
    }

    // E7 per-actor push quota: key on the object's signer, else the remote address.
    const rlKey = rateLimitKey(obj, req);
    if (!ops.allow(rlKey)) {
      metrics.inc("hub.ratelimited");
      res.setHeader("retry-after", String(ops.retryAfterSeconds(rlKey)));
      sendJson(res, 429, { error: "rate limit exceeded" });
      return;
    }
    const v = await ingestObject(store, obj, gated, ops);
    if (v.status === "invalid") { sendJson(res, 400, { error: v.reason }); return; }
    if (v.status === "rejected") { sendJson(res, 403, { error: v.reason }); return; }
    sendJson(res, 200, { oid: v.oid });
    return;
  }

  // POST /objects/batch → store MANY objects in one signed request, with a per-oid verdict
  // for each (issue #99). The delta is negotiated exactly as before (GET /have), so this is
  // the bundle-shaped stream that follows the negotiation instead of N separate POSTs.
  //
  // The verdicts are the load-bearing part, not the transfer: the per-object loop
  // distinguished 401 (transport auth → the client must abort) from 403 (this hub refuses
  // this object → count it and keep going), and the client's push ledger — what `undo` must
  // refuse to touch — is built from exactly the accepted operations. So a per-object refusal
  // is reported IN the 200 response, positionally, and never fails the request.
  if (method === "POST" && path === "/objects/batch") {
    let raw: string;
    try { raw = await readBody(req); } catch (err) { sendJson(res, 413, { error: String((err as Error).message) }); return; }
    // Signed identically to POST /objects, over this request's own path and body.
    if (!(await enforceTransportAuth(auth, req, res, "POST", "/objects/batch", raw, metrics))) return;
    let body: unknown;
    try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: "invalid JSON" }); return; }
    const objects = (body as { objects?: unknown } | null)?.objects;
    if (!Array.isArray(objects)) { sendJson(res, 400, { error: "batch requires { objects: [...] }" }); return; }
    if (objects.length > MAX_BATCH_OBJECTS) { sendJson(res, 413, { error: `batch exceeds ${MAX_BATCH_OBJECTS} objects` }); return; }
    // E7 quota, once per distinct actor in the batch rather than once per object: a
    // content-addressed, deduplicated, idempotent write is not an expensive mutation, and
    // charging per object is what made the limiter a throughput ceiling in the first place.
    const keys = new Set(objects.map((o) => rateLimitKey(o, req)));
    for (const k of keys) {
      if (!ops.allow(k)) {
        metrics.inc("hub.ratelimited");
        res.setHeader("retry-after", String(ops.retryAfterSeconds(k)));
        sendJson(res, 429, { error: "rate limit exceeded" });
        return;
      }
    }
    // Group-committed ingest (#55 perf): `ingestObject` per object cost 6–8 serial fsyncs
    // (body 4 + audit 2), which made a 1,602-object batch take minutes with a 98%-idle CPU
    // profile. Validation stays per object and IN ORDER — authorizePush, the integration
    // refusal — but storage goes through `putMany` (one oplog/objlog append per chunk) and
    // the audit log gets ONE append for the whole batch. Redactions keep the sequential
    // path: they take a cross-process lock and rewrite blob bytes, and batching a
    // destructive rarity buys nothing.
    const results: { oid: string | null; status: "stored" | "rejected"; reason?: string }[] = new Array(objects.length);
    const accepted: { at: number; obj: AnyObject }[] = [];
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i];
      if (typeof o !== "object" || o === null || typeof (o as { type?: unknown }).type !== "string") {
        results[i] = { oid: oidOf(o), status: "rejected", reason: "object must have a string `type`" };
        continue;
      }
      const isRedaction = (o as AnyObject).type === "redaction";
      if (gated || isRedaction) {
        const verdict = await authorizePush(store, o as AnyObject);
        if (!verdict.ok) { results[i] = { oid: oidOf(o), status: "rejected", reason: verdict.reason ?? "unauthorized push" }; continue; }
      }
      if ((o as AnyObject).type === "integration") {
        results[i] = { oid: oidOf(o), status: "rejected", reason: "integration objects are authored by the integration queue; they cannot be pushed" };
        continue;
      }
      if (isRedaction) {
        const v = await ingestObject(store, o, gated, ops);
        results[i] = v.status === "stored" ? { oid: v.oid, status: "stored" } : { oid: oidOf(o), status: "rejected", reason: v.reason };
        continue;
      }
      accepted.push({ at: i, obj: o as AnyObject });
    }
    if (accepted.length) {
      let put: { oid: string; existed: boolean }[];
      try {
        put = await store.putMany(accepted.map((a) => a.obj));
      } catch (e) {
        // A refused object (the interop gate) fails the whole chunk with per-oid verdicts —
        // falling back to one-by-one keeps the "rest of the batch still lands" contract.
        put = [];
        for (const a of accepted) {
          try { put.push({ oid: await store.put(a.obj), existed: false }); }
          catch (inner) { results[a.at] = { oid: oidOf(a.obj), status: "rejected", reason: String((inner as Error).message) }; put.push({ oid: "", existed: false }); }
        }
        void e;
      }
      const auditLines: string[] = [];
      for (let j = 0; j < accepted.length; j++) {
        const { at, obj } = accepted[j]!;
        const oid = put[j]?.oid;
        if (!oid) continue; // per-object fallback already recorded the rejection
        results[at] = { oid, status: "stored" };
        auditLines.push(`${JSON.stringify({ ts: new Date().toISOString(), action: "put", type: obj.type, oid, actor: attributedActor(obj) })}\n`);
      }
      // One durable append for the whole batch — same records, one round trip.
      if (auditLines.length) {
        try { await store.appendAux("hub-audit.log", auditLines.join("")); }
        catch { /* audit is best-effort, same as ops.audit */ }
      }
      ops.events.wake(); // once per batch: waiters re-snapshot regardless of count
    }
    metrics.inc("hub.batch.objects", objects.length);
    sendJson(res, 200, { results });
    return;
  }

  // POST /objects/fetch → return MANY objects for one wanted-oid list (issue #99), the read
  // half of the same fix: `clone` used to make one GET per object (12,059 of them, ten
  // minutes against a hub on localhost). POST rather than GET because a wanted set of
  // hundreds of oids does not fit in a URL; read-public like GET /objects/:oid, and oids the
  // hub does not hold are simply absent from the response (a raced eviction is not an error).
  //
  // The hub bounds its OWN response size and says `truncated` when it stopped early, so a
  // client cannot make it materialize an unbounded payload by asking for everything at once.
  if (method === "POST" && path === "/objects/fetch") {
    let raw: string;
    try { raw = await readBody(req); } catch (err) { sendJson(res, 413, { error: String((err as Error).message) }); return; }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: "invalid JSON" }); return; }
    const asked = (body as { oids?: unknown } | null)?.oids;
    if (!Array.isArray(asked)) { sendJson(res, 400, { error: "fetch requires { oids: [...] }" }); return; }
    if (asked.length > MAX_FETCH_OIDS) { sendJson(res, 413, { error: `fetch exceeds ${MAX_FETCH_OIDS} oids` }); return; }
    const objects: AnyObject[] = [];
    let bytes = 0;
    let truncated = false;
    for (const oid of asked) {
      if (typeof oid !== "string" || !oid) continue;
      if (!(await store.has(oid))) continue;
      const obj = await store.get(oid);
      bytes += JSON.stringify(obj).length;
      objects.push(obj);
      if (bytes >= MAX_FETCH_BYTES) { truncated = true; break; }
    }
    metrics.inc("hub.fetch.objects", objects.length);
    sendJson(res, 200, { objects, truncated });
    return;
  }

  // POST /finalize → advance a view's protected head via the authoritative compare-and-
  // swap (E6). The hub had no finalize endpoint, so a remote client couldn't merge and
  // setRef had no CAS — two finalizes could clobber. This runs repo.finalize, which does
  // the CAS on parentHead under a cross-process lock plus the role/checks/approvals/
  // causal-completeness gates. On a gated hub the request must be signed by `by`.
  if (method === "POST" && path === "/finalize") {
    let raw: string;
    try { raw = await readBody(req); } catch (err) { sendJson(res, 413, { error: String((err as Error).message) }); return; }
    if (!(await enforceTransportAuth(auth, req, res, "POST", "/finalize", raw, metrics))) return;
    let body: { view?: unknown; newCheckpoint?: unknown; parentHead?: unknown; by?: unknown; sig?: unknown };
    try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: "invalid JSON" }); return; }
    const { view, newCheckpoint, by } = body;
    if (typeof view !== "string" || typeof newCheckpoint !== "string" || typeof by !== "string") {
      sendJson(res, 400, { error: "finalize requires string { view, newCheckpoint, by }" });
      return;
    }
    const parentHead = typeof body.parentHead === "string" ? body.parentHead : null;
    if (gated && !(await verifyFinalizeSig(store, by, view, newCheckpoint, parentHead, body.sig))) {
      sendJson(res, 403, { error: "finalize not signed by the claimed member" });
      return;
    }
    if (!ops.allow(`actor:${by}`)) { metrics.inc("hub.ratelimited"); res.setHeader("retry-after", String(ops.retryAfterSeconds(`actor:${by}`))); sendJson(res, 429, { error: "rate limit exceeded" }); return; }
    const { Repo } = await import("../api/repo.ts");
    const repo = await Repo.open(repoDir);
    const result = await repo.finalize({ view, newCheckpoint, parentHead, by });
    await ops.audit({ action: "finalize", view, newCheckpoint, by, finalized: result.finalized, reason: result.finalized ? undefined : result.reason }); // E7
    // Phase 15.1: a successful finalize moves head:<view> WITHOUT appending an object —
    // the ref-only mutation the events refs-in-every-response design exists for.
    if (result.finalized) { ops.events.wake(); sendJson(res, 200, result); return; }
    // A stale parentHead (lost the CAS race) is a 409 conflict; everything else (role,
    // checks, approvals, incomplete history) is a 422 unprocessable.
    sendJson(res, /head moved/.test(result.reason) ? 409 : 422, result);
    return;
  }

  // POST /integrate → the Phase 14 integration queue (docs/17 §14.3): instead of
  // rejecting a stale submission, the hub re-reduces the frontier union on the
  // submitter's behalf. Verdict → HTTP: advanced 200 / conflict 409 (packet attached) /
  // needs_evidence 428 / queued 202 / rejected 422. Legacy POST /finalize is unchanged.
  if (method === "POST" && path === "/integrate") {
    let raw: string;
    try { raw = await readBody(req); } catch (err) { sendJson(res, 413, { error: String((err as Error).message) }); return; }
    if (!(await enforceTransportAuth(auth, req, res, "POST", "/integrate", raw, metrics))) return;
    let body: { view?: unknown; checkpoint?: unknown; by?: unknown; ticketId?: unknown; sig?: unknown };
    try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: "invalid JSON" }); return; }
    const { view, checkpoint, by } = body;
    if (typeof view !== "string" || typeof checkpoint !== "string" || typeof by !== "string") {
      sendJson(res, 400, { error: "integrate requires string { view, checkpoint, by }" });
      return;
    }
    const ticketId = typeof body.ticketId === "string" ? body.ticketId : undefined;
    if (gated && !(await verifyIntegrateSig(store, by, view, checkpoint, ticketId ?? "", body.sig))) {
      sendJson(res, 403, { error: "integrate not signed by the claimed member" });
      return;
    }
    if (!ops.allow(`actor:${by}`)) { metrics.inc("hub.ratelimited"); res.setHeader("retry-after", String(ops.retryAfterSeconds(`actor:${by}`))); sendJson(res, 429, { error: "rate limit exceeded" }); return; }
    if (!(await store.has(checkpoint))) {
      sendJson(res, 422, { verdict: "rejected", reason: `checkpoint ${checkpoint} not on the hub — push it first` });
      return;
    }
    const { Repo } = await import("../api/repo.ts");
    const repo = await Repo.open(repoDir);
    const result = await repo.submitIntegration({ view, checkpoint, by, ticketId });
    await ops.audit({ action: "integrate", view, checkpoint, ticketId: "ticketId" in result ? result.ticketId : ticketId, by, verdict: result.verdict }); // E7
    const status = result.verdict === "advanced" ? 200
      : result.verdict === "conflict" ? 409
      : result.verdict === "needs_evidence" ? 428
      : result.verdict === "queued" ? 202
      : 422;
    // Phase 15.1: every judged verdict appended an Integration audit object (and
    // `advanced` moved the head) — wake waiters on all of them; `queued` wrote nothing
    // but a spurious wake is harmless (waiters just re-snapshot).
    ops.events.wake();
    sendJson(res, status, result);
    return;
  }

  // GET /integrations/:ticketId?view= → idempotent verdict lookup (polling).
  if (method === "GET" && path.startsWith("/integrations/")) {
    const ticketId = decodeURIComponent(path.slice("/integrations/".length));
    const view = url.searchParams.get("view") ?? "main";
    const ref = await store.getRef(`integration:${view}:${ticketId}`);
    if (!ref || !(await store.has(ref))) {
      sendJson(res, 404, { error: "no such integration ticket", view, ticketId });
      return;
    }
    sendJson(res, 200, await store.get(ref));
    return;
  }

  sendJson(res, 404, { error: "no such route", method, path });
}
