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