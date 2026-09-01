import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { ObjectStore } from "../src/store/objectStore.ts";

/**
 * `Repo.open` must be O(1) in repository size.
 *
 * It used to reseed the Lamport clock by enumerating every operation object —
 * `store.list("operation")` reads and decodes each one, then throws them all
 * away keeping only `max(lamport)`. That made opening a repo scale with its
 * history, and every reader paid it: a read-only consumer that never stamps an
 * operation still walked the whole store before it could answer one question.
 *
 * The scan was also redundant. `proposeOperation` re-observes the highest
 * lamport from the op-log tail immediately before every stamp (Phase 13.2,
 * multi-process reseed), so the clock is corrected on the write path whether or
 * not `open` seeded it. Correctness never rested on the seed either — the
 * reducer tie-breaks by `(lamport, oid)`, which is total regardless.
 *
 * These tests pin both halves: opening reads nothing, and a write still lands
 * above the existing history.
 */

const alice = { id: "alice", kind: "human" as const };

async function repoWithHistory(ops: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-open-scan-"));
  const repo = await Repo.init(dir);
  await repo.provisionOwnerKey(alice);
  for (let i = 0; i < ops; i++) {
    const res = await repo.materialize();
    const intentOid = await repo.createIntent({ title: `edit ${i}`, owner: alice.id });
    const sessionOid = await repo.startSession({ intentOid, actor: alice });
    await repo.proposeFileWrite({
      sessionOid,
      intentOid,
      actor: alice,
      path: `file-${i}.txt`,
      content: `v${i}\n`,
      declaredPurpose: `edit ${i}`,
      causalDeps: res.headOps,
    });
  }
  return dir;
}

/** Count `list()` calls on the store, whatever type they ask for. */
function countListCalls(): { calls: string[]; restore: () => void } {
  const original = ObjectStore.prototype.list;
  const calls: string[] = [];
  ObjectStore.prototype.list = function (this: ObjectStore, type?: string) {
    calls.push(type ?? "<all>");
    return (original as (t?: string) => AsyncGenerator<unknown>).call(this, type);
  } as typeof ObjectStore.prototype.list;
  return { calls, restore: () => void (ObjectStore.prototype.list = original) };
}

test("open does not enumerate the object store", async () => {
  const dir = await repoWithHistory(4);
  const spy = countListCalls();
  try {
    await Repo.open(dir);
  } finally {
    spy.restore();
  }
  // Any `list` here is a full shard walk with a decode per file — the cost this
  // test exists to keep out of the open path.
  assert.deepEqual(spy.calls, [], `open enumerated the store: ${spy.calls.join(", ")}`);
});

test("a write after open still stamps above the existing history", async () => {
  const dir = await repoWithHistory(3);

  // Highest lamport already in the store, read through a public reader.
  const before = await Repo.open(dir);
  let maxBefore = 0;
  for (let i = 0; i < 3; i++) {
    for (const op of await before.historyOf(`file:file-${i}.txt`)) {
      maxBefore = Math.max(maxBefore, op.lamport);
    }
  }
  assert.ok(maxBefore > 0, "fixture should have stamped operations");

  // A fresh handle, as a second process would have: the clock starts at zero and
  // must still not reissue a lamport the store already holds.
  const fresh = await Repo.open(dir);
  const res = await fresh.materialize();
  const intentOid = await fresh.createIntent({ title: "after reopen", owner: alice.id });
  const sessionOid = await fresh.startSession({ intentOid, actor: alice });
  await fresh.proposeFileWrite({
    sessionOid,
    intentOid,
    actor: alice,
    path: "after-reopen.txt",
    content: "x\n",
    declaredPurpose: "after reopen",
    causalDeps: res.headOps,
  });

  const [written] = await fresh.historyOf("file:after-reopen.txt");
  assert.ok(written, "the new operation should be readable through historyOf");
  assert.ok(
    written.lamport > maxBefore,
    `lamport regressed: wrote ${written.lamport}, store already held ${maxBefore}`,
  );
});
