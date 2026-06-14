// A self-contained HTTP hub for object-gossip over the network (M2 / docs/10 WS-B).
//
// The hub is just an ObjectStore behind three minimal endpoints. Because objects are
// content-addressed and append-only, sync is a conflict-free union: clients diff their
// local oid set against the hub's "have" set and transfer only what's missing, in
// either direction. The hub never mutates an existing object (idempotent put).
//
//   GET  /have          → JSON array of every oid the hub holds (the "have" set)
//   GET  /objects/:oid  → the stored object JSON (404 if absent)
//   POST /objects       → store an object (body = object JSON), returns { oid }
//
// Node builtins only: node:http + the existing ObjectStore.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { ObjectStore } from "../store/objectStore.ts";
import { verifyMessage } from "../core/identity.ts";
import { computeOid } from "../core/canonical.ts";
import { silentLogger, type Logger } from "../observe/logger.ts";
import { Metrics } from "../observe/metrics.ts";
import { MATERIALIZER_VERSION } from "../reducer/policy.ts";
import type { Signature } from "../core/identity.ts";
import type {
  AnyObject, Membership, Operation, Evidence, Decision, Approval, Promotion, Override, Redaction, RoleName,
} from "../objects/types.ts";

/** Wire-protocol version the hub speaks (have/objects/refs gossip). Bumped on breaking changes. */
export const HUB_PROTOCOL_VERSION = 1;

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

/**
 * Start an HTTP hub backed by `new ObjectStore(opts.repoDir)`. The store is init()'d
 * so an empty repo dir works. Pass `port: 0` (or omit) to get an OS-assigned port,
 * read back from the returned handle.
 */
export async function startHub(opts: {
  repoDir: string; port?: number; gated?: boolean; logger?: Logger; metrics?: Metrics;
  /** App-layer per-actor push quota (E7). Omit to disable. */
  rateLimit?: { maxPerWindow: number; windowMs?: number };
}): Promise<HubHandle> {
  const store = new ObjectStore(opts.repoDir);
  await store.init(); // tolerate a fresh/empty repo dir
  const gated = opts.gated ?? false;
  const logger = opts.logger ?? silentLogger();
  const metrics = opts.metrics ?? new Metrics();

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
  const audit = async (rec: Record<string, unknown>): Promise<void> => {
    try { await store.appendAux("hub-audit.log", `${JSON.stringify({ ts: new Date().toISOString(), ...rec })}\n`); }
    catch (e) { logger.warn("hub.audit.fail", { error: String((e as Error).message) }); }
  };
  const ctx: HubOps = { audit, allow };

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
    handle(store, req, res, gated, metrics, opts.repoDir, ctx).catch((err) => {
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

/** E7 operability hooks threaded into the request handler. */
interface HubOps {
  audit(rec: Record<string, unknown>): Promise<void>;
  allow(key: string): boolean;
}

/** The actor a push is attributed to (for the audit log + quota): the object's signer
 *  field when there is one, else null (the caller falls back to the remote address). */
function attributedActor(obj: AnyObject): string | null {
  const req = authRequirement(obj);
  return typeof req === "object" ? req.signerId : null;
}

async function handle(store: ObjectStore, req: IncomingMessage, res: ServerResponse, gated: boolean, metrics: Metrics, repoDir: string, ops: HubOps): Promise<void> {
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
    sendJson(res, 200, { name: "avcs-hub", protocol: HUB_PROTOCOL_VERSION, materializer: MATERIALIZER_VERSION, gated });
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
    const oids: string[] = [];
    for await (const obj of store.list()) oids.push(obj.oid as string);
    sendJson(res, 200, oids);
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
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: "invalid JSON" });
      return;
    }
    if (typeof obj !== "object" || obj === null || typeof (obj as { type?: unknown }).type !== "string") {
      sendJson(res, 400, { error: "object must have a string `type`" });
      return;
    }
    // E7 per-actor push quota: key on the object's signer, else the remote address.
    const actor = attributedActor(obj as AnyObject);
    const rlKey = actor ? `actor:${actor}` : `addr:${req.socket.remoteAddress ?? "?"}`;
    if (!ops.allow(rlKey)) {
      metrics.inc("hub.ratelimited");
      sendJson(res, 429, { error: "rate limit exceeded" });
      return;
    }
    // Authorize the push (E2). On a gated hub EVERY mutating governance object is
    // checked. A `redaction` is checked ALWAYS — even on an ungated hub (E3): it
    // overwrites blob bytes irrecoverably, so an unauthenticated redaction is a
    // data-destruction DoS. authorizePush requires an admin-signed redaction; an open
    // hub with no admin membership therefore rejects all redactions (no DoS) rather
    // than the old trust-all behavior.
    const isRedaction = (obj as AnyObject).type === "redaction";
    if (gated || isRedaction) {
      const auth = await authorizePush(store, obj as AnyObject);
      if (!auth.ok) {
        sendJson(res, 403, { error: auth.reason });
        return;
      }
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
    await ops.audit({ action: "put", type: (obj as AnyObject).type, oid, actor }); // E7 provenance
    sendJson(res, 200, { oid });
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
    if (!ops.allow(`actor:${by}`)) { metrics.inc("hub.ratelimited"); sendJson(res, 429, { error: "rate limit exceeded" }); return; }
    const { Repo } = await import("../api/repo.ts");
    const repo = await Repo.open(repoDir);
    const result = await repo.finalize({ view, newCheckpoint, parentHead, by });
    await ops.audit({ action: "finalize", view, newCheckpoint, by, finalized: result.finalized, reason: result.finalized ? undefined : result.reason }); // E7
    if (result.finalized) { sendJson(res, 200, result); return; }
    // A stale parentHead (lost the CAS race) is a 409 conflict; everything else (role,
    // checks, approvals, incomplete history) is a 422 unprocessable.
    sendJson(res, /head moved/.test(result.reason) ? 409 : 422, result);
    return;
  }

  sendJson(res, 404, { error: "no such route", method, path });
}
