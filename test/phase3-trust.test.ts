// Phase 3: cryptographic trust, work leases, and repair context.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { generateKeypair, signMessage, verifyMessage } from "../src/core/identity.ts";
import { scopesOverlap } from "../src/concurrency/lease.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const ci: Actor = { kind: "ci_bot", id: "ci:tests" };

test("ed25519 sign/verify; tampering fails", () => {
  const { publicKey, privateKey } = generateKeypair();
  const sig = signMessage(privateKey, "operation_abc");
  assert.equal(verifyMessage(publicKey, "operation_abc", sig), true);
  assert.equal(verifyMessage(publicKey, "operation_XYZ", sig), false, "different message");
  const other = generateKeypair();
  assert.equal(verifyMessage(other.publicKey, "operation_abc", sig), false, "different key");
});

async function behaviorRepo() {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  const op = await repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: ai, path: "svc.ts", content: "v1",
    declaredPurpose: "behavior", effects: { changesBehavior: true },
  });
  return { dir, repo, op };
}

test("with a keyring, only signed ci evidence is trusted", async () => {
  const { dir, repo, op } = await behaviorRepo();
  const key = await repo.generateActorKey(ci); // registers ci public key → keyring non-empty

  // (a) unsigned ci evidence is dropped → still gated.
  await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "pass", producedBy: ci });
  assert.equal((await repo.materialize()).statuses.get(op), "rejected", "unsigned ci evidence not trusted");

  // (b) forged signature (wrong private key, claiming ci's keyId) → dropped.
  const forged = generateKeypair();
  await repo.attachEvidence({
    forOps: [op], kind: "unit_test", result: "pass", producedBy: ci,
    signWith: { keyId: ci.id, privateKey: forged.privateKey },
  });
  assert.equal((await repo.materialize()).statuses.get(op), "rejected", "forged signature rejected");

  // (c) properly signed by the registered ci key → trusted → accepted.
  await repo.attachEvidence({
    forOps: [op], kind: "unit_test", result: "pass", producedBy: ci,
    signWith: { keyId: key.keyId, privateKey: key.privateKey },
  });
  assert.equal((await repo.materialize()).statuses.get(op), "accepted", "validly signed evidence trusted");
  await rm(dir, { recursive: true, force: true });
});

test("scope overlap: file scope covers its symbols", () => {
  assert.equal(scopesOverlap("file:a.ts", "file:a.ts"), true);
  assert.equal(scopesOverlap("file:mod.ts", "symbol:mod.ts#alpha"), true);
  assert.equal(scopesOverlap("file:src/", "file:src/a.ts"), true);
  assert.equal(scopesOverlap("symbol:mod.ts#alpha", "symbol:mod.ts#beta"), false);
  assert.equal(scopesOverlap("file:a.ts", "file:b.ts"), false);
});

test("exclusive lease blocks an overlapping second writer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sA = await repo.startSession({ intentOid: intent, actor: ai });
  const sB = await repo.startSession({ intentOid: intent, actor: { kind: "ai_agent", id: "ai:b" } });

  const g1 = await repo.requestLease({ intentOid: intent, sessionOid: sA, actor: ai, writeScopes: ["symbol:mod.ts#alpha"] });
  assert.equal(g1.granted, true);

  // Another agent wants the whole file — overlaps the held symbol → blocked.
  const g2 = await repo.requestLease({ intentOid: intent, sessionOid: sB, actor: { kind: "ai_agent", id: "ai:b" }, writeScopes: ["file:mod.ts"] });
  assert.equal(g2.granted, false);
  if (!g2.granted) assert.equal(g2.conflicts[0]!.heldBy, "ai:a");

  // A disjoint symbol is fine.
  const g3 = await repo.requestLease({ intentOid: intent, sessionOid: sB, actor: { kind: "ai_agent", id: "ai:b" }, writeScopes: ["symbol:mod.ts#beta"] });
  assert.equal(g3.granted, true);
  await rm(dir, { recursive: true, force: true });
});

test("repair context summarizes failures and stays minimal", async () => {
  const { dir, repo, op } = await behaviorRepo();
  await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "fail", producedBy: ci, detail: "AssertionError: expected 1" });
  const ctx = await repo.repairContext([op]);
  assert.equal(ctx.failures.length, 1);
  assert.equal(ctx.failures[0]!.result, "fail");
  assert.match(ctx.suggestion, /unit_test/);
  assert.equal(ctx.failedOps[0]!.oid, op);
  await rm(dir, { recursive: true, force: true });
});
