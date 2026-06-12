// Phase 5: code-owner routing + learned trust.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { reduce } from "../src/reducer/reducer.ts";
import { defaultPolicy } from "../src/reducer/policy.ts";
import { ownersFor } from "../src/policy/owners.ts";
import { computeReliability } from "../src/policy/reliability.ts";
import type { Actor, Decision, Evidence, Operation } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const ci: Actor = { kind: "ci_bot", id: "ci" };

function op(oid: string, actor: Actor, lamport: number, path = "x.ts"): Operation {
  return {
    type: "operation", oid, sessionOid: "s", intentOid: "i", actor,
    target: { entityKind: "file", entityId: path },
    body: { kind: "put_file", path, blobOid: `blob_${oid}` },
    causalDeps: [], declaredPurpose: oid, lamport, createdAt: "2026-01-01T00:00:00Z",
  };
}

test("ownersFor: prefix + file-covers-symbol matching", () => {
  const rules = [
    { scope: "file:src/api/", owners: ["human:lead"] },
    { scope: "file:src/api/pay.ts", owners: ["human:pay"] },
  ];
  assert.deepEqual(ownersFor("file:src/api/users.ts", rules), ["human:lead"]);
  // most specific first → pay owner ahead of lead
  assert.deepEqual(ownersFor("file:src/api/pay.ts", rules), ["human:pay", "human:lead"]);
  assert.deepEqual(ownersFor("symbol:src/api/pay.ts#charge", rules), ["human:pay", "human:lead"]);
  assert.deepEqual(ownersFor("file:src/util.ts", rules), []);
});

test("a needs_human conflict is routed to the scope owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  await repo.setOwners([{ scope: "file:src/api/", owners: ["human:lead"] }]);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  await repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: ai, path: "src/api/users.ts", content: "x",
    declaredPurpose: "break", effects: { breaksPublicApi: true },
  });
  const res = await repo.materialize();
  assert.equal(res.conflicts.length, 1);
  assert.deepEqual(res.conflicts[0]!.requiredOwners, ["human:lead"]);
  await rm(dir, { recursive: true, force: true });
});

test("computeReliability rewards verified passes, penalizes human rejects", () => {
  const good = op("op_good", { kind: "ai_agent", id: "ai:good" }, 1, "a.ts");
  const bad = op("op_bad", { kind: "ai_agent", id: "ai:bad" }, 2, "b.ts");
  const ev: Evidence[] = [
    { type: "evidence", oid: "e1", forOps: ["op_good"], kind: "unit_test", result: "pass", producedBy: ci, createdAt: "t" },
    // self-reported pass must NOT build trust
    { type: "evidence", oid: "e2", forOps: ["op_bad"], kind: "unit_test", result: "pass", producedBy: { kind: "ai_agent", id: "ai:bad" }, createdAt: "t" },
  ];
  const dec: Decision[] = [
    { type: "decision", oid: "d1", conflictId: "c", chosenOps: [], rejectedOps: ["op_bad"], reason: "no", decidedBy: human, createdAt: "t" },
  ];
  const r = computeReliability([good, bad], ev, dec);
  assert.equal(r.get("ai:good"), 1);
  assert.equal(r.get("ai:bad"), -1);
});

test("learned reliability breaks an otherwise-even contest", () => {
  // Two ai agents, same file, nothing else to separate them but reliability.
  const a = op("op_a", { kind: "ai_agent", id: "ai:good" }, 1);
  const b = op("op_b", { kind: "ai_agent", id: "ai:bad" }, 2);
  const reliability = new Map([["ai:good", 2], ["ai:bad", -2]]);
  const res = reduce({ ops: [a, b], evidence: [], decisions: [], intents: new Map(), policy: defaultPolicy(), reliability });
  assert.equal(res.statuses.get("op_a"), "accepted", "more reliable agent wins");
  assert.equal(res.statuses.get("op_b"), "rejected");
  assert.equal(res.autoDecisions[0]!.chosenOp, "op_a");
});
