// Phase 12: redaction (leaked-secret byte eviction), break-glass override, rollback.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function governed(role: "admin" | "maintainer" | "proposer") {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const root = generateKeypair();
  const k = generateKeypair();
  await repo.registerMembership({ actorId: "human:lead", publicKey: k.publicKey, role, actorKind: "human", root: { keyId: "root", privateKey: root.privateKey } });
  return { dir, repo };
}

test("redaction evicts a blob's bytes but preserves the oid (treeHash stays valid)", async () => {
  const { dir, repo } = await governed("admin");
  const intent = await repo.createIntent({ title: "t", owner: "human:lead" });
  const sess = await repo.startSession({ intentOid: intent, actor: { kind: "human", id: "human:lead" } });
  const SECRET = "AWS_SECRET_KEY=AKIA_leaked_dont_keep_me\n";
  const op = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: { kind: "human", id: "human:lead" }, path: "config.env", content: SECRET, declaredPurpose: "oops" });

  const before = await repo.materialize();
  const blobOid = before.tree.get("config.env")!;
  assert.match((await repo.readBlob(blobOid)).toString("utf8"), /AKIA_leaked/, "secret present before redaction");

  await repo.redact(blobOid, "leaked AWS key", "human:lead");

  // Bytes are gone; oid still resolves; the tree still references the same oid.
  assert.doesNotMatch((await repo.readBlob(blobOid)).toString("utf8"), /AKIA_leaked/, "plaintext evicted");
  assert.match((await repo.readBlob(blobOid)).toString("utf8"), /REDACTED/);
  const after = await repo.materialize();
  assert.equal(after.tree.get("config.env"), blobOid, "oid (and treeHash references) preserved");
  assert.equal(after.treeHash, before.treeHash, "treeHash unchanged — references are by oid, not bytes");
  // a Redaction tombstone records provenance
  const reds = await repo.store.collect("redaction");
  assert.equal(reds.length, 1);
  void op;
  await rm(dir, { recursive: true, force: true });
});

test("redact requires admin", async () => {
  const { dir, repo } = await governed("maintainer");
  const blob = await repo.putBlob("secret");
  await assert.rejects(() => repo.redact(blob, "x", "human:lead"), /requires role admin/);
  await rm(dir, { recursive: true, force: true });
});

test("break-glass override waives a required check (expiring)", async () => {
  const { dir, repo } = await governed("maintainer");
  await repo.setProtection({ view: "main", requiredApprovals: 0, requireOwnerApproval: false, requiredChecks: ["unit_test"], finalizeRole: "maintainer", requireSignedOps: false, requireUpToDate: true, allowForcePush: false });
  const intent = await repo.createIntent({ title: "t", owner: "human:lead" });
  const sess = await repo.startSession({ intentOid: intent, actor: { kind: "human", id: "human:lead" } });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: { kind: "human", id: "human:lead" }, path: "a.ts", content: "1\n", declaredPurpose: "a" });
  const cp = await repo.createCheckpoint("main", "cp"); // no unit_test evidence

  const blocked = await repo.finalize({ view: "main", newCheckpoint: cp, parentHead: null, by: "human:lead" });
  assert.equal(blocked.finalized, false, "blocked: required unit_test not pass");

  await repo.grantOverride({ view: "main", waiveChecks: ["unit_test"], reason: "prod down", by: "human:lead", ttlMs: 60_000 });
  const ok = await repo.finalize({ view: "main", newCheckpoint: cp, parentHead: null, by: "human:lead" });
  assert.equal(ok.finalized, true, "override waives the check");

  // expired override does not waive
  const { dir: d2, repo: r2 } = await governed("maintainer");
  await r2.setProtection({ view: "main", requiredApprovals: 0, requireOwnerApproval: false, requiredChecks: ["unit_test"], finalizeRole: "maintainer", requireSignedOps: false, requireUpToDate: true, allowForcePush: false });
  const i2 = await r2.createIntent({ title: "t", owner: "human:lead" });
  const s2 = await r2.startSession({ intentOid: i2, actor: { kind: "human", id: "human:lead" } });
  await r2.proposeFileWrite({ sessionOid: s2, intentOid: i2, actor: { kind: "human", id: "human:lead" }, path: "a.ts", content: "1\n", declaredPurpose: "a" });
  const cp2 = await r2.createCheckpoint("main", "cp");
  await r2.grantOverride({ view: "main", waiveChecks: ["unit_test"], reason: "x", by: "human:lead", ttlMs: -1 }); // already expired
  const stillBlocked = await r2.finalize({ view: "main", newCheckpoint: cp2, parentHead: null, by: "human:lead" });
  assert.equal(stillBlocked.finalized, false, "expired override does not waive");
  await rm(dir, { recursive: true, force: true });
  await rm(d2, { recursive: true, force: true });
});

test("rollback advances the head forward to a prior checkpoint (CAS, no rewrite)", async () => {
  const { dir, repo } = await governed("maintainer");
  await repo.setProtection({ view: "main", requiredApprovals: 0, requireOwnerApproval: false, requiredChecks: [], finalizeRole: "maintainer", requireSignedOps: false, requireUpToDate: true, allowForcePush: false });
  const intent = await repo.createIntent({ title: "t", owner: "human:lead" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "v1\n", declaredPurpose: "a" });
  const cp1 = await repo.createCheckpoint("main", "cp1");
  await repo.finalize({ view: "main", newCheckpoint: cp1, parentHead: null, by: "human:lead" });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "b.ts", content: "v2\n", declaredPurpose: "b" });
  const cp2 = await repo.createCheckpoint("main", "cp2");
  await repo.finalize({ view: "main", newCheckpoint: cp2, parentHead: cp1, by: "human:lead" });
  assert.equal(await repo.protectedHead("main"), cp2);

  const rb = await repo.rollbackTo("main", cp1, "human:lead");
  assert.equal(rb.finalized, true);
  assert.equal(await repo.protectedHead("main"), cp1, "head rolled forward to the prior checkpoint");
  await rm(dir, { recursive: true, force: true });
});
