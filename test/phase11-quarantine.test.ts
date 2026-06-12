// Phase 11: external contributors. Outsiders (non-members) land in quarantine until
// a reviewer promotes them; untrusted-runner CI never grants trust; admission caps
// outstanding outsider work.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const outsider: Actor = { kind: "ai_agent", id: "ext:bob" };

async function governedRepo(role: "reviewer" | "proposer" = "reviewer") {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const root = generateKeypair();
  const member = generateKeypair();
  await repo.registerMembership({ actorId: "human:lead", publicKey: member.publicKey, role, actorKind: "human", root: { keyId: "root", privateKey: root.privateKey } });
  const intent = await repo.createIntent({ title: "t", owner: "human:lead" });
  const sess = await repo.startSession({ intentOid: intent, actor: outsider });
  return { dir, repo, intent, sess };
}

test("outsider op is quarantined until a reviewer promotes it", async () => {
  const { dir, repo, intent, sess } = await governedRepo("reviewer");
  const op = await repo.proposeOutsider({
    sessionOid: sess, intentOid: intent, actor: outsider,
    target: { entityKind: "file", entityId: "contrib.ts" },
    body: { kind: "put_file", path: "contrib.ts", blobOid: await repo.putBlob("// from a stranger\n") },
    declaredPurpose: "drive-by fix",
  });

  let res = await repo.materialize();
  assert.equal(res.statuses.get(op), "quarantined");
  assert.equal(res.tree.has("contrib.ts"), false, "quarantined work is not in the tree");
  assert.deepEqual(await repo.quarantinedOps(), [op]);

  await repo.promote([op], "human:lead", "looks good");
  res = await repo.materialize();
  assert.equal(res.statuses.get(op), "accepted");
  assert.equal(res.tree.has("contrib.ts"), true, "promoted → now in the tree");
  await rm(dir, { recursive: true, force: true });
});

test("promote requires reviewer role", async () => {
  const { dir, repo, intent, sess } = await governedRepo("proposer"); // member is only a proposer
  const op = await repo.proposeOutsider({
    sessionOid: sess, intentOid: intent, actor: outsider,
    target: { entityKind: "file", entityId: "c.ts" }, body: { kind: "put_file", path: "c.ts", blobOid: await repo.putBlob("x") },
    declaredPurpose: "x",
  });
  await assert.rejects(() => repo.promote([op], "human:lead"), /requires role >= reviewer/);
  await rm(dir, { recursive: true, force: true });
});

test("admission control caps outstanding outsider ops", async () => {
  const { dir, repo, intent, sess } = await governedRepo();
  const submit = async (n: number) =>
    repo.proposeOutsider({
      sessionOid: sess, intentOid: intent, actor: outsider, maxOutstanding: 2,
      target: { entityKind: "file", entityId: `f${n}.ts` }, body: { kind: "put_file", path: `f${n}.ts`, blobOid: await repo.putBlob(`x${n}`) },
      declaredPurpose: `f${n}`,
    });
  await submit(1);
  await submit(2);
  await assert.rejects(() => submit(3), /admission cap/);
  await rm(dir, { recursive: true, force: true });
});

test("untrusted-runner CI evidence does not grant trust", async () => {
  // governance off so quarantine doesn't interfere — isolate the untrusted-CI gate.
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  const op = await repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: ai, path: "svc.ts", content: "v1", declaredPurpose: "behavior", effects: { changesBehavior: true },
  });
  const ci: Actor = { kind: "ci_bot", id: "ci" };
  await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "pass", producedBy: ci, fromUntrustedRunner: true });
  assert.equal((await repo.materialize()).statuses.get(op), "rejected", "untrusted-runner pass is not trusted");
  await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "pass", producedBy: ci });
  assert.equal((await repo.materialize()).statuses.get(op), "accepted", "trusted re-run unblocks");
  await rm(dir, { recursive: true, force: true });
});
