// A6b: reduceIncremental wired into repo.materialize as an opt-in fast path. With
// AVCS_INCREMENTAL=1 the main materialize re-reduces only the delta from the last
// snapshot (falling back to full reduce when preconditions don't hold); with
// AVCS_VERIFY_INCREMENTAL=1 every incremental result is cross-checked against a full
// reduce and throws on divergence. node's test runner runs each file in its own process,
// so setting the flags at module load is isolated to this file.
process.env.AVCS_INCREMENTAL = "1";
process.env.AVCS_VERIFY_INCREMENTAL = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const human: Actor = { kind: "human", id: "human:h" };

/** A cold/full materialize from a brand-new instance (empty snapshot → full reduce). */
async function cold(dir: string): Promise<string> {
  return (await (await Repo.open(dir)).materialize()).treeHash;
}

test("incremental materialize matches full across an authoring sequence with conflicts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-wired-"));
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "t", owner: human.id });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    const sessH = await repo.startSession({ intentOid: intent, actor: human });

    // step 1: disjoint files (clean auto-merge)
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "export function a(){ return 1 }\n", declaredPurpose: "a" });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "b.ts", content: "export const b = 1\n", declaredPurpose: "b" });
    assert.equal((await repo.materialize()).treeHash, await cold(dir), "step1 inc==full");

    // step 2: symbol edit (splice) on a warm snapshot
    await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", newText: "export function a(){ return 2 }", declaredPurpose: "edit" });
    assert.equal((await repo.materialize()).treeHash, await cold(dir), "step2 inc==full");

    // step 3: a concurrent conflict on the same file (policy: human wins, no prompt)
    const aiOp = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "x.ts", content: "ai", declaredPurpose: "ai" });
    const huOp = await repo.proposeFileWrite({ sessionOid: sessH, intentOid: intent, actor: human, path: "x.ts", content: "hu", declaredPurpose: "hu" });
    const r3 = await repo.materialize();
    assert.equal(r3.treeHash, await cold(dir), "step3 inc==full");
    assert.equal(r3.statuses.get(huOp), "accepted");
    assert.equal(r3.statuses.get(aiOp), "rejected");

    // step 4: a public-API break that needs a human, then a decision rejecting it
    const op = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "api.ts", content: "break", declaredPurpose: "break", effects: { breaksPublicApi: true, changesBehavior: true } });
    await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "pass", producedBy: { kind: "ci_bot", id: "ci" } });
    const r4 = await repo.materialize();
    assert.equal(r4.treeHash, await cold(dir), "step4 inc==full");
    assert.equal(r4.statuses.get(op), "needs_decision");
    await repo.recordDecision({ conflictId: r4.conflicts[0]!.id, chosenOps: [], rejectedOps: [op], reason: "keep api", decidedBy: human });
    assert.equal((await repo.materialize()).treeHash, await cold(dir), "step4-decision inc==full");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("incremental falls back to full on a governance change (authority shift), staying correct", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-wired-gov-"));
  try {
    const repo = await Repo.init(dir);
    const root = generateKeypair();
    const admin = generateKeypair();
    await repo.registerMembership({ actorId: "human:admin", publicKey: admin.publicKey, role: "admin", root: { keyId: "root", privateKey: root.privateKey } });
    await repo.registerMembership({ actorId: "ai:a", publicKey: generateKeypair().publicKey, role: "proposer", root: { keyId: "root", privateKey: root.privateKey } });
    const intent = await repo.createIntent({ title: "t", owner: "human:admin" });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "a", declaredPurpose: "a" });
    assert.equal((await repo.materialize()).treeHash, await cold(dir), "warm==cold with governance");

    // revoke the proposer — authority map changes ⇒ reduceIncremental precondition fails ⇒
    // full fallback; result must still equal a cold full reduce.
    await repo.revokeMembership("ai:a", "human:admin");
    assert.equal((await repo.materialize()).treeHash, await cold(dir), "warm==cold after revocation (fallback path)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
