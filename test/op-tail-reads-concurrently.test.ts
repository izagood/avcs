// Tailing the op-log must not read one object at a time (docs/11 A6).
//
// `#allOpsTailed` fetched each uncached oid with its own awaited `has` + `get`, so a cold
// materialize spent almost all its time waiting on one in-flight file read: the cost grew
// with history while the CPU sat idle, and the reduce itself was a rounding error beside
// it. The reads are independent — the op-log gives the order up front — so they are issued
// in bounded-concurrency batches instead.
//
// Concurrency must not change WHAT is returned: the ops stay in op-log order, and a
// logged-but-collected object is still skipped. The treeHash check pins the first (a cold
// materialize agrees with a warm one) and `test/hardening-gc.test.ts` pins the second.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { ObjectStore } from "../src/store/objectStore.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

/** Highest number of `get()` calls in flight at once. */
function watchInFlight(): { peak: () => number; restore: () => void } {
  const original = ObjectStore.prototype.get;
  let inFlight = 0;
  let peak = 0;
  ObjectStore.prototype.get = function (this: ObjectStore, oid: string) {
    inFlight++;
    if (inFlight > peak) peak = inFlight;
    return (original as (o: string) => Promise<unknown>)
      .call(this, oid)
      .finally(() => void inFlight--) as ReturnType<typeof original>;
  } as typeof ObjectStore.prototype.get;
  return { peak: () => peak, restore: () => void (ObjectStore.prototype.get = original) };
}

test("a cold materialize reads the op tail concurrently, and agrees with the warm result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-optail-"));
  const warm = await Repo.init(dir);
  const intent = await warm.createIntent({ title: "t", owner: "human:h" });
  const sess = await warm.startSession({ intentOid: intent, actor: ai });
  const OPS = 40;
  for (let i = 0; i < OPS; i++) {
    await warm.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: `f${i}.ts`, content: `v${i}\n`, declaredPurpose: `w${i}` });
  }
  const expected = await warm.materialize();

  // A fresh handle: nothing cached, so the whole tail is read from disk.
  const cold = await Repo.open(dir);
  const w = watchInFlight();
  let got;
  try {
    got = await cold.materialize();
  } finally {
    w.restore();
  }

  assert.equal(got.treeHash, expected.treeHash, "a cold tail must reduce to the same tree");
  assert.equal(got.tree.size, OPS);
  assert.ok(
    w.peak() > 1,
    `object reads never overlapped (peak in-flight ${w.peak()}) — the tail is still serial`,
  );
  await rm(dir, { recursive: true, force: true });
});
