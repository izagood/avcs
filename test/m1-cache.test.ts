// M1: reduction result cache — sound (identical inputs → identical result), and
// clone-on-hit so a caller mutating the result can't corrupt the cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };

test("repeated materialize is identical (cache hit) and updates on new ops", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  const a = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "1\n", declaredPurpose: "a" });
  const h1 = (await repo.materialize()).treeHash;
  const h2 = (await repo.materialize()).treeHash; // cache hit
  assert.equal(h1, h2);
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "b.ts", content: "2\n", declaredPurpose: "b", causalDeps: [a] });
  const h3 = (await repo.materialize()).treeHash; // signature changed → recompute
  assert.notEqual(h1, h3, "new op invalidates the cache");
  assert.equal((await repo.materialize()).tree.size, 2);
  await rm(dir, { recursive: true, force: true });
});

test("clone-on-hit: mutating a returned result does not corrupt later materialize", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "1\n", declaredPurpose: "a" });
  const r1 = await repo.materialize();
  r1.tree.clear();
  r1.statuses.clear();
  r1.conflicts.push({ id: "x", key: "x", kind: "needs_human", reason: "", recommendedOp: null, options: [] });
  const r2 = await repo.materialize();
  assert.equal(r2.tree.size, 1, "cache untouched by caller mutation");
  assert.equal(r2.conflicts.length, 0);
  await rm(dir, { recursive: true, force: true });
});
