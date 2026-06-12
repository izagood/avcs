// Regression tests for the review findings (C1, C2, H1–H3). Each corresponds to a
// PoC that demonstrated a broken guarantee before the fix.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reduce } from "../src/reducer/reducer.ts";
import { defaultPolicy } from "../src/reducer/policy.ts";
import { Repo } from "../src/api/repo.ts";
import type { Actor, Decision, Operation } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };

function op(oid: string, actor: Actor, lamport: number, path = "x.ts"): Operation {
  return {
    type: "operation", oid, sessionOid: "s", intentOid: "i", actor,
    target: { entityKind: "file", entityId: path },
    body: { kind: "put_file", path, blobOid: `blob_${oid}` },
    causalDeps: [], declaredPurpose: oid, lamport, createdAt: "2026-01-01T00:00:00Z",
  };
}

// C1 — a much-later AI op must NOT beat a human op just because Lamport grew.
test("C1: lamport does not overwhelm the policy ladder", () => {
  const policy = defaultPolicy();
  for (const aiLamport of [2, 500, 5000, 50000]) {
    const res = reduce({
      ops: [op("op_human", human, 1), op("op_ai", ai, aiLamport)],
      evidence: [], decisions: [], intents: new Map(), policy,
    });
    assert.equal(res.statuses.get("op_human"), "accepted", `human must win at ai lamport ${aiLamport}`);
    assert.equal(res.statuses.get("op_ai"), "rejected");
  }
});

// C2 — reduction must not depend on the order the caller passes objects in.
test("C2: outcome is independent of decision/op input order", () => {
  const a = op("op_a", ai, 1), b = op("op_b", ai, 2);
  const policy = defaultPolicy();
  const mkDec = (oid: string, chosen: string, when: string): Decision => ({
    type: "decision", oid, conflictId: "c", chosenOps: [chosen],
    rejectedOps: [chosen === "op_a" ? "op_b" : "op_a"], reason: "r",
    decidedBy: human, createdAt: when,
  });
  // d2 is canonically later (createdAt) → its verdict (choose b) must win, both orders.
  const d1 = mkDec("decision_1", "op_a", "2026-01-02T00:00:00Z");
  const d2 = mkDec("decision_2", "op_b", "2026-01-03T00:00:00Z");
  const out = (decisions: Decision[], ops: Operation[]) =>
    reduce({ ops, evidence: [], decisions, intents: new Map(), policy }).tree.get("x.ts");
  const expected = out([d1, d2], [a, b]);
  assert.equal(out([d2, d1], [a, b]), expected, "decision order must not matter");
  assert.equal(out([d1, d2], [b, a]), expected, "op order must not matter");
  assert.equal(expected, "blob_op_b", "the later decision (choose b) wins");
});

// H2 — an operation's own author cannot vouch for it.
test("H2: self-reported evidence is ignored; trusted evidence unblocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  const o = await repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: ai, path: "svc.ts", content: "v1",
    declaredPurpose: "behavior", effects: { changesBehavior: true },
  });
  // The authoring agent attaches its own "passing test" — must be ignored.
  await repo.attachEvidence({ forOps: [o], kind: "unit_test", result: "pass", producedBy: ai });
  assert.equal((await repo.materialize()).statuses.get(o), "rejected", "self-reported test ignored");
  // A ci_bot vouches — now it unblocks.
  await repo.attachEvidence({ forOps: [o], kind: "unit_test", result: "pass", producedBy: { kind: "ci_bot", id: "ci" } });
  assert.equal((await repo.materialize()).statuses.get(o), "accepted");
  await rm(dir, { recursive: true, force: true });
});

// H3 — a rename contends on BOTH its source and destination paths.
test("H3: rename vs concurrent write to the destination conflicts (no silent loss)", () => {
  const policy = defaultPolicy();
  const rename: Operation = {
    type: "operation", oid: "op_rename", sessionOid: "s", intentOid: "i", actor: ai,
    target: { entityKind: "file", entityId: "a.ts" },
    body: { kind: "rename_file", fromPath: "a.ts", path: "b.ts" },
    causalDeps: [], declaredPurpose: "rename a→b", lamport: 1, createdAt: "2026-01-01T00:00:00Z",
  };
  const writeB = op("op_writeb", ai, 2, "b.ts"); // concurrent write to the rename target
  const res = reduce({ ops: [rename, writeB], evidence: [], decisions: [], intents: new Map(), policy });
  assert.equal(res.conflicts.length, 1, "rename/dest write must surface a conflict");
  assert.equal(res.statuses.get("op_rename"), "needs_decision");
  assert.equal(res.statuses.get("op_writeb"), "needs_decision");
});

// H4 — policy auto-merges are recorded, not silent.
test("H4: a policy auto-decision is recorded in autoDecisions", () => {
  const res = reduce({
    ops: [op("op_human", human, 1), op("op_ai", ai, 2)],
    evidence: [], decisions: [], intents: new Map(), policy: defaultPolicy(),
  });
  assert.equal(res.autoDecisions.length, 1);
  assert.equal(res.autoDecisions[0]!.chosenOp, "op_human");
  assert.deepEqual(res.autoDecisions[0]!.rejectedOps, ["op_ai"]);
});
