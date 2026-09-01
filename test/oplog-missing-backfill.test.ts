// A store with no op-log must still materialize, and must still stamp above its history.
//
// The log is a rebuildable cache: a store predating it (pre-A5) has none, and one can go
// missing. `#allOpsTailed` has always handled that by scanning the shards once and
// backfilling. When the read path started deciding candidates from the LOG's records instead
// of from every op, it stopped going through that helper — and an empty log then meant an
// empty candidate set, so a repo with three files materialized to an empty tree. Data that
// was entirely present read as absent.
//
// Both entries into the log (`materialize` and the Lamport reseed) are pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { ObjectStore } from "../src/store/objectStore.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function seeded(n: number): Promise<{ dir: string; repo: Repo }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-nolog-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  for (let i = 0; i < n; i++) {
    const r = await repo.materialize();
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: `f${i}.ts`, content: `v${i}\n`, declaredPurpose: `p${i}`, causalDeps: r.headOps });
  }
  return { dir, repo };
}

test("materialize rebuilds a missing op-log instead of reporting an empty tree", async () => {
  const { dir, repo } = await seeded(3);
  const expected = [...(await repo.materialize()).tree.keys()].sort();
  assert.deepEqual(expected, ["f0.ts", "f1.ts", "f2.ts"]);

  await unlink(join(dir, ".avcs", "oplog"));
  const cold = await Repo.open(dir);
  const res = await cold.materialize();

  assert.deepEqual([...res.tree.keys()].sort(), expected, "the tree must survive a lost op-log");
  assert.ok(
    (await new ObjectStore(dir).readOpLog()).length >= 3,
    "and the log must be backfilled so the next read is cheap again",
  );
});

test("a write after a lost op-log still stamps above the existing history", async () => {
  const { dir, repo } = await seeded(3);
  let maxBefore = 0;
  for (let i = 0; i < 3; i++)
    for (const op of await repo.historyOf(`file:f${i}.ts`)) maxBefore = Math.max(maxBefore, op.lamport);
  assert.ok(maxBefore > 0);

  await unlink(join(dir, ".avcs", "oplog"));
  const cold = await Repo.open(dir);
  const res = await cold.materialize();
  const intent = await cold.createIntent({ title: "after", owner: "human:h" });
  const sess = await cold.startSession({ intentOid: intent, actor: ai });
  await cold.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "after.ts", content: "x\n", declaredPurpose: "after", causalDeps: res.headOps });

  const [written] = await cold.historyOf("file:after.ts");
  assert.ok(written, "the new op should be readable");
  assert.ok(
    written.lamport > maxBefore,
    `lamport regressed: wrote ${written.lamport}, history already held ${maxBefore}`,
  );
  await rm(dir, { recursive: true, force: true });
});
