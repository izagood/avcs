// Behavioral contract of the reducer, run with:
//   node --experimental-strip-types --test test/*.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function tmpRepo(): Promise<{ repo: Repo; dir: string; intent: string; sess: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({
    title: "t",
    owner: human.id,
    constraints: ["public API 변경 금지"],
  });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  return { repo, dir, intent, sess };
}

test("disjoint files auto-merge", async () => {
  const { repo, dir, intent, sess } = await tmpRepo();
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "a", declaredPurpose: "a" });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: human, path: "b.ts", content: "b", declaredPurpose: "b" });
  const res = await repo.materialize();
  assert.equal(res.tree.size, 2);
  assert.equal(res.conflicts.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test("concurrent same-file: human wins by policy, no human prompt", async () => {
  const { repo, dir, intent, sess } = await tmpRepo();
  const aiOp = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "x.ts", content: "ai", declaredPurpose: "ai" });
  const huOp = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: human, path: "x.ts", content: "hu", declaredPurpose: "hu" });
  const res = await repo.materialize();
  assert.equal(res.conflicts.length, 0, "policy auto-decides");
  assert.equal(res.statuses.get(huOp), "accepted");
  assert.equal(res.statuses.get(aiOp), "rejected");
  await rm(dir, { recursive: true, force: true });
});

test("behavior change is gated until a passing test is attached", async () => {
  const { repo, dir, intent, sess } = await tmpRepo();
  const op = await repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: ai, path: "svc.ts", content: "v1",
    declaredPurpose: "behavior", effects: { changesBehavior: true },
  });
  let res = await repo.materialize();
  assert.equal(res.statuses.get(op), "rejected", "no test → blocked");
  await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "pass", producedBy: { kind: "ci_bot", id: "ci" } });
  res = await repo.materialize();
  assert.equal(res.statuses.get(op), "accepted", "passing test → accepted");
  await rm(dir, { recursive: true, force: true });
});

test("public-API break needs a human, and reject keeps it out of the tree", async () => {
  const { repo, dir, intent, sess } = await tmpRepo();
  const op = await repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: ai, path: "api.ts", content: "break",
    declaredPurpose: "break api", effects: { breaksPublicApi: true, changesBehavior: true },
  });
  await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "pass", producedBy: { kind: "ci_bot", id: "ci" } });
  let res = await repo.materialize();
  assert.equal(res.statuses.get(op), "needs_decision");
  assert.equal(res.conflicts.length, 1);
  const conflict = res.conflicts[0]!;
  await repo.recordDecision({ conflictId: conflict.id, chosenOps: [], rejectedOps: [op], reason: "keep api", decidedBy: human });
  res = await repo.materialize();
  assert.equal(res.statuses.get(op), "rejected");
  assert.equal(res.tree.has("api.ts"), false);
  assert.equal(res.conflicts.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test("materialization is deterministic", async () => {
  const { repo, dir, intent, sess } = await tmpRepo();
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "a", declaredPurpose: "a" });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "b.ts", content: "b", declaredPurpose: "b" });
  const h1 = (await repo.materialize()).treeHash;
  const h2 = (await repo.materialize()).treeHash;
  assert.equal(h1, h2);
  await rm(dir, { recursive: true, force: true });
});
