// docs/17 §15.3 promises `contention({ keys })` is O(ops-on-key) via the entity index, "no
// reduce". The implementation seeded the actor's perspective by reading EVERY op in the store
// (issue #179), so every op a commit authored cost a full store read — 67 ops on a 9k-op store
// took 30 s, and a 585-op healing commit could never finish inside the hook deadline (#181).
//
// The contract is asserted through the store's own counter, not a stopwatch: a keyed check
// must not perform a full op scan at all, whatever the store size.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const alice: Actor = { kind: "ai_agent", id: "ai:alice" };
const bob: Actor = { kind: "ai_agent", id: "ai:bob" };

async function session(repo: Repo, actor: Actor): Promise<{ intent: string; sess: string }> {
  const intent = await repo.createIntent({ title: `work by ${actor.id}`, owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor });
  return { intent, sess };
}

async function write(repo: Repo, actor: Actor, path: string, content: string, causalDeps?: string[]): Promise<string> {
  const { intent, sess } = await session(repo, actor);
  return repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor, path, content, declaredPurpose: `write ${path}`, causalDeps });
}

/** A store with `n` ops on keys the check will never ask about. */
async function noisyRepo(n: number): Promise<{ repo: Repo; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-cont-cost-"));
  const repo = await Repo.init(dir);
  const { intent, sess } = await session(repo, alice);
  for (let i = 0; i < n; i++) {
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: alice, path: `noise/${i}.txt`, content: `${i}\n`, declaredPurpose: "noise" });
  }
  return { repo, dir };
}

const fullScans = (repo: Repo): number => repo.metrics.snapshot().counters["ops.fullScan"] ?? 0;

test("a keyed contention check performs no full op scan — O(ops-on-key), as docs/17 §15.3 states", async () => {
  const { repo, dir } = await noisyRepo(300);
  try {
    await write(repo, alice, "src/a.ts", "a\n");
    const before = fullScans(repo);
    const warnings = await repo.contention({ keys: ["file:src/a.ts"], actorId: alice.id });
    assert.deepEqual(warnings, [], "own work never warns");
    assert.equal(fullScans(repo), before, "the keyed perspective must come from the entity index, not from reading every op");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("authoring with warnContention does not scan the store per op", async () => {
  const { repo, dir } = await noisyRepo(300);
  try {
    const { intent, sess } = await session(repo, alice);
    const before = fullScans(repo);
    for (let i = 0; i < 5; i++) {
      await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: alice, path: `src/${i}.ts`, content: "x\n", declaredPurpose: "w", warnContention: true });
    }
    assert.equal(fullScans(repo), before, "five authored ops must not cost five full store reads");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the cheaper seed keeps the semantics: another actor's live op warns, mine and built-upon do not", async () => {
  const { repo, dir } = await noisyRepo(50);
  try {
    const mineFirst = await write(repo, alice, "src/x.ts", "a\n");
    const theirs = await write(repo, bob, "src/x.ts", "b\n");
    const w1 = await repo.contention({ keys: ["file:src/x.ts"], actorId: alice.id });
    assert.equal(w1.length, 1);
    assert.deepEqual(w1[0]!.theirs.map((t) => t.op), [theirs], "bob's concurrent op on my key is contention");
    assert.ok(!w1[0]!.theirs.some((t) => t.op === mineFirst), "my own op is never reported");

    // Once I build on bob's op it is my history, not a surprise.
    await write(repo, alice, "src/x.ts", "ab\n", [theirs]);
    const w2 = await repo.contention({ keys: ["file:src/x.ts"], actorId: alice.id });
    assert.deepEqual(w2, [], "built-upon work does not warn");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("without keys, every key I authored on is checked — not only those chained to my first op", async () => {
  // The discovery loop used the key set it was still filling as a filter, so after my first
  // op added its keys only ops touching THOSE keys were collected. `avcs status` therefore
  // reported contention on a lucky subset: here, bob's tip on src/b.ts was invisible because
  // my first op was on src/a.ts.
  const { repo, dir } = await noisyRepo(5);
  try {
    await write(repo, alice, "src/a.ts", "a\n");
    await write(repo, alice, "src/b.ts", "b\n");
    const theirs = await write(repo, bob, "src/b.ts", "B\n");
    const w = await repo.contention({ actorId: alice.id });
    assert.deepEqual(w.map((x) => x.key), ["file:src/b.ts"]);
    assert.deepEqual(w[0]!.theirs.map((t) => t.op), [theirs]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a full scan is still allowed — and counted — when no keys are given and the perspective must be discovered", async () => {
  const { repo, dir } = await noisyRepo(20);
  try {
    await write(repo, alice, "src/a.ts", "a\n");
    const before = fullScans(repo);
    await repo.contention({ actorId: alice.id });
    assert.ok(fullScans(repo) > before, "without keys the actor's keys can only come from the ops themselves");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
