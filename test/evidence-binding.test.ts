// Phase 13.4 (docs/17 §13.4) — evidence treeHash binding made real. createCheckpoint
// prefers evidence bound to THIS tree, excludes evidence proving a DIFFERENT tree, and
// records unstamped (legacy) evidence as such; Protection.requireBoundEvidence turns
// that record into a finalize gate. Prerequisite for the Phase 14 integration queue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor, Checkpoint, RoleName } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ci: Actor = { kind: "ci_bot", id: "ci:runner" };

async function repoWithOp() {
  const dir = await mkdtemp(join(tmpdir(), "avcs-bind-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: human });
  const op = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: human, path: "f.ts", content: "1\n", declaredPurpose: "p" });
  return { dir, repo, op };
}

test("checkpoint aggregation: bound recorded, mismatched excluded, legacy recorded as legacy", async () => {
  const { dir, repo, op } = await repoWithOp();
  try {
    const { treeHash } = await repo.materialize("main");

    // bound: stamped with THIS tree's hash
    await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "pass", producedBy: ci, treeHash });
    // mismatched: stamped against a DIFFERENT tree — proves that tree, not this one
    await repo.attachEvidence({ forOps: [op], kind: "lint", result: "pass", producedBy: ci, treeHash: "sha256:not-this-tree" });
    // legacy: no treeHash stamp at all
    await repo.attachEvidence({ forOps: [op], kind: "typecheck", result: "pass", producedBy: ci });

    const cp = await repo.store.get<Checkpoint>(await repo.createCheckpoint("main", "cp"));
    assert.equal(cp.evidence.unit_test, "pass");
    assert.equal(cp.evidenceBinding?.unit_test, "bound", "matching treeHash → bound");
    assert.equal(cp.evidence.lint, undefined, "evidence for another tree is excluded entirely");
    assert.equal(cp.evidenceBinding?.lint, undefined);
    assert.equal(cp.evidence.typecheck, "pass", "legacy evidence still aggregates (compat)");
    assert.equal(cp.evidenceBinding?.typecheck, "legacy", "…but its binding is recorded as legacy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bound evidence outranks legacy for the same kind, regardless of arrival order", async () => {
  const { dir, repo, op } = await repoWithOp();
  try {
    const { treeHash } = await repo.materialize("main");
    // legacy FAIL arrives around a bound PASS — the bound result must win either way
    await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "fail", producedBy: ci });
    await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "pass", producedBy: ci, treeHash });
    await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "fail", producedBy: ci });

    const cp = await repo.store.get<Checkpoint>(await repo.createCheckpoint("main", "cp"));
    assert.equal(cp.evidence.unit_test, "pass", "bound pass beats legacy fails on both sides");
    assert.equal(cp.evidenceBinding?.unit_test, "bound");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a checkpoint with no aggregated evidence carries no evidenceBinding field (oid compat)", async () => {
  const { dir, repo } = await repoWithOp();
  try {
    const cp = await repo.store.get<Checkpoint>(await repo.createCheckpoint("main", "cp"));
    assert.equal(cp.evidenceBinding, undefined, "pre-13.4 byte layout when nothing aggregated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Protection.requireBoundEvidence: legacy pass stops satisfying finalize; bound pass finalizes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-bind-gate-"));
  try {
    const repo = await Repo.init(dir);
    const root = generateKeypair();
    const mk = async (id: string, role: RoleName) => {
      const k = generateKeypair();
      await repo.registerMembership({ actorId: id, publicKey: k.publicKey, role, root: { keyId: "root", privateKey: root.privateKey } });
    };
    await mk("human:h", "maintainer");
    await mk("ci:runner", "proposer");

    const intent = await repo.createIntent({ title: "t", owner: human.id });
    const sess = await repo.startSession({ intentOid: intent, actor: human });
    const op = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: human, path: "f.ts", content: "1\n", declaredPurpose: "p" });
    await repo.setProtection({
      view: "main", requiredApprovals: 0, requireOwnerApproval: false, requiredChecks: ["unit_test"],
      finalizeRole: "maintainer", requireSignedOps: false, requireUpToDate: true, allowForcePush: false,
      requireBoundEvidence: true,
    });

    // legacy (unstamped) pass — aggregates, but the opted-in gate refuses it
    await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "pass", producedBy: ci });
    const cp1 = await repo.createCheckpoint("main", "legacy-only");
    const f1 = await repo.finalize({ view: "main", newCheckpoint: cp1, parentHead: null, by: "human:h" });
    assert.equal(f1.finalized, false);
    assert.match((f1 as { reason: string }).reason, /not bound to this tree/);

    // bound pass against the actual tree — gate satisfied
    const { treeHash } = await repo.materialize("main");
    await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "pass", producedBy: ci, treeHash });
    const cp2 = await repo.createCheckpoint("main", "bound");
    const f2 = await repo.finalize({ view: "main", newCheckpoint: cp2, parentHead: null, by: "human:h" });
    assert.equal(f2.finalized, true, "tree-bound evidence finalizes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default (requireBoundEvidence unset): legacy pass keeps finalizing — backward compat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-bind-compat-"));
  try {
    const repo = await Repo.init(dir);
    const root = generateKeypair();
    const k = generateKeypair();
    await repo.registerMembership({ actorId: "human:h", publicKey: k.publicKey, role: "maintainer", root: { keyId: "root", privateKey: root.privateKey } });

    const intent = await repo.createIntent({ title: "t", owner: human.id });
    const sess = await repo.startSession({ intentOid: intent, actor: human });
    const op = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: human, path: "f.ts", content: "1\n", declaredPurpose: "p" });
    await repo.setProtection({
      view: "main", requiredApprovals: 0, requireOwnerApproval: false, requiredChecks: ["unit_test"],
      finalizeRole: "maintainer", requireSignedOps: false, requireUpToDate: true, allowForcePush: false,
    });
    await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "pass", producedBy: ci });
    const cp = await repo.createCheckpoint("main", "legacy");
    const f = await repo.finalize({ view: "main", newCheckpoint: cp, parentHead: null, by: "human:h" });
    assert.equal(f.finalized, true, "existing repos are unaffected until a protection opts in");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
