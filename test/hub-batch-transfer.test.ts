// Issue #99: the wire protocol moved ONE object per HTTP request.
//
// `pushToHub` POSTed each object on its own and treated any non-OK status as fatal, so a
// single 429 aborted an entire push (11,048 objects → 11 manual retries in the field), and
// `pullFromHub`/`clone` did the mirror-image thing with GET /objects/:oid (12,059 sequential
// GETs for one clone, ten minutes against a hub on localhost).
//
// The rate limit was never the root cause: a protocol needing N requests to move N objects
// makes ANY per-request budget a throughput ceiling. So the fix is the shape — negotiate with
// GET /have, then send the delta as bundle-shaped chunks (POST /objects/batch) and fetch the
// wanted set the same way (POST /objects/fetch) — with 429 backoff on top, because any hub may
// still throttle for reasons the client cannot predict.
//
// These tests assert the properties that make that true, against a REAL hub wherever possible
// (so the protocol is exercised end to end) and a stub only where the point is a hub behaving
// in a way the reference hub cannot be made to behave.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { pushToHub, pullFromHub } from "../src/hub/hubClient.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

/** Author `count` distinct files through one intent/session — the cheapest way to a repo with
 *  many objects (each write contributes an operation plus its blob). */
async function authorMany(repo: Repo, count: number, prefix = "f"): Promise<string[]> {
  const intent = await repo.createIntent({ title: "bulk", owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  const ops: string[] = [];
  for (let i = 0; i < count; i++) {
    ops.push(
      await repo.proposeFileWrite({
        sessionOid: sess,
        intentOid: intent,
        actor: ai,
        path: `${prefix}${i}.ts`,
        content: `export const v${i} = ${i};\n`,
        declaredPurpose: "bulk",
      }),
    );
  }
  return ops;
}

interface Counter {
  url: string;
  /** Request count per pathname, e.g. { "/objects/batch": 2 }. */
  hits: Map<string, number>;
  /** Every request body observed, per pathname. */
  bodies: Map<string, string[]>;
  total(): number;
  close(): Promise<void>;
}

/**
 * A counting reverse proxy in front of a real hub: forwards everything verbatim and records
 * how many requests arrived on each path. Lets a test assert on the CLIENT's request count
 * without reimplementing a hub (the same trick test/hub-signed-reads.test.ts uses for
 * credentials).
 */
async function countingProxy(upstream: string): Promise<Counter> {
  const hits = new Map<string, number>();
  const bodies = new Map<string, string[]>();
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        if (body.length) bodies.set(path, [...(bodies.get(path) ?? []), body.toString("utf8")]);
        const headers = { ...req.headers } as Record<string, string>;
        delete headers["content-length"];
        delete headers["host"];
        const r = await fetch(`${upstream}${req.url}`, {
          method: req.method,
          headers,
          ...(body.length ? { body } : {}),
        });
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
        res.end(Buffer.from(await r.arrayBuffer()));
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    bodies,
    total: () => [...hits.values()].reduce((a, b) => a + b, 0),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface StubReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface StubOpts {
  /** GET /version body. `null` ⇒ 404, i.e. a hub too old to have the endpoint at all. */
  version?: Record<string, unknown> | null;
  onBatch?: (objects: { oid?: string; type?: string }[], call: number) => StubReply;
  onObject?: (obj: { oid?: string; type?: string }, call: number) => StubReply;
  onFetch?: (oids: string[], call: number) => StubReply;
}

interface Stub {
  url: string;
  hits: Map<string, number>;
  /** Body byte length of every request, per path — for the chunk-cap assertion. */
  sizes: Map<string, number[]>;
  /** The objects of every POST /objects/batch, per call. */
  batches: { oid?: string; type?: string }[][];
  close(): Promise<void>;
}

/**
 * A stub hub for the behaviors the reference hub cannot be made to exhibit: advertising no
 * batching at all, throttling on demand, answering with a chosen set of per-oid verdicts,
 * failing part-way through a push. Everything a push/pull touches is answered minimally.
 */
async function stubHub(opts: StubOpts): Promise<Stub> {
  const hits = new Map<string, number>();
  const sizes = new Map<string, number[]>();
  const batches: { oid?: string; type?: string }[][] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const n = (hits.get(path) ?? 0) + 1;
    hits.set(path, n);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      sizes.set(path, [...(sizes.get(path) ?? []), raw.length]);
      const reply = (r: StubReply): void => {
        res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
        res.end(JSON.stringify(r.body ?? {}));
      };
      if (path === "/have") return reply({ status: 200, body: [] });
      if (path === "/refs") return reply({ status: 200, body: { refs: {} } });
      if (path === "/sync") return reply({ status: 200, body: { oids: [], cursor: 0 } });
      if (path === "/version") {
        return opts.version === null
          ? reply({ status: 404, body: { error: "not found" } })
          : reply({ status: 200, body: opts.version ?? { name: "stub", protocol: 4, integrate: true, events: true } });
      }
      if (path === "/objects/batch") {
        const objects = (JSON.parse(raw.toString("utf8")) as { objects: { oid?: string; type?: string }[] }).objects;
        batches.push(objects);
        return reply(opts.onBatch?.(objects, n) ?? { status: 404, body: { error: "no such route" } });
      }
      if (path === "/objects/fetch") {
        const oids = (JSON.parse(raw.toString("utf8")) as { oids: string[] }).oids;
        return reply(opts.onFetch?.(oids, n) ?? { status: 404, body: { error: "no such route" } });
      }
      if (path === "/objects") {
        const obj = JSON.parse(raw.toString("utf8")) as { oid?: string; type?: string };
        return reply(opts.onObject?.(obj, n) ?? { status: 200, body: { oid: obj.oid } });
      }
      reply({ status: 404, body: { error: "not found" } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    sizes,
    batches,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Every operation oid in a repo, in store order — what the push ledger is asserted against. */
async function localOps(dir: string): Promise<Set<string>> {
  const { ObjectStore } = await import("../src/store/objectStore.ts");
  const store = new ObjectStore(dir);
  const ops = new Set<string>();
  for await (const o of store.list()) if (o.type === "operation") ops.add(o.oid as string);
  return ops;
}

/** The push ledger as written by `pushToHub` (oid → hub URLs). */
async function ledger(dir: string): Promise<Record<string, string[]>> {
  const { ObjectStore } = await import("../src/store/objectStore.ts");
  const raw = await new ObjectStore(dir).readAux("pushed-ops.json");
  return raw ? (JSON.parse(raw.toString("utf8")) as Record<string, string[]>) : {};
}

test("push moves N objects WITHOUT making N requests (issue #99: the shape, not the limit)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-b99-a-"));
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-b99-hub-"));
  try {
    const repo = await Repo.init(dir);
    await authorMany(repo, 60);

    const hub = await startHub({ repoDir: hubDir, port: 0 });
    const proxy = await countingProxy(hub.url);
    try {
      const r = await pushToHub(dir, proxy.url);
      assert.ok(r.pushed >= 120, `a meaningful number of objects moved (pushed=${r.pushed})`);

      // The property, stated as the ratio the old protocol could never beat: 1:1.
      const posts = proxy.hits.get("/objects/batch") ?? 0;
      const singles = proxy.hits.get("/objects") ?? 0;
      assert.equal(singles, 0, "no per-object POST /objects happened at all");
      assert.ok(posts >= 1, "the delta went out as batched requests");
      assert.ok(
        proxy.total() < r.pushed / 5,
        `request count is decoupled from object count: ${proxy.total()} requests for ${r.pushed} objects`,
      );
    } finally {
      await proxy.close();
      await hub.close();
    }
  } finally {
    for (const d of [dir, hubDir]) await rm(d, { recursive: true, force: true });
  }
});

test("pull/clone fetches N objects WITHOUT making N requests", async () => {
  const src = await mkdtemp(join(tmpdir(), "avcs-b99-src-"));
  const dst = await mkdtemp(join(tmpdir(), "avcs-b99-dst-"));
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-b99-hub2-"));
  try {
    const repo = await Repo.init(src);
    await authorMany(repo, 60);
    const hub = await startHub({ repoDir: hubDir, port: 0 });
    try {
      await pushToHub(src, hub.url);

      const proxy = await countingProxy(hub.url);
      try {
        const r = await pullFromHub(dst, proxy.url);
        assert.ok(r.pulled >= 120, `a meaningful number of objects arrived (pulled=${r.pulled})`);
        const perOid = [...proxy.hits.entries()]
          .filter(([p]) => p.startsWith("/objects/") && p !== "/objects/fetch" && p !== "/objects/batch")
          .reduce((a, [, n]) => a + n, 0);
        assert.equal(perOid, 0, `no per-oid GET /objects/:oid loop (saw ${perOid})`);
        assert.ok((proxy.hits.get("/objects/fetch") ?? 0) >= 1, "the wanted set was fetched in batches");
        assert.ok(
          proxy.total() < r.pulled / 5,
          `request count is decoupled from object count: ${proxy.total()} requests for ${r.pulled} objects`,
        );
      } finally {
        await proxy.close();
      }
    } finally {
      await hub.close();
    }
  } finally {
    for (const d of [src, dst, hubDir]) await rm(d, { recursive: true, force: true });
  }
});

test("a hub that advertises no batching gets the per-object protocol, and the push completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-b99-bc-"));
  try {
    const repo = await Repo.init(dir);
    await authorMany(repo, 3);
    // No `batch` field at all — exactly what every hub deployed today answers.
    const stub = await stubHub({ version: { name: "old-hub", protocol: 4, integrate: true, events: true } });
    try {
      const r = await pushToHub(dir, stub.url);
      assert.ok(r.pushed > 0, `objects moved (pushed=${r.pushed})`);
      assert.equal(r.rejected, 0);
      assert.equal(stub.hits.get("/objects/batch") ?? 0, 0, "never attempted the batch endpoint");
      assert.equal(stub.hits.get("/objects") ?? 0, r.pushed, "one POST /objects per object, as before");
    } finally {
      await stub.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hub with no /version endpoint at all still gets the per-object protocol", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-b99-noversion-"));
  try {
    const repo = await Repo.init(dir);
    await authorMany(repo, 2);
    const stub = await stubHub({ version: null });
    try {
      const r = await pushToHub(dir, stub.url);
      assert.ok(r.pushed > 0);
      assert.equal(stub.hits.get("/objects/batch") ?? 0, 0);
      assert.equal(stub.hits.get("/objects") ?? 0, r.pushed);
    } finally {
      await stub.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("per-oid verdicts survive batching: one 403'd oid is `rejected`, and does not abort the push", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-b99-verdict-"));
  try {
    const repo = await Repo.init(dir);
    await authorMany(repo, 4);
    let refused: string | null = null;
    const stub = await stubHub({
      version: { batch: true },
      onBatch: (objects) => {
        // Refuse exactly one object, the way a gated hub refuses a single unauthorized op.
        refused = objects[1]!.oid!;
        return {
          status: 200,
          body: {
            results: objects.map((o, i) =>
              i === 1 ? { oid: o.oid, status: "rejected", reason: "role proposer below required reviewer" } : { oid: o.oid, status: "stored" },
            ),
          },
        };
      },
    });
    try {
      const total = stub.batches.length; // placeholder, asserted through the result below
      assert.equal(total, 0);
      const r = await pushToHub(dir, stub.url);
      assert.equal(r.rejected, 1, "the refused oid counted as rejected, not as a failure");
      assert.ok(r.pushed >= 1, "everything else in the same request still landed");
      assert.ok(refused, "the stub refused an object");
      const led = await ledger(dir);
      assert.ok(!(refused! in led), "a refused op is NOT in the push ledger");
    } finally {
      await stub.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a 401 on a batch aborts loudly and records nothing — the hub did no work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-b99-401-"));
  try {
    const repo = await Repo.init(dir);
    await authorMany(repo, 3);
    const stub = await stubHub({
      version: { batch: true },
      onBatch: () => ({ status: 401, body: { error: "transport auth required" } }),
    });
    try {
      await assert.rejects(() => pushToHub(dir, stub.url), /unauthorized \(401\)/);
      assert.deepEqual(await ledger(dir), {}, "a request refused before any work records nothing");
    } finally {
      await stub.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a push that fails part-way records exactly what the hub accepted, and `undo` refuses those ops", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-b99-partial-"));
  try {
    const repo = await Repo.init(dir);
    await authorMany(repo, 6);
    const ops = await localOps(dir);

    // A push split across many requests (a 1-byte cap puts one object in each) where the hub
    // accepts the first two operations and then refuses the connection outright — a 401, the
    // one failure where the hub demonstrably did no work, so the answer is exact rather than
    // ambiguous. The ledger must then hold PRECISELY those two operations: no fewer (that
    // would let `undo` rewrite history the hub already holds) and no more (that would block
    // an undo which is still legal).
    const accepted: string[] = [];
    let opsTaken = 0;
    const stub = await stubHub({
      version: { batch: true },
      onBatch: (objects) => {
        if (objects.some((o) => o.type === "operation")) {
          if (opsTaken >= 2) return { status: 401, body: { error: "transport auth required" } };
          opsTaken++;
        }
        for (const o of objects) accepted.push(o.oid!);
        return { status: 200, body: { results: objects.map((o) => ({ oid: o.oid, status: "stored" })) } };
      },
    });
    try {
      await assert.rejects(() => pushToHub(dir, stub.url, undefined, { maxBatchBytes: 1 }), /401/);
      assert.ok(stub.batches.length > 2, `the push really was split (${stub.batches.length} requests)`);

      const acceptedOps = accepted.filter((o) => ops.has(o));
      assert.equal(acceptedOps.length, 2, "the hub took exactly two operations");
      assert.deepEqual(
        Object.keys(await ledger(dir)).sort(),
        [...acceptedOps].sort(),
        "the ledger is EXACTLY the accepted operations — not the attempted ones, not fewer",
      );

      // The safety property this ledger exists for.
      await assert.rejects(() => repo.undo({ ops: [acceptedOps[0]!], by: "human:h" }), /undo refuses/);
      // And the mirror image: an op that never reached the hub is still a local matter.
      const untouched = [...ops].find((o) => !acceptedOps.includes(o));
      assert.ok(untouched, "some operation never left this replica");
      assert.ok(await repo.undo({ ops: [untouched!], by: "human:h" }), "and it stays locally undoable");
    } finally {
      await stub.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an AMBIGUOUS chunk (5xx) is recorded as pushed — over-recording is the survivable error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-b99-ambiguous-"));
  try {
    const repo = await Repo.init(dir);
    await authorMany(repo, 6);
    const ops = await localOps(dir);

    // The hub takes the first operation, then answers 502 on the request carrying the second.
    // A 502 says nothing about whether the chunk landed, so the second operation MIGHT be on
    // the hub — and the ledger has to assume it is.
    const stored: string[] = [];
    let opsSeen = 0;
    let ambiguous: string | null = null;
    const stub = await stubHub({
      version: { batch: true },
      onBatch: (objects) => {
        const op = objects.find((o) => o.type === "operation");
        if (op) {
          opsSeen++;
          if (opsSeen === 2) { ambiguous = op.oid!; return { status: 502, body: { error: "bad gateway" } }; }
        }
        for (const o of objects) stored.push(o.oid!);
        return { status: 200, body: { results: objects.map((o) => ({ oid: o.oid, status: "stored" })) } };
      },
    });
    try {
      await assert.rejects(() => pushToHub(dir, stub.url, undefined, { maxBatchBytes: 1 }), /502/);
      assert.ok(ambiguous, "the hub failed on a chunk carrying an operation");
      const led = await ledger(dir);
      const confirmed = stored.filter((o) => ops.has(o));
      assert.equal(confirmed.length, 1, "exactly one operation was confirmed stored");
      assert.ok(confirmed[0]! in led, "the confirmed op is in the ledger");
      assert.ok(ambiguous! in led, "and so is the AMBIGUOUS one — the hub may hold it");
      await assert.rejects(() => repo.undo({ ops: [ambiguous!], by: "human:h" }), /undo refuses/);
    } finally {
      await stub.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("429 with Retry-After completes via backoff instead of throwing (delta-seconds and HTTP-date)", async () => {
  for (const form of ["seconds", "http-date"] as const) {
    const dir = await mkdtemp(join(tmpdir(), `avcs-b99-429-${form}-`));
    try {
      const repo = await Repo.init(dir);
      await authorMany(repo, 3);
      let throttled = 0;
      const stub = await stubHub({
        version: { batch: true },
        onBatch: (objects, call) => {
          if (call <= 2) {
            throttled++;
            return {
              status: 429,
              headers: { "retry-after": form === "seconds" ? "0" : new Date(Date.now() + 10).toUTCString() },
              body: { error: "rate limit exceeded" },
            };
          }
          return { status: 200, body: { results: objects.map((o) => ({ oid: o.oid, status: "stored" })) } };
        },
      });
      try {
        const r = await pushToHub(dir, stub.url, undefined, { retry: { baseMs: 1, maxMs: 20 } });
        assert.equal(throttled, 2, `${form}: the hub really throttled twice`);
        assert.ok(r.pushed > 0, `${form}: the push completed anyway (pushed=${r.pushed})`);
        assert.equal(r.rejected, 0);
      } finally {
        await stub.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("429 with no Retry-After still completes, via exponential backoff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-b99-429-plain-"));
  try {
    const repo = await Repo.init(dir);
    await authorMany(repo, 2);
    let throttled = 0;
    const stub = await stubHub({
      version: { batch: true },
      onBatch: (objects, call) => {
        if (call <= 3) { throttled++; return { status: 429, body: { error: "rate limit exceeded" } }; }
        return { status: 200, body: { results: objects.map((o) => ({ oid: o.oid, status: "stored" })) } };
      },
    });
    try {
      const r = await pushToHub(dir, stub.url, undefined, { retry: { baseMs: 1, maxMs: 8 } });
      assert.equal(throttled, 3);
      assert.ok(r.pushed > 0);
    } finally {
      await stub.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hub that throttles forever eventually reports the 429 rather than hanging", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-b99-429-forever-"));
  try {
    const repo = await Repo.init(dir);
    await authorMany(repo, 2);
    let seen = 0;
    const stub = await stubHub({
      version: { batch: true },
      onBatch: () => { seen++; return { status: 429, body: { error: "rate limit exceeded" } }; },
    });
    try {
      await assert.rejects(() => pushToHub(dir, stub.url, undefined, { retry: { attempts: 3, baseMs: 1, maxMs: 4 } }), /429/);
      assert.equal(seen, 4, "the first attempt plus exactly `attempts` retries — bounded, not infinite");
    } finally {
      await stub.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chunking is by BYTES: no request exceeds the cap unless it is one indivisible object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-b99-bytes-"));
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "sizes", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    // One blob far larger than the cap, plus many small objects around it.
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "big.bin", content: "x".repeat(300_000), declaredPurpose: "big" });
    await authorMany(repo, 20, "small");

    const cap = 64 * 1024;
    const stub = await stubHub({
      version: { batch: true },
      onBatch: (objects) => ({ status: 200, body: { results: objects.map((o) => ({ oid: o.oid, status: "stored" })) } }),
    });
    try {
      const r = await pushToHub(dir, stub.url, undefined, { maxBatchBytes: cap });
      assert.ok(r.pushed > 20, `everything moved (pushed=${r.pushed})`);
      assert.ok(stub.batches.length > 1, "the cap really did split the push");
      const bodies = stub.sizes.get("/objects/batch") ?? [];
      assert.equal(bodies.length, stub.batches.length);
      for (let i = 0; i < bodies.length; i++) {
        // An object bigger than the cap cannot be split — it rides alone, exactly as the
        // per-object protocol would have sent it. Every other request honors the cap.
        if (bodies[i]! > cap) {
          assert.equal(stub.batches[i]!.length, 1, `request ${i} exceeded the cap only because it is ONE object (${bodies[i]} bytes)`);
        }
      }
      const multi = bodies.filter((b, i) => stub.batches[i]!.length > 1);
      assert.ok(multi.length >= 1, "at least one request carried several objects");
      for (const b of multi) assert.ok(b <= cap, `a multi-object request stayed under the cap (${b} > ${cap})`);
    } finally {
      await stub.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hub that advertises batching but does not route it falls back per-object, mid-push", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-b99-liar-"));
  try {
    const repo = await Repo.init(dir);
    await authorMany(repo, 3);
    const stub = await stubHub({
      version: { batch: true, batchMaxBytes: 8 * 1024 * 1024 },
      onBatch: () => ({ status: 404, body: { error: "no such route" } }), // a proxy that drops it
    });
    try {
      const r = await pushToHub(dir, stub.url);
      assert.ok(r.pushed > 0, "the push completed anyway");
      assert.equal(stub.hits.get("/objects") ?? 0, r.pushed, "it fell back to one POST per object");
    } finally {
      await stub.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a 413 halves the chunk instead of failing the push (an unadvertised proxy body limit)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-b99-413-"));
  try {
    const repo = await Repo.init(dir);
    await authorMany(repo, 8);
    const limit = 1_500;
    const stub = await stubHub({
      version: { batch: true },
      onBatch: (objects, _call) => {
        const size = JSON.stringify({ version: 1, objects }).length;
        if (size > limit) return { status: 413, body: { error: "request body too large" } };
        return { status: 200, body: { results: objects.map((o) => ({ oid: o.oid, status: "stored" })) } };
      },
    });
    try {
      const r = await pushToHub(dir, stub.url);
      assert.ok(r.pushed > 10, `the push completed under an undisclosed limit (pushed=${r.pushed})`);
      assert.ok((stub.hits.get("/objects/batch") ?? 0) > 1, "it retried with smaller chunks");
      assert.equal(stub.hits.get("/objects") ?? 0, 0, "and never had to drop to the per-object protocol");
    } finally {
      await stub.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pull falls back to per-oid GETs against a hub without /objects/fetch", async () => {
  const src = await mkdtemp(join(tmpdir(), "avcs-b99-pf-src-"));
  const dst = await mkdtemp(join(tmpdir(), "avcs-b99-pf-dst-"));
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-b99-pf-hub-"));
  try {
    const repo = await Repo.init(src);
    await authorMany(repo, 3);
    const hub = await startHub({ repoDir: hubDir, port: 0 });
    try {
      await pushToHub(src, hub.url);
      await Repo.init(dst); // a bare dir has no `main` view to materialize into
      // A proxy that forwards everything EXCEPT /version's batch advertisement.
      const downgrade: Server = createServer((req, res) => {
        const path = (req.url ?? "/").split("?")[0]!;
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            const body = Buffer.concat(chunks);
            const headers = { ...req.headers } as Record<string, string>;
            delete headers["content-length"];
            delete headers["host"];
            const r = await fetch(`${hub.url}${req.url}`, { method: req.method, headers, ...(body.length ? { body } : {}) });
            let text = await r.text();
            if (path === "/version") {
              const v = JSON.parse(text) as Record<string, unknown>;
              delete v.batch;
              delete v.batchMaxBytes;
              text = JSON.stringify(v);
            }
            res.writeHead(r.status, { "content-type": "application/json" });
            res.end(text);
          })();
        });
      });
      await new Promise<void>((r) => downgrade.listen(0, "127.0.0.1", r));
      const port = (downgrade.address() as { port: number }).port;
      try {
        const r = await pullFromHub(dst, `http://127.0.0.1:${port}`);
        assert.ok(r.pulled > 0, `the pull completed over the per-oid protocol (pulled=${r.pulled})`);
        const repoB = await Repo.open(dst);
        assert.ok((await repoB.materialize()).tree.size > 0, "and the objects are usable");
      } finally {
        await new Promise<void>((r) => downgrade.close(() => r()));
      }
    } finally {
      await hub.close();
    }
  } finally {
    for (const d of [src, dst, hubDir]) await rm(d, { recursive: true, force: true });
  }
});

test("a batched fetch that the hub truncates still delivers everything", async () => {
  const src = await mkdtemp(join(tmpdir(), "avcs-b99-trunc-src-"));
  const dst = await mkdtemp(join(tmpdir(), "avcs-b99-trunc-dst-"));
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-b99-trunc-hub-"));
  try {
    const repo = await Repo.init(src);
    await authorMany(repo, 10);
    const hub = await startHub({ repoDir: hubDir, port: 0 });
    try {
      await pushToHub(src, hub.url);
      await Repo.init(dst); // a bare dir has no `main` view to materialize into
      // A proxy that truncates every /objects/fetch response to 3 objects and says so.
      let rounds = 0;
      const clipper: Server = createServer((req, res) => {
        const path = (req.url ?? "/").split("?")[0]!;
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            const body = Buffer.concat(chunks);
            const headers = { ...req.headers } as Record<string, string>;
            delete headers["content-length"];
            delete headers["host"];
            const r = await fetch(`${hub.url}${req.url}`, { method: req.method, headers, ...(body.length ? { body } : {}) });
            let text = await r.text();
            if (path === "/objects/fetch" && r.ok) {
              rounds++;
              const j = JSON.parse(text) as { objects: unknown[] };
              const clipped = j.objects.slice(0, 3);
              text = JSON.stringify({ objects: clipped, truncated: clipped.length < j.objects.length });
            }
            res.writeHead(r.status, { "content-type": "application/json" });
            res.end(text);
          })();
        });
      });
      await new Promise<void>((r) => clipper.listen(0, "127.0.0.1", r));
      const port = (clipper.address() as { port: number }).port;
      try {
        const r = await pullFromHub(dst, `http://127.0.0.1:${port}`);
        assert.ok(rounds > 1, `the client asked again for the remainder (${rounds} rounds)`);
        const tree = (await (await Repo.open(dst)).materialize()).tree;
        assert.equal(tree.size, 10, `every file arrived despite truncation (pulled=${r.pulled})`);
      } finally {
        await new Promise<void>((r) => clipper.close(() => r()));
      }
    } finally {
      await hub.close();
    }
  } finally {
    for (const d of [src, dst, hubDir]) await rm(d, { recursive: true, force: true });
  }
});
