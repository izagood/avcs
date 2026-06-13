// Governance hardening (docs/08): required approvals + causal-complete finalize gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor, RoleName } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function org() {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const root = generateKeypair();
  const mk = async (id: string, role: RoleName) => {
    const k = generateKeypair();
    await repo.registerMembership({ actorId: id, publicKey: k.publicKey, role, root: { keyId: "root", privateKey: root.privateKey } });
  };
  await mk("ai:a", "proposer");
  await mk("human:rev", "reviewer");
  await mk("human:rev2", "reviewer");
  await mk("human:lead", "maintainer");
  return { dir, repo };
}

test("required approvals gate finalize; request_changes blocks; owner approval required", async () => {
  const { dir, repo } = await org();
  await repo.setProtection({ view: "main", requiredApprovals: 2, requireOwnerApproval: true, requiredChecks: [], finalizeRole: "maintainer", requireSignedOps: false, requireUpToDate: true, allowForcePush: false });
  const intent = await repo.createIntent({ title: "t", owner: "human:lead" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "1\n", declaredPurpose: "a" });
  const cp = await repo.createCheckpoint("main", "cp");

  let f = await repo.finalize({ view: "main", newCheckpoint: cp, parentHead: null, by: "human:lead" });
  assert.equal(f.finalized, false, "0 approvals < 2");

  await repo.approve(cp, "human:rev");
  await repo.approve(cp, "human:rev2");
  f = await repo.finalize({ view: "main", newCheckpoint: cp, parentHead: null, by: "human:lead" });
  assert.equal(f.finalized, false, "2 reviewer approvals but no owner approval");

  await repo.approve(cp, "human:lead"); // maintainer = owner proxy
  f = await repo.finalize({ view: "main", newCheckpoint: cp, parentHead: null, by: "human:lead" });
  assert.equal(f.finalized, true, "2+ approvals incl. owner → finalizes");

  // a later request_changes blocks a subsequent finalize of a new checkpoint
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "b.ts", content: "2\n", declaredPurpose: "b" });
  const cp2 = await repo.createCheckpoint("main", "cp2");
  await repo.approve(cp2, "human:rev");
  await repo.approve(cp2, "human:lead");
  await repo.approve(cp2, "human:rev2", "request_changes");
  const f2 = await repo.finalize({ view: "main", newCheckpoint: cp2, parentHead: cp, by: "human:lead" });
  assert.equal(f2.finalized, false);
  if (!f2.finalized) assert.match(f2.reason, /changes requested/);

  await assert.rejects(() => repo.approve(cp2, "ai:a"), /requires role >= reviewer/);
  await rm(dir, { recursive: true, force: true });
});

test("causal-complete gate: finalize refuses a checkpoint with missing ancestors", async () => {
  const { dir, repo } = await org();
  await repo.setProtection({ view: "main", requiredApprovals: 0, requireOwnerApproval: false, requiredChecks: [], finalizeRole: "maintainer", requireSignedOps: false, requireUpToDate: true, allowForcePush: false });
  const intent = await repo.createIntent({ title: "t", owner: "human:lead" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "1\n", declaredPurpose: "a" });
  const cp = await repo.createCheckpoint("main", "cp");

  // Hand-craft a checkpoint whose frontier references a non-existent op (partial sync).
  const badCp = await repo.store.put({ ...(await repo.store.get(cp)), headOps: ["operation_doesnotexist0000000000000000"], summary: "bad" } as never);
  const f = await repo.finalize({ view: "main", newCheckpoint: badCp, parentHead: null, by: "human:lead" });
  assert.equal(f.finalized, false);
  if (!f.finalized) assert.match(f.reason, /incomplete causal history/);

  // the real checkpoint (complete) finalizes fine
  const ok = await repo.finalize({ view: "main", newCheckpoint: cp, parentHead: null, by: "human:lead" });
  assert.equal(ok.finalized, true);
  await rm(dir, { recursive: true, force: true });
});
