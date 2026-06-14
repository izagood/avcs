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
import type { AnyObject, Membership, Operation } from "../objects/types.ts";

/** Wire-protocol version the hub speaks (have/objects/refs gossip). Bumped on breaking changes. */
export const HUB_PROTOCOL_VERSION = 1;

export interface HubHandle {
  url: string;
  port: number;
  metrics: Metrics;
  close(): Promise<void>;
}

/**
 * Governance gate: an operation pushed to a gated hub must be signed by a key whose
 * membership (resolved via the hub's `member:<actorId>` ref) grants role ≥ proposer
 * and is not revoked. The hub is authoritative for membership — clients pull it.
 */
async function isAuthorizedOp(store: ObjectStore, op: Operation): Promise<boolean> {
  const memRef = await store.getRef(`member:${op.actor.id}`);
  if (!memRef || !(await store.has(memRef))) return false;
  const m = await store.get<Membership>(memRef);
  if (m.revokedAt || m.actorId !== op.actor.id) return false;
  if (m.role === "reader") return false; // below proposer
  if (!op.sig) return false;
  // E1: verify the signature over the RECOMPUTED content oid, not the client-claimed
  // op.oid. put() stores under computeOid(content); a well-behaved client signs that
  // same value (#sign → computeOid). Verifying the claimed oid let an op be accepted
  // here yet rejected by a pulling replica (which recomputes the oid) — silent
  // divergence. Recomputing here makes hub-accept ⟹ replica-accept.
  const oid = computeOid(op.type, op as unknown as Record<string, unknown>);
  return verifyMessage(m.publicKey, oid, op.sig.sig);
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
export async function startHub(opts: { repoDir: string; port?: number; gated?: boolean; logger?: Logger; metrics?: Metrics }): Promise<HubHandle> {
  const store = new ObjectStore(opts.repoDir);
  await store.init(); // tolerate a fresh/empty repo dir
  const gated = opts.gated ?? false;
  const logger = opts.logger ?? silentLogger();
  const metrics = opts.metrics ?? new Metrics();

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
    handle(store, req, res, gated, metrics).catch((err) => {
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

async function handle(store: ObjectStore, req: IncomingMessage, res: ServerResponse, gated: boolean, metrics: Metrics): Promise<void> {
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

  // GET /have → all oids the hub holds.
  if (method === "GET" && path === "/have") {
    const oids: string[] = [];
    for await (const obj of store.list()) oids.push(obj.oid as string);
    sendJson(res, 200, oids);
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
    // Gated hub: reject operations not signed by a member with role ≥ proposer.
    // Non-operation objects (blobs/evidence/etc.) are content-addressed and harmless.
    if (gated && (obj as AnyObject).type === "operation") {
      if (!(await isAuthorizedOp(store, obj as Operation))) {
        sendJson(res, 403, { error: "operation not signed by an authorized member" });
        return;
      }
    }
    // put() recomputes the oid from content, so a forged/incorrect inbound oid cannot
    // poison the store — it lands at its true content address (or is a no-op if present).
    const oid = await store.put(obj as AnyObject);
    // A pushed redaction evicts the hub's own copy of the blob too (so no replica can
    // re-fetch the plaintext from the hub).
    if ((obj as AnyObject).type === "redaction") {
      const { applyRedactions } = await import("../store/applyRedactions.ts");
      await applyRedactions(store);
    }
    sendJson(res, 200, { oid });
    return;
  }

  sendJson(res, 404, { error: "no such route", method, path });
}
