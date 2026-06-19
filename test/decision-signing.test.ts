// Issue #15 (Layer 1): a human/owner decision only takes effect if it carries a
// valid signature from that actor's registered key. Unsigned or forged decisions
// simply disappear, so the conflict they claimed to resolve stays open — an agent
// cannot fabricate a human sign-off. Mirrors the evidence trust model in
// phase3-trust.test.ts. With no keyring configured, all decisions still apply
// (Phase-1 fallback), which the existing reducer/authority tests already cover.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:owner" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const ci: Actor = { kind: "ci_bot", id: "ci:tests" };

test("with a keyring, only a validly-signed human decision resolves a conflict", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-decision-"));
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "t", owner: human.id });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });

    // A public-API break: needs passing-test evidence, then escalates to a human decision.
    const op = await repo.proposeFileWrite({
      sessionOid: sess, intentOid: intent, actor: ai, path: "api.ts", content: "break",
      declaredPurpose: "break api", effects: { breaksPublicApi: true, changesBehavior: true },
    });

    // Keyring on: register ci + human keys. Trust now requires valid signatures.
    const ciKey = await repo.generateActorKey(ci);
    const humanKey = await repo.generateActorKey(human);

    // Clear the test gate with validly-signed ci evidence → op reaches needs_decision.
    await repo.attachEvidence({
      forOps: [op], kind: "unit_test", result: "pass", producedBy: ci,
      signWith: { keyId: ciKey.keyId, privateKey: ciKey.privateKey },
    });
    let res = await repo.materialize();
    assert.equal(res.statuses.get(op), "needs_decision", "public-API break awaits a human decision");
    const conflict = res.conflicts[0]!;

    // (a) Unsigned human decision (what an agent without the key can produce) → dropped.
    await repo.recordDecision({
      conflictId: conflict.id, chosenOps: [op], rejectedOps: [], reason: "forged accept", decidedBy: human,
    });
    assert.equal((await repo.materialize()).statuses.get(op), "needs_decision", "unsigned decision not trusted");

    // (b) Forged signature (wrong private key, claiming the human's keyId) → dropped.
    const forged = generateKeypair();
    await repo.recordDecision({
      conflictId: conflict.id, chosenOps: [op], rejectedOps: [], reason: "forged accept 2", decidedBy: human,
      signWith: { keyId: human.id, privateKey: forged.privateKey },
    });
    assert.equal((await repo.materialize()).statuses.get(op), "needs_decision", "forged decision rejected");

    // (c) Validly signed by the registered human key → trusted → the chosen op is accepted.
    await repo.recordDecision({
      conflictId: conflict.id, chosenOps: [op], rejectedOps: [], reason: "owner approves", decidedBy: human,
      signWith: { keyId: humanKey.keyId, privateKey: humanKey.privateKey },
    });
    assert.equal((await repo.materialize()).statuses.get(op), "accepted", "validly signed decision trusted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Issue #15 Layer 2 (B2): the local keystore lets the MCP server sign a decision on
// the owner's behalf (after an elicitation confirmation) with a key the agent never
// holds. Here we exercise the testable core — provision → load → sign → trusted.
// The elicitation prompt itself needs an elicitation-capable client and is covered
// by the MCP handler, not this unit test.
test("local keystore: a provisioned owner key signs a decision the trust gate accepts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-keystore-"));
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "t", owner: human.id });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    const op = await repo.proposeFileWrite({
      sessionOid: sess, intentOid: intent, actor: ai, path: "api.ts", content: "break",
      declaredPurpose: "break api", effects: { breaksPublicApi: true, changesBehavior: true },
    });
    const ciKey = await repo.generateActorKey(ci);
    await repo.attachEvidence({
      forOps: [op], kind: "unit_test", result: "pass", producedBy: ci,
      signWith: { keyId: ciKey.keyId, privateKey: ciKey.privateKey },
    });

    // No local key yet → loadLocalKey is null (the MCP handler would refuse to sign).
    assert.equal(await repo.loadLocalKey(human.id), null, "no local key before provisioning");

    // Provision the owner key: registers the public half + stores the private half locally.
    await repo.provisionOwnerKey(human);
    const priv = await repo.loadLocalKey(human.id);
    assert.ok(priv && priv.includes("PRIVATE KEY"), "local private key is retrievable after provisioning");

    const conflict = (await repo.materialize()).conflicts[0]!;
    // Exactly what the MCP server does after an elicitation confirmation: sign with the
    // owner's local key. The reducer's trust gate then accepts the decision.
    await repo.recordDecision({
      conflictId: conflict.id, chosenOps: [op], rejectedOps: [], reason: "owner approves via local key",
      decidedBy: human, signWith: { keyId: human.id, privateKey: priv! },
    });
    assert.equal((await repo.materialize()).statuses.get(op), "accepted", "locally-signed owner decision is trusted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
