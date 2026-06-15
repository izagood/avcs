// M2/E: authority-weighted decision precedence (docs/08 §4) + key revocation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const greet = (v: string) => `export function greet() {\n  return "${v}";\n}`;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const root = generateKeypair();
  const mk = async (id: string, role: "reviewer" | "admin" | "proposer") => {
    const k = generateKeypair();
    await repo.registerMembership({ actorId: id, publicKey: k.publicKey, role, actorKind: "human", root: { keyId: "root", privateKey: root.privateKey } });
  };
  await mk("human:reviewer", "reviewer");
  await mk("human:admin", "admin");
  await mk("ai:a", "proposer"); // op author must be a member, else its ops quarantine
  const intent = await repo.createIntent({ title: "t", owner: "human:admin" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  const base = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", content: greet("v0") + "\n", declaredPurpose: "scaffold" });
  // two concurrent edits to the same symbol → a conflict to decide
  const opA = await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", newText: greet("A"), declaredPurpose: "A", causalDeps: [base] });
  const opB = await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", newText: greet("B"), declaredPurpose: "B", causalDeps: [base] });
  const conflict = (await repo.materialize()).conflicts[0]!;
  return { dir, repo, conflict, opA, opB };
}

test("higher-authority decision wins a contradiction (not wall-clock)", async () => {
  const { dir, repo, conflict, opA, opB } = await setup();
  // reviewer decides A first; admin later decides B. Authority (admin>reviewer) wins → B.
  await repo.recordDecision({ conflictId: conflict.id, chosenOps: [opA], rejectedOps: [opB], reason: "reviewer picks A", decidedBy: { kind: "human", id: "human:reviewer" } });
  await repo.recordDecision({ conflictId: conflict.id, chosenOps: [opB], rejectedOps: [opA], reason: "admin overrides to B", decidedBy: { kind: "human", id: "human:admin" } });
  const res = await repo.materialize();
  assert.equal(res.statuses.get(opB), "accepted", "admin (higher authority) wins");
  assert.equal(res.statuses.get(opA), "rejected");
  await rm(dir, { recursive: true, force: true });
});

test("authority beats recency even when the lower-authority decision is later", async () => {
  const { dir, repo, conflict, opA, opB } = await setup();
  // admin decides A first; reviewer decides B LATER. Authority should still pick A.
  await repo.recordDecision({ conflictId: conflict.id, chosenOps: [opA], rejectedOps: [opB], reason: "admin picks A", decidedBy: { kind: "human", id: "human:admin" } });
  await repo.recordDecision({ conflictId: conflict.id, chosenOps: [opB], rejectedOps: [opA], reason: "reviewer (later) picks B", decidedBy: { kind: "human", id: "human:reviewer" } });
  const res = await repo.materialize();
  assert.equal(res.statuses.get(opA), "accepted", "admin wins despite reviewer being later");
  await rm(dir, { recursive: true, force: true });
});

test("revoked member loses authority and trust", async () => {
  const { dir, repo } = await setup();
  assert.equal(await repo.roleOf("human:reviewer"), "reviewer");
  await repo.revokeMembership("human:reviewer", "human:admin");
  assert.equal(await repo.roleOf("human:reviewer"), "reader", "revoked → back to reader");
  await assert.rejects(() => repo.revokeMembership("human:admin", "human:reviewer"), /requires role admin/);
  await rm(dir, { recursive: true, force: true });
});
