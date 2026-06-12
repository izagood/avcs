// Smaller use-case gaps from docs/09: revert op, co-authors, stash (private ops),
// semver releases, line-scoped protection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor, Operation, Release } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function base() {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  return { dir, repo, intent, sess };
}

test("revert restores the prior content as a forward op with provenance", async () => {
  const { dir, repo, intent, sess } = await base();
  const a = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "f.ts", content: "v1\n", declaredPurpose: "v1" });
  const b = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "f.ts", content: "v2\n", declaredPurpose: "v2", causalDeps: [a] });
  assert.match((await repo.materializedFiles(await repo.materialize())).find((f) => f.path === "f.ts")!.content, /v2/);

  const rev = await repo.revert(b, human);
  const revOp = await repo.store.get<Operation>(rev);
  assert.equal(revOp.revertOf, b);
  assert.match((await repo.materializedFiles(await repo.materialize())).find((f) => f.path === "f.ts")!.content, /v1/, "reverted to v1");
  await rm(dir, { recursive: true, force: true });
});

test("reverting the file's first op deletes the file", async () => {
  const { dir, repo, intent, sess } = await base();
  const a = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "f.ts", content: "v1\n", declaredPurpose: "v1" });
  await repo.revert(a, human);
  assert.equal((await repo.materialize()).tree.has("f.ts"), false, "file gone");
  await rm(dir, { recursive: true, force: true });
});

test("co-authors recorded; signer stays single", async () => {
  const { dir, repo, intent, sess } = await base();
  const op = await repo.proposeOperation({
    sessionOid: sess, intentOid: intent, actor: ai,
    target: { entityKind: "file", entityId: "a.ts" }, body: { kind: "put_file", path: "a.ts", blobOid: await repo.putBlob("x") },
    declaredPurpose: "pair", coAuthors: [human, { kind: "ai_agent", id: "ai:b" }],
  });
  const o = await repo.store.get<Operation>(op);
  assert.equal(o.actor.id, "ai:a");
  assert.deepEqual(o.coAuthors?.map((a) => a.id), ["human:h", "ai:b"]);
  await rm(dir, { recursive: true, force: true });
});

test("stash: private ops are local-only (not gossiped)", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "avcs-A-"));
  const dirB = await mkdtemp(join(tmpdir(), "avcs-B-"));
  const A = await Repo.init(dirA);
  const B = await Repo.init(dirB);
  const intent = await A.createIntent({ title: "t", owner: human.id });
  const sess = await A.startSession({ intentOid: intent, actor: ai });
  await A.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "shared.ts", content: "s\n", declaredPurpose: "shared" });
  await A.proposeOperation({ sessionOid: sess, intentOid: intent, actor: ai, target: { entityKind: "file", entityId: "wip.ts" }, body: { kind: "put_file", path: "wip.ts", blobOid: await A.putBlob("wip") }, declaredPurpose: "stash", private: true });

  await B.pull(dirA);
  const bFiles = [...(await B.materialize()).tree.keys()];
  assert.ok(bFiles.includes("shared.ts"));
  assert.ok(!bFiles.includes("wip.ts"), "private stash op was not gossiped");
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
});

test("release carries semver + support status, addressable by version", async () => {
  const { dir, repo, intent, sess } = await base();
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "1\n", declaredPurpose: "a" });
  const out = await repo.cutRelease("main", { version: "1.2.3", supportStatus: "supported" });
  assert.equal(out.released, true);
  if (!out.released) return;
  const rel = await repo.store.get<Release>(out.releaseOid);
  assert.equal(rel.version, "1.2.3");
  assert.equal(rel.supportStatus, "supported");
  assert.equal(await repo.store.getRef("release:main:1.2.3"), out.releaseOid, "addressable by version");
  await rm(dir, { recursive: true, force: true });
});

test("line-scoped protection: a line is a view, so Protection already scopes per line", async () => {
  const { dir, repo } = await base();
  await repo.createLine("v1.x", "main");
  await repo.setProtection({ view: "v1.x", requiredApprovals: 2, requireOwnerApproval: true, requiredChecks: ["unit_test"], finalizeRole: "admin", requireSignedOps: true, requireUpToDate: true, allowForcePush: false });
  const p = await repo.getProtection("v1.x");
  assert.equal(p?.finalizeRole, "admin");
  assert.equal(await repo.getProtection("main"), null, "main has its own (here: none)");
  await rm(dir, { recursive: true, force: true });
});
