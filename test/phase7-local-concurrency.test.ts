// Local concurrency safety: atomic object writes (H-5) and atomic lease acquisition
// (H-6). These reproduce the races several agents sharing one .avcs/ would hit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { withLock } from "../src/store/lock.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai = (id: string): Actor => ({ kind: "ai_agent", id });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("withLock serializes a racy read-modify-write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-lock-"));
  const locks = join(dir, "locks");
  await mkdir(locks, { recursive: true });
  const counter = join(dir, "counter");
  await writeFile(counter, "0", "utf8");

  // 50 concurrent increments. The await between read and write guarantees lost
  // updates WITHOUT the lock; with it, the final value must be exactly 50.
  await Promise.all(
    Array.from({ length: 50 }, () =>
      withLock(locks, "ctr", async () => {
        const n = Number(await readFile(counter, "utf8"));
        await delay(0);
        await writeFile(counter, String(n + 1), "utf8");
      }),
    ),
  );
  assert.equal(await readFile(counter, "utf8"), "50");
  await rm(dir, { recursive: true, force: true });
});

test("a heartbeated lock releases cleanly: no in-flight stamp write survives the release", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-lock-hb-"));
  const locks = join(dir, "locks");
  await mkdir(locks, { recursive: true });

  // The heartbeat (Phase 15.2) re-stamps `owner` on an interval so a long-lived holder
  // — the sync-watch daemon — isn't reclaimed as stale. clearInterval stops future ticks
  // but says nothing about a tick already in flight: if its rename lands between the
  // release rm's readdir and its rmdir, the owner file is resurrected and rmdir fails
  // ENOTEMPTY. That throw comes out of a `finally`, so it REPLACES fn()'s successful
  // result — and leaves a freshly-stamped lock dir that blocks waiters for a full staleMs.
  //
  // HONESTY NOTE: this is a probabilistic stress guard, not a proof. The unpatched race
  // was measured at ~0.25% per round, so 300 rounds catch a REINTRODUCTION only about
  // half the time — a green run here does NOT establish that release is race-free.
  // Making it deterministic would need a scheduling seam in withLock, which is not worth
  // putting into production code; the fix itself (release awaits the stamp-write chain)
  // is what guarantees the invariant. Post-fix this test is exactly 0% flaky.
  const rounds = 300;
  for (let i = 0; i < rounds; i++) {
    const name = `hb${i}`;
    await withLock(locks, name, async () => { await delay(12); }, { heartbeatMs: 1 });
    assert.deepEqual(
      await readdir(join(locks)).then((es) => es.filter((e) => e === `${name}.lock`)),
      [],
      `release left the lock dir behind on round ${i}`,
    );
  }
  await rm(dir, { recursive: true, force: true });
});

test("H-6: concurrent requests for the same scope grant exactly one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: human });

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      repo.requestLease({ intentOid: intent, sessionOid: sess, actor: ai(`ai:${i}`), writeScopes: ["symbol:mod.ts#alpha"] }),
    ),
  );
  const granted = results.filter((r) => r.granted);
  assert.equal(granted.length, 1, "exactly one winner under the lock (no TOCTOU double-grant)");
  await rm(dir, { recursive: true, force: true });
});

test("H-6: concurrent requests for disjoint scopes all grant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: human });

  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      repo.requestLease({ intentOid: intent, sessionOid: sess, actor: ai(`ai:${i}`), writeScopes: [`symbol:mod.ts#s${i}`] }),
    ),
  );
  assert.equal(results.filter((r) => r.granted).length, 6, "disjoint scopes never block each other");
  await rm(dir, { recursive: true, force: true });
});

test("H-5: concurrent large writes/reads are atomic (no torn reads, no temp leftovers)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  // ~400KB each forces multi-syscall writes, where a non-atomic writer would tear.
  const big = (n: number) => `${n}:` + "x".repeat(400_000);

  // 24 distinct large blobs written concurrently, then all read back concurrently.
  const oids = await Promise.all(Array.from({ length: 24 }, (_, i) => repo.putBlob(big(i))));
  const contents = await Promise.all(oids.map((o) => repo.readBlob(o).then((b) => b.toString("utf8"))));
  contents.forEach((c, i) => assert.equal(c, big(i), `blob ${i} intact`));

  // Same content written concurrently → idempotent single object.
  const sameOids = await Promise.all(Array.from({ length: 10 }, () => repo.putBlob("identical")));
  assert.equal(new Set(sameOids).size, 1, "same content → one oid");

  // No leftover temp files in any object shard.
  const objectsDir = join(dir, ".avcs", "objects");
  for (const shard of await readdir(objectsDir)) {
    const files = await readdir(join(objectsDir, shard));
    assert.ok(files.every((f) => f.endsWith(".json")), `no temp files in shard ${shard}: ${files}`);
  }
  // The store is still fully parseable (no torn object survived).
  const blobs = await repo.store.collect("blob");
  assert.ok(blobs.length >= 25);
  await rm(dir, { recursive: true, force: true });
});
// A lock NAME is an identifier, not a path. Callers build names by interpolation —
// `snapshot:${viewName}` — and a view named after a git branch carries a slash, so the
// name reaches the filesystem as a nested path whose parent does not exist. `mkdir` then
// fails ENOENT, which the acquire loop reads as "the locks dir isn't there yet", recreates
// it, and retries — forever, at 100% CPU, never consulting maxWaitMs. Every first commit
// in a `feature/x` working tree hung on this.
test("a lock name containing a path separator acquires instead of spinning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-lock-sep-"));
  const locks = join(dir, "locks");
  await mkdir(locks, { recursive: true });

  for (const name of ["snapshot:team/feature-x", "back\\slash", "a/b/c/deep"]) {
    const got = await withLock(locks, name, async () => "ok", { maxWaitMs: 2000 });
    assert.equal(got, "ok", `${name} should acquire`);
  }
});

test("names that differ only by a separator do not share one lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-lock-collide-"));
  const locks = join(dir, "locks");
  await mkdir(locks, { recursive: true });

  // Encoding must be injective: "a/b" and the literal text "a%2Fb" are different names and
  // must not collide into the same lock file, or two unrelated critical sections serialize
  // (or worse, one reclaims the other's lock as stale).
  let inner = "not-run";
  await withLock(locks, "a/b", async () => {
    inner = await withLock(locks, "a%2Fb", async () => "independent", { maxWaitMs: 2000 });
  }, { maxWaitMs: 2000 });
  assert.equal(inner, "independent");
});

test("a separator-bearing name still serializes concurrent holders", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-lock-ser-"));
  const locks = join(dir, "locks");
  await mkdir(locks, { recursive: true });

  let live = 0;
  let maxLive = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      withLock(locks, "snapshot:team/feature-x", async () => {
        live++;
        maxLive = Math.max(maxLive, live);
        await delay(5);
        live--;
      }, { maxWaitMs: 5000 }),
    ),
  );
  assert.equal(maxLive, 1, "the lock must admit one holder at a time");
});

test("finalize on a branch-derived view name does not spin", async () => {
  // `finalize` and `integrationSubmit` both take `withLock("finalize:" + view)`. Views are
  // routinely named after git branches, so `land`/submit on a `team/x` line walked into the
  // same unbounded ENOENT retry as snapshot compaction did.
  const dir = await mkdtemp(join(tmpdir(), "avcs-fin-slash-"));
  const repo = await Repo.init(dir);
  await repo.createLine("team/feature-x");
  const cp = await repo.createCheckpoint("team/feature-x", "cp");

  const res = await repo.finalize({ view: "team/feature-x", newCheckpoint: cp, parentHead: null, by: human.id });
  assert.equal(res.finalized, true, `finalize should complete, got ${JSON.stringify(res)}`);
});
