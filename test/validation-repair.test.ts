// Unit tests for buildRepairContext — the focused repair packet handed to an agent
// when validation fails. It must include only the failing evidence/relevant decisions
// for the given ops, truncate long output, and never invent failures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRepairContext } from "../src/validation/repair.ts";
import type { Decision, Evidence, Operation } from "../src/objects/types.ts";

const ai = { kind: "ai_agent", id: "ai:a" } as const;
const human = { kind: "human", id: "human:h" } as const;

function op(oid: string, path: string, purpose = "do a thing"): Operation {
  return {
    oid,
    type: "operation",
    sessionOid: "s",
    intentOid: "i",
    actor: ai,
    target: { entityKind: "file", entityId: path },
    body: { kind: "put_file", path },
    causalDeps: [],
    declaredPurpose: purpose,
    lamport: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as Operation;
}

function evidence(forOps: string[], result: Evidence["result"], detail?: string): Evidence {
  return {
    oid: `ev:${forOps.join(",")}:${result}`,
    type: "evidence",
    forOps,
    kind: "unit_test",
    result,
    command: "npm test",
    detail,
    producedBy: ai,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as Evidence;
}

function decision(chosen: string[], rejected: string[], reason: string, futurePolicy?: string): Decision {
  return {
    oid: `dec:${reason}`,
    type: "decision",
    conflictId: "c1",
    chosenOps: chosen,
    rejectedOps: rejected,
    reason,
    decidedBy: human,
    futurePolicy,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as Decision;
}

test("collects only failing evidence that references the given ops", () => {
  const o1 = op("op:1", "a.ts");
  const o2 = op("op:2", "b.ts");
  const ctx = buildRepairContext(
    [o1],
    [
      evidence(["op:1"], "fail", "boom"),
      evidence(["op:1"], "pass"), // passing → excluded
      evidence(["op:2"], "fail"), // unrelated op → excluded
      evidence(["op:other"], "fail"), // no overlap → excluded
    ],
    [],
  );
  assert.equal(ctx.failures.length, 1);
  assert.equal(ctx.failures[0]!.detail, "boom");
  assert.equal(ctx.failedOps.length, 1);
  assert.equal(ctx.failedOps[0]!.oid, "op:1");
  assert.equal(ctx.failedOps[0]!.target, "file:a.ts");
  assert.equal(ctx.failedOps[0]!.path, "a.ts");
  // also ensure unrelated op never leaks in even if passed evidence about it
  assert.ok(!ctx.failures.some((f) => f.kind === undefined));
  void o2;
});

test("includes decisions touching the ops via either chosen or rejected", () => {
  const o1 = op("op:1", "a.ts");
  const ctx = buildRepairContext(
    [o1],
    [evidence(["op:1"], "fail")],
    [
      decision(["op:1"], [], "keep op:1", "prefer human edits"),
      decision([], ["op:1"], "rejected op:1"),
      decision(["op:zzz"], ["op:yyy"], "unrelated"), // excluded
    ],
  );
  assert.equal(ctx.relatedDecisions.length, 2);
  assert.deepEqual(
    ctx.relatedDecisions.map((d) => d.reason).sort(),
    ["keep op:1", "rejected op:1"],
  );
  assert.equal(ctx.relatedDecisions[0]!.futurePolicy, "prefer human edits");
  // suggestion references the failing kind and the presence of prior decisions
  assert.match(ctx.suggestion, /unit_test/);
  assert.match(ctx.suggestion, /prior decision/);
});

test("truncates long evidence detail to ~1500 chars with a marker", () => {
  const long = "x".repeat(2000);
  const ctx = buildRepairContext([op("op:1", "a.ts")], [evidence(["op:1"], "fail", long)], []);
  const d = ctx.failures[0]!.detail!;
  assert.ok(d.length < long.length, "detail was truncated");
  assert.match(d, /chars\)$/);
  assert.ok(d.startsWith("x".repeat(1500)));
});

test("no failing evidence → empty failures and an explicit suggestion", () => {
  const ctx = buildRepairContext([op("op:1", "a.ts")], [evidence(["op:1"], "pass")], []);
  assert.equal(ctx.failures.length, 0);
  assert.equal(ctx.relatedDecisions.length, 0);
  assert.equal(ctx.suggestion, "No failing evidence found for these ops.");
});
