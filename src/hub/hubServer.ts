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
import type { AnyObject } from "../objects/types.ts";

export interface HubHandle {
  url: string;
  port: number;
  close(): Promise<void>;
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
export async function startHub(opts: { repoDir: string; port?: number }): Promise<HubHandle> {
  const store = new ObjectStore(opts.repoDir);
  await store.init(); // tolerate a fresh/empty repo dir

  const server: Server = createServer((req, res) => {
    handle(store, req, res).catch((err) => {
      // Last-resort guard: never let a handler rejection crash the server.
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
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function handle(store: ObjectStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Parse path only (ignore query); the host is irrelevant for routing.
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // GET /have → all oids the hub holds.
  if (method === "GET" && path === "/have") {
    const oids: string[] = [];
    for await (const obj of store.list()) oids.push(obj.oid as string);
    sendJson(res, 200, oids);
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
    // put() recomputes the oid from content, so a forged/incorrect inbound oid cannot
    // poison the store — it lands at its true content address (or is a no-op if present).
    const oid = await store.put(obj as AnyObject);
    sendJson(res, 200, { oid });
    return;
  }

  sendJson(res, 404, { error: "no such route", method, path });
}
