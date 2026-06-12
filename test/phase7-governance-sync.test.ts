// Phase 7: membership/roles, signed operations, object-gossip sync, and the
// finalize compare-and-swap (non-fast-forward rejection / causal-currency guard).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor, Operation } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };

test("membership grants a role; signed ops verify against the member key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const root = generateKeypair();
  const lead = generateKeypair();
  await repo.registerMembership({ actorId: "human:lead", publicKey: lead.publicKey, role: "maintainer", actorKind: "human", root: { keyId: "root", privateKey: root.privateKey } });

  assert.equal(await repo.roleOf("human:lead"), "maintainer");
  assert.equal(await repo.hasRole("human:lead", "reviewer"), true);
  assert.equal(await repo.hasRole("human:lead", "admin"), false);
  assert.equal(await repo.roleOf("nobody"), "reader");

  const intent = await repo.createIntent({ title: "t", owner: "human:lead" });
  const sess = await repo.startSession({ intentOid: intent, actor: { kind: "human", id: "human:lead" } });
  const opOid = await repo.proposeOperation({
    sessionOid: sess, intentOid: intent, actor: { kind: "human", id: "human:lead" },
    target: { entityKind: "file", entityId: "a.ts" }, body: { kind: "put_file", path: "a.ts", blobOid: await repo.putBlob("x") },
    declaredPurpose: "x", signWith: { keyId: "human:lead", privateKey: lead.privateKey },
  });
  const op = await repo.store.get<Operation>(opOid);
  assert.equal(repo.keyring.verifyFor("human:lead", opOid, op.sig), true, "signed op verifies");
  await rm(dir, { recursive: true, force: true });
});

test("object-gossip sync converges two replicas to the same tree", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "avcs-A-"));
  const dirB = await mkdtemp(join(tmpdir(), "avcs-B-"));
  const A = await Repo.init(dirA);
  const B = await Repo.init(dirB);
  const iA = await A.createIntent({ title: "t", owner: human.id });
  const sA = await A.startSession({ intentOid: iA, actor: ai });
  const iB = await B.createIntent({ title: "t", owner: human.id });
  const sB = await B.startSession({ intentOid: iB, actor: ai });

  // Disjoint work on each replica.
  await A.proposeFileWrite({ sessionOid: sA, intentOid: iA, actor: ai, path: "a.ts", content: "A\n", declaredPurpose: "a" });
  await B.proposeFileWrite({ sessionOid: sB, intentOid: iB, actor: ai, path: "b.ts", content: "B\n", declaredPurpose: "b" });

  // Gossip both ways.
  await A.pull(dirB);
  await B.pull(dirA);

  const ra = await A.materialize();
  const rb = await B.materialize();
  assert.equal(ra.treeHash, rb.treeHash, "replicas converge — sync has no conflict step");
  assert.deepEqual([...ra.tree.keys()].sort(), ["a.ts", "b.ts"]);
  // entity index was maintained on pull, so cross-replica blame works
  assert.equal((await A.historyOf("file:b.ts")).length, 1);
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
});

test("cross-replica conflict on the same symbol surfaces identically on both", async () => {
  // A shared base, then two replicas edit the SAME symbol concurrently. After sync,
  // both replicas independently reduce to the SAME conflict (conflicts are data).
  const dirA = await mkdtemp(join(tmpdir(), "avcs-A-"));
  const dirB = await mkdtemp(join(tmpdir(), "avcs-B-"));
  const A = await Repo.init(dirA);
  const greet = (v: string) => `export function greet() {\n  return "${v}";\n}`;
  const intent = await A.createIntent({ title: "t", owner: human.id });
  const sess = await A.startSession({ intentOid: intent, actor: ai });
  const base = await A.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", content: greet("v0") + "\n", declaredPurpose: "scaffold" });

  // B starts as a clone of A (pull), then both edit greet differently.
  const B = await Repo.init(dirB);
  await B.pull(dirA);
  await A.proposeSymbolEdit({ sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", symbolName: "greet", newText: greet("A"), declaredPurpose: "A edit", causalDeps: [base] });
  const sB = await B.startSession({ intentOid: intent, actor: { kind: "ai_agent", id: "ai:b" } });
  await B.proposeSymbolEdit({ sessionOid: sB, intentOid: intent, actor: { kind: "ai_agent", id: "ai:b" }, path: "mod.ts", symbolName: "greet", newText: greet("B"), declaredPurpose: "B edit", causalDeps: [base] });

  await A.pull(dirB);
  await B.pull(dirA);
  const ca = await A.materialize();
  const cb = await B.materialize();
  assert.equal(ca.conflicts.length, 1, "A sees the cross-replica conflict");
  assert.equal(cb.conflicts.length, 1, "B sees the same conflict");
  assert.equal(ca.conflicts[0]!.id, cb.conflicts[0]!.id, "identical conflict id on both replicas");
  assert.equal(ca.treeHash, cb.treeHash, "and identical materialized state");
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
});

test("finalize is a CAS: stale (non-fast-forward) finalize is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const root = generateKeypair();
  const lead = generateKeypair();
  await repo.registerMembership({ actorId: "human:lead", publicKey: lead.publicKey, role: "maintainer", actorKind: "human", root: { keyId: "root", privateKey: root.privateKey } });
  const ki = generateKeypair();
  await repo.registerMembership({ actorId: "ai:dev", publicKey: ki.publicKey, role: "proposer", root: { keyId: "root", privateKey: root.privateKey } });

  await repo.setProtection({ view: "main", requiredApprovals: 0, requireOwnerApproval: false, requiredChecks: [], finalizeRole: "maintainer", requireSignedOps: false, requireUpToDate: true, allowForcePush: false });

  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "1\n", declaredPurpose: "a" });
  const cp1 = await repo.createCheckpoint("main", "cp1");

  // First finalize: parentHead null (no head yet) → succeeds.
  const f1 = await repo.finalize({ view: "main", newCheckpoint: cp1, parentHead: null, by: "human:lead" });
  assert.equal(f1.finalized, true);
  assert.equal(await repo.protectedHead("main"), cp1);

  // New work → new checkpoint.
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "b.ts", content: "2\n", declaredPurpose: "b" });
  const cp2 = await repo.createCheckpoint("main", "cp2");

  // Stale finalize (parentHead null, but head is cp1) → rejected non-fast-forward.
  const stale = await repo.finalize({ view: "main", newCheckpoint: cp2, parentHead: null, by: "human:lead" });
  assert.equal(stale.finalized, false);
  if (!stale.finalized) assert.match(stale.reason, /head moved/);

  // Correct parentHead → succeeds.
  const f2 = await repo.finalize({ view: "main", newCheckpoint: cp2, parentHead: cp1, by: "human:lead" });
  assert.equal(f2.finalized, true);

  // A proposer (insufficient role) cannot finalize.
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "c.ts", content: "3\n", declaredPurpose: "c" });
  const cp3 = await repo.createCheckpoint("main", "cp3");
  const noRole = await repo.finalize({ view: "main", newCheckpoint: cp3, parentHead: cp2, by: "ai:dev" });
  assert.equal(noRole.finalized, false);
  if (!noRole.finalized) assert.match(noRole.reason, /role/);
  await rm(dir, { recursive: true, force: true });
});
