// Region arbitration (docs/22) — policy, not order, picks the winner of a contended
// region. The verification matrix R1–R14 of docs/22 §5 lives here.
//
//   node --experimental-strip-types --test test/region-arbitration.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { merge3, type ConflictRegion } from "../src/merge/merge3.ts";

const BASE = "keep\nCONTESTED\ntail\n";
const A = "keep\nA WINS\ntail\n";
const B = "keep\nB WINS\ntail\n";

// ── R8: no arbiter injected ⇒ merge3 behaves exactly as before ────────────────
test("R8: without `arbitrate`, merge3 is byte-identical to the pre-arbitration behaviour", () => {
  const base = merge3(BASE, [A, B]);
  assert.equal(base.clean, false);
  assert.equal(base.merged, BASE, "onConflict defaults to emitting base");
  assert.equal(base.conflicts.length, 1);

  const first = merge3(BASE, [A, B], { onConflict: "first" });
  assert.equal(first.clean, false);
  assert.equal(first.merged, A, "onConflict:first keeps the lowest-side option");
  assert.equal(first.conflicts.length, 1);
});

// ── §3.1: an arbiter's pick becomes the merged text and the region stops being a conflict
test("an arbiter that picks an option resolves the region: its text is emitted, no conflict", () => {
  const seen: ConflictRegion[] = [];
  const m = merge3(BASE, [A, B], {
    onConflict: "first",
    arbitrate: (r) => {
      seen.push(r);
      // pick the option whose only side is 1 (the "later" variant) — the point is that
      // merge3 obeys the caller, not the side order.
      return r.options.findIndex((o) => o.sides.includes(1));
    },
  });
  assert.equal(m.merged, B, "the arbiter's option, not the lowest side, is in the tree");
  assert.deepEqual(m.conflicts, [], "a decided region is not a conflict (docs/22 §3.4)");
  assert.equal(m.clean, true, "…so the merge is clean");
  assert.equal(seen.length, 1, "arbitrate is called once per contended region");
  assert.equal(seen[0]!.baseStart, 1);
  assert.equal(seen[0]!.baseEnd, 2);
  assert.equal(seen[0]!.options.length, 2, "both renderings are offered");
});

test("`null` from the arbiter falls back to onConflict and leaves the region a conflict", () => {
  const m = merge3(BASE, [A, B], { onConflict: "first", arbitrate: () => null });
  assert.equal(m.merged, A, "deterministic fallback content — no data loss");
  assert.equal(m.conflicts.length, 1, "undecided ⇒ still a conflict for a human");
  assert.equal(m.clean, false);

  const b = merge3(BASE, [A, B], { arbitrate: () => null });
  assert.equal(b.merged, BASE, "onConflict:base fallback is unchanged too");
  assert.equal(b.conflicts.length, 1);
});

test("an out-of-range or non-integer pick is treated as undecided, never trusted blindly", () => {
  for (const bad of [2, -1, 1.5, Number.NaN]) {
    const m = merge3(BASE, [A, B], { onConflict: "first", arbitrate: () => bad });
    assert.equal(m.merged, A, `pick ${bad} must fall back`);
    assert.equal(m.conflicts.length, 1, `pick ${bad} must stay a conflict`);
  }
});

// ── R1 (merge3 half): arbitration is only reachable through a ConflictRegion ──
test("R1: with no overlap the arbiter is never called and the merge is unchanged", () => {
  const disjointA = "A\nb\nc\nd\ne\nf\n";
  const disjointB = "a\nb\nc\nd\ne\nF\n";
  const base = "a\nb\nc\nd\ne\nf\n";
  let calls = 0;
  const m = merge3(base, [disjointA, disjointB], {
    onConflict: "first",
    arbitrate: () => {
      calls++;
      return 0;
    },
  });
  assert.equal(calls, 0, "no ConflictRegion ⇒ no arbitration (docs/22 §4.1, R-c)");
  assert.equal(m.merged, "A\nb\nc\nd\ne\nF\n");
  assert.equal(m.clean, true);
});

// ── R14: N=3 — a unique top is adopted; a shared top is not ──────────────────
test("R14: a 3-way region is decided when the arbiter names one option, held when it can't", () => {
  const C = "keep\nC WINS\ntail\n";
  const pick = merge3(BASE, [A, B, C], {
    onConflict: "first",
    arbitrate: (r) => r.options.findIndex((o) => o.sides.includes(2)),
  });
  assert.equal(pick.merged, C);
  assert.deepEqual(pick.conflicts, []);

  const hold = merge3(BASE, [A, B, C], { onConflict: "first", arbitrate: () => null });
  assert.equal(hold.merged, A);
  assert.equal(hold.conflicts.length, 1);
  assert.equal(hold.conflicts[0]!.options.length, 3, "all three renderings stay on the table");
});

// ── R7: agreement collapses into ONE option carrying both sides ──────────────
test("R7: two variants with identical text arrive as a single option listing both sides", () => {
  const regions: ConflictRegion[] = [];
  merge3(BASE, [A, B, B], {
    onConflict: "first",
    arbitrate: (r) => {
      regions.push(r);
      return null;
    },
  });
  assert.equal(regions.length, 1);
  const agreed = regions[0]!.options.find((o) => o.text.includes("B WINS"))!;
  assert.deepEqual(agreed.sides, [1, 2], "the agreeing variants share one option");
});

// ── reduce()-level matrix: the policy engine now decides region CONTENT ───────
//
// These build ReduceInputs directly (full control over trust/evidence/effects) and assert
// the materialized text, which is the thing docs/22 changes. Before this track the winner
// of a contended region was whichever op the canonical (lamport, oid) order applied first.

import { reduce, type ReduceInput } from "../src/reducer/reducer.ts";
import { defaultPolicy } from "../src/reducer/policy.ts";
import { sha256hex } from "../src/core/canonical.ts";
import type { Actor, Evidence, Intent, Operation } from "../src/objects/types.ts";
import { Buffer } from "node:buffer";

const HUMAN: Actor = { kind: "human", id: "human:h" };
const AI_A: Actor = { kind: "ai_agent", id: "ai:a" };
const AI_B: Actor = { kind: "ai_agent", id: "ai:b" };
const AI_C: Actor = { kind: "ai_agent", id: "ai:c" };
const CI: Actor = { kind: "ci_bot", id: "ci:runner" };

const FILE = "hot.ts";
const SCAFFOLD = "keep\nCONTESTED\ntail\n";
const say = (who: string) => `keep\n${who}\ntail\n`;

/** One concurrent edit in a scenario. */
interface Edit {
  actor: Actor;
  text: string;
  /** lamport; also the canonical order (all oids are derived from it). */
  at: number;
  /** attach a trusted passing unit_test (produced by CI, never the author) */
  verified?: boolean;
  effects?: Operation["effects"];
}

interface Built {
  input: ReduceInput;
  /** materialized text at FILE, or undefined when the path is absent */
  text(): string | undefined;
  result: ReturnType<typeof reduce>;
}

/** A scaffold `put_file` plus N concurrent `edit_file`s over it, all sharing one base. */
function scenario(
  edits: Edit[],
  materializeStatuses?: ReduceInput["materializeStatuses"],
  policy = defaultPolicy(),
): Built {
  const blobContent = new Map<string, Buffer>();
  const blob = (content: string): string => {
    const oid = `blob_${sha256hex(content).slice(0, 24)}`;
    blobContent.set(oid, Buffer.from(content, "utf8"));
    return oid;
  };
  const baseBlob = blob(SCAFFOLD);
  const scaffold: Operation = {
    type: "operation", oid: "operation_scaffold", sessionOid: "session_s", intentOid: "intent_0",
    actor: HUMAN, target: { entityKind: "file", entityId: FILE },
    body: { kind: "put_file", path: FILE, blobOid: baseBlob },
    causalDeps: [], declaredPurpose: "scaffold", lamport: 0, createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Operation;
  const ops: Operation[] = [scaffold];
  const evidence: Evidence[] = [];
  for (const e of edits) {
    const oid = `operation_${String(e.at).padStart(3, "0")}`;
    ops.push({
      type: "operation", oid, sessionOid: "session_s", intentOid: "intent_0", actor: e.actor,
      target: { entityKind: "file", entityId: FILE },
      body: { kind: "edit_file", path: FILE, blobOid: blob(e.text), baseBlobOid: baseBlob },
      causalDeps: ["operation_scaffold"], declaredPurpose: `edit by ${e.actor.id}`, lamport: e.at,
      createdAt: `2026-02-01T00:00:${String(e.at).padStart(2, "0")}.000Z`,
      effects: e.effects,
    } as unknown as Operation);
    if (e.verified)
      evidence.push({
        type: "evidence", oid: `evidence_${oid}`, forOps: [oid], kind: "unit_test", result: "pass",
        producedBy: CI, createdAt: "2026-03-01T00:00:00.000Z",
      } as unknown as Evidence);
  }
  const input: ReduceInput = {
    ops, evidence, decisions: [], intents: new Map<string, Intent>(),
    policy, blobContent, materializeStatuses,
  };
  const result = reduce(input);
  return {
    input,
    result,
    text: () => {
      const oid = result.tree.get(FILE);
      if (oid === undefined) return undefined;
      return (result.synthBlobs.get(oid) ?? blobContent.get(oid))?.toString("utf8");
    },
  };
}

// ── R3: trust ladder decides the region, in EITHER authoring order ────────────
test("R3: a human's change takes the contested region from an ai_agent's, either order", () => {
  const humanFirst = scenario([
    { actor: HUMAN, text: say("HUMAN"), at: 1 },
    { actor: AI_A, text: say("AGENT"), at: 2 },
  ]);
  const agentFirst = scenario([
    { actor: AI_A, text: say("AGENT"), at: 1 },
    { actor: HUMAN, text: say("HUMAN"), at: 2 },
  ]);
  assert.equal(humanFirst.text(), say("HUMAN"), "higher trust wins the region");
  assert.equal(
    agentFirst.text(),
    say("HUMAN"),
    "…and still wins when it was written SECOND — order no longer decides (docs/22 §1.1)",
  );
  // Both ops stay accepted: the loser's non-overlapping work must never be dropped.
  for (const b of [humanFirst, agentFirst]) {
    assert.equal(b.result.statuses.get("operation_001"), "accepted");
    assert.equal(b.result.statuses.get("operation_002"), "accepted");
  }
});

// ── R2: evidence decides the region between two equally-trusted actors ───────
test("R2: the verified change takes the region from the unverified one", () => {
  const verifiedLast = scenario([
    { actor: AI_A, text: say("UNVERIFIED"), at: 1 },
    { actor: AI_B, text: say("VERIFIED"), at: 2, verified: true },
  ]);
  const verifiedFirst = scenario([
    { actor: AI_A, text: say("VERIFIED"), at: 1, verified: true },
    { actor: AI_B, text: say("UNVERIFIED"), at: 2 },
  ]);
  assert.equal(verifiedLast.text(), say("VERIFIED"), "a passing test outranks nothing at all");
  assert.equal(verifiedFirst.text(), say("VERIFIED"), "…in either order");
});

// ── R5: a score tie goes to a human — never broken by recency ────────────────
test("R5: tied scores leave the region undecided; the tree keeps the deterministic fallback", () => {
  const a = scenario([
    { actor: AI_A, text: say("A"), at: 1 },
    { actor: AI_B, text: say("B"), at: 2 },
  ]);
  const b = scenario([
    { actor: AI_B, text: say("B"), at: 1 },
    { actor: AI_A, text: say("A"), at: 2 },
  ]);
  // Provisional content + an open conflict (docs/22 Q1): the incumbent stays, and the
  // region is reported (asserted through the authoritative pass in the repo-level cases).
  assert.equal(a.text(), say("A"), "no policy winner ⇒ the onConflict fallback content");
  assert.equal(b.text(), say("B"), "…which is the canonical-first option, as before");
});

// ── R6: an op that failed its evidence gate cannot take the region ───────────
test("R6: an unverified behaviour change is excluded — its content never reaches the tree", () => {
  const b = scenario([
    { actor: AI_A, text: say("VERIFIED"), at: 1, verified: true, effects: { changesBehavior: true } },
    { actor: AI_B, text: say("UNVERIFIED"), at: 2, effects: { changesBehavior: true } },
  ]);
  assert.equal(b.result.statuses.get("operation_002"), "rejected", "the gate rejects it upstream");
  assert.equal(b.text(), say("VERIFIED"), "and the verified change owns the region");
});

test("R6b: when EVERY option requires a human, arbitration abstains and the fallback stands", () => {
  // breaksPublicApi ⇒ require_human for both ops. Projecting needs_decision puts both in
  // the tree merge anyway, which is exactly the case the arbiter must refuse to decide.
  const b = scenario(
    [
      { actor: HUMAN, text: say("HUMAN"), at: 1, effects: { breaksPublicApi: true } },
      { actor: AI_A, text: say("AGENT"), at: 2, effects: { breaksPublicApi: true } },
    ],
    ["accepted", "needs_decision"],
  );
  assert.equal(b.result.statuses.get("operation_001"), "needs_decision");
  assert.equal(b.result.statuses.get("operation_002"), "needs_decision");
  assert.equal(b.text(), say("HUMAN"), "the fallback incumbent, NOT a policy pick");
});

// ── R14: three-way region ────────────────────────────────────────────────────
test("R14: a 3-way region goes to the unique top score, and is held when the top is shared", () => {
  const unique = scenario([
    { actor: AI_A, text: say("A"), at: 1 },
    { actor: AI_B, text: say("B"), at: 2, verified: true },
    { actor: AI_C, text: say("C"), at: 3 },
  ]);
  assert.equal(unique.text(), say("B"), "the only verified option takes it");

  const shared = scenario([
    { actor: AI_A, text: say("A"), at: 1 },
    { actor: AI_B, text: say("B"), at: 2, verified: true },
    { actor: AI_C, text: say("C"), at: 3, verified: true },
  ]);
  // Two verified options share the top ⇒ undecided ⇒ the deterministic fallback, which is
  // whatever the accumulated content already held. `applyOp` composes pairwise, so by the
  // time C arrives B has already taken the region from A on merit; the tie between B and C
  // leaves B in place. The region still reaches a human (asserted through the authoritative
  // pass below) — this is "provisional content + an open conflict", not a silent decision.
  assert.equal(shared.text(), say("B"), "shared top ⇒ the incumbent stands, and it is a top option");
});

// ── R7 (reduce level): agreement is represented by its strongest backer ──────
test("R7: an option two ops agree on is represented by the highest-scoring of them", () => {
  // A(unverified) vs B+C who wrote the SAME text; C is verified. The agreement option must
  // compete with C's score, not with B's — an averaged option could be diluted by B.
  const b = scenario([
    { actor: AI_A, text: say("A"), at: 1 },
    { actor: AI_B, text: say("AGREED"), at: 2 },
    { actor: AI_C, text: say("AGREED"), at: 3, verified: true },
  ]);
  assert.equal(b.text(), say("AGREED"));
});

// ── R1: an op set with NO overlapping region is byte-identically unaffected ──
test("R1: disjoint concurrent edits produce the same tree as before arbitration existed", () => {
  const long = "l1\nl2\nl3\nl4\nl5\nl6\nl7\n";
  const blobContent = new Map<string, Buffer>();
  const blob = (content: string): string => {
    const oid = `blob_${sha256hex(content).slice(0, 24)}`;
    blobContent.set(oid, Buffer.from(content, "utf8"));
    return oid;
  };
  const baseBlob = blob(long);
  const mk = (oid: string, actor: Actor, text: string, lamport: number): Operation =>
    ({
      type: "operation", oid, sessionOid: "session_s", intentOid: "intent_0", actor,
      target: { entityKind: "file", entityId: FILE },
      body: { kind: "edit_file", path: FILE, blobOid: blob(text), baseBlobOid: baseBlob },
      causalDeps: ["operation_scaffold"], declaredPurpose: oid, lamport,
      createdAt: `2026-02-01T00:00:0${lamport}.000Z`,
    }) as unknown as Operation;
  const ops: Operation[] = [
    {
      type: "operation", oid: "operation_scaffold", sessionOid: "session_s", intentOid: "intent_0",
      actor: HUMAN, target: { entityKind: "file", entityId: FILE },
      body: { kind: "put_file", path: FILE, blobOid: baseBlob },
      causalDeps: [], declaredPurpose: "scaffold", lamport: 0, createdAt: "2026-01-01T00:00:00.000Z",
    } as unknown as Operation,
    // A rewrites line 1, B rewrites line 7 — different clusters, so no ConflictRegion and
    // no arbitration. A human vs an ai_agent, i.e. scores that WOULD differ if it ran.
    mk("operation_001", HUMAN, long.replace("l1", "L1"), 1),
    mk("operation_002", AI_A, long.replace("l7", "L7"), 2),
  ];
  const r = reduce({
    ops, evidence: [], decisions: [], intents: new Map<string, Intent>(),
    policy: defaultPolicy(), blobContent,
  });
  const text = r.synthBlobs.get(r.tree.get(FILE)!)!.toString("utf8");
  assert.equal(text, "L1\nl2\nl3\nl4\nl5\nl6\nL7\n", "both disjoint edits still compose");
  assert.equal(r.conflicts.length, 0);
  // Golden treeHash captured from the pre-arbitration reducer (docs/22 §4.1 / R1): an op
  // set without an overlapping region must materialize byte-identically across the
  // MERGE3_VERSION bump. If this changes, arbitration leaked outside its scope.
  assert.equal(r.treeHash, "aa5f5c936fa9fbfd62ccf2d3ec02b677b1675d739059bfbdc14191ffcf5179f7");
});

// ── the authoritative pass: a decided region leaves the conflict set (docs/22 §3.4) ──
//
// Driven through the real Repo pipeline, where `detectFileConflicts` runs the N-way merge
// over the file's concurrent frontier and its regions are arbitrated with the same rule.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";

interface Live {
  dir: string;
  repo: Repo;
  intent: string;
  sess: string;
}
async function liveRepo(): Promise<Live> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-region-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "region", owner: HUMAN.id });
  const sess = await repo.startSession({ intentOid: intent, actor: HUMAN });
  return { dir, repo, intent, sess };
}

/** Scaffold FILE, then author N concurrent overlapping edits; `verified` ops get a CI test. */
async function liveScenario(edits: { actor: Actor; text: string; verified?: boolean }[]) {
  const l = await liveRepo();
  const base = { sessionOid: l.sess, intentOid: l.intent };
  const scaffold = await l.repo.proposeFileWrite({
    ...base, actor: HUMAN, path: FILE, content: SCAFFOLD, declaredPurpose: "scaffold",
  });
  const oids: string[] = [];
  for (const e of edits) {
    const oid = await l.repo.proposeEdit({
      ...base, actor: e.actor, path: FILE, baseText: SCAFFOLD, newText: e.text,
      declaredPurpose: `edit by ${e.actor.id}`, causalDeps: [scaffold],
    });
    oids.push(oid);
    if (e.verified)
      await l.repo.attachEvidence({ forOps: [oid], kind: "unit_test", result: "pass", producedBy: CI });
  }
  const res = await l.repo.materialize();
  const text = (await l.repo.materializedFiles(res)).find((f) => f.path === FILE)?.content;
  return { ...l, oids, res, text };
}

test("R2/R13/R1(§3.4): a decided region drops out of the conflict set and is recorded", async () => {
  const s = await liveScenario([
    { actor: AI_A, text: say("UNVERIFIED") },
    { actor: AI_B, text: say("VERIFIED"), verified: true },
  ]);
  try {
    assert.equal(s.text, say("VERIFIED"), "the verified change owns the region");
    assert.equal(s.res.fileConflicts.length, 0, "policy decided it, so it is not a conflict any more");
    assert.equal(
      s.res.conflicts.filter((c) => c.key === `file:${FILE}`).length,
      0,
      "…and the release gate is not blocked on a decision that was made",
    );
    // R13: the decision is auditable — who won, who lost, and on what score.
    const region = s.res.autoDecisions.filter((d) => d.reason === "region-arbitration");
    assert.equal(region.length, 1, "exactly one region was arbitrated");
    const d = region[0]!;
    assert.equal(d.key, `file:${FILE}`);
    assert.equal(d.chosenOp, s.oids[1], "the verified op is recorded as the winner");
    assert.deepEqual(d.rejectedOps, [s.oids[0]], "and the unverified op as the loser");
    assert.deepEqual(d.region, { baseStart: 1, baseEnd: 2 }, "the contested base line range");
    assert.equal(d.optionScores?.length, 2, "per-option score breakdown");
    const chosen = d.optionScores!.find((o) => o.opOid === s.oids[1])!;
    const lost = d.optionScores!.find((o) => o.opOid === s.oids[0])!;
    assert.ok(chosen.score > lost.score, `winning score must be higher (${chosen.score} vs ${lost.score})`);
    assert.equal(chosen.excluded, false);
    assert.ok(d.policyVersion.length > 0);
  } finally {
    await rm(s.dir, { recursive: true, force: true });
  }
});

test("R5 (§3.4): an undecidable region stays a conflict and mints no decision", async () => {
  const s = await liveScenario([
    { actor: AI_A, text: say("A") },
    { actor: AI_B, text: say("B") },
  ]);
  try {
    assert.equal(s.res.fileConflicts.length, 1, "a tie must still reach a human");
    assert.equal(s.res.fileConflicts[0]!.regions.length, 1);
    assert.ok(s.res.conflicts.some((c) => c.key === `file:${FILE}`), "and the gate still blocks");
    assert.deepEqual(
      s.res.autoDecisions.filter((d) => d.reason === "region-arbitration"),
      [],
      "no decision is recorded for something policy did not decide",
    );
    assert.ok(s.text === say("A") || s.text === say("B"), "provisional content, never a blend");
  } finally {
    await rm(s.dir, { recursive: true, force: true });
  }
});

test("R14 (§3.4): a 3-way region with a shared top stays open; a unique top is decided", async () => {
  const shared = await liveScenario([
    { actor: AI_A, text: say("A") },
    { actor: AI_B, text: say("B"), verified: true },
    { actor: AI_C, text: say("C"), verified: true },
  ]);
  try {
    assert.equal(shared.res.fileConflicts.length, 1, "two verified options tie ⇒ a human decides");
    assert.equal(shared.res.fileConflicts[0]!.regions[0]!.options.length, 3);
  } finally {
    await rm(shared.dir, { recursive: true, force: true });
  }
  const unique = await liveScenario([
    { actor: AI_A, text: say("A") },
    { actor: AI_B, text: say("B"), verified: true },
    { actor: AI_C, text: say("C") },
  ]);
  try {
    assert.equal(unique.text, say("B"), "the single verified option takes the region");
    assert.equal(unique.res.fileConflicts.length, 0);
    assert.equal(unique.res.autoDecisions.filter((d) => d.reason === "region-arbitration").length, 1);
    const d = unique.res.autoDecisions.find((x) => x.reason === "region-arbitration")!;
    assert.equal(d.chosenOp, unique.oids[1]);
    assert.equal(d.rejectedOps.length, 2, "both losing options are named");
  } finally {
    await rm(unique.dir, { recursive: true, force: true });
  }
});

test("R3 (§3.4): the trust ladder decides a region end-to-end, and the tree agrees with the record", async () => {
  const s = await liveScenario([
    { actor: AI_A, text: say("AGENT") },
    { actor: HUMAN, text: say("HUMAN") },
  ]);
  try {
    assert.equal(s.text, say("HUMAN"));
    assert.equal(s.res.fileConflicts.length, 0);
    const d = s.res.autoDecisions.find((x) => x.reason === "region-arbitration")!;
    assert.equal(d.chosenOp, s.oids[1], "the record names the op whose text is in the tree");
  } finally {
    await rm(s.dir, { recursive: true, force: true });
  }
});

test("R-d: re-materializing the same op set does not mint a second decision for the region", async () => {
  const s = await liveScenario([
    { actor: AI_A, text: say("UNVERIFIED") },
    { actor: AI_B, text: say("VERIFIED"), verified: true },
  ]);
  try {
    const again = await s.repo.materialize();
    const first = s.res.autoDecisions.filter((d) => d.reason === "region-arbitration");
    const second = again.autoDecisions.filter((d) => d.reason === "region-arbitration");
    assert.equal(second.length, 1, "one region ⇒ one decision, however often it is reduced");
    assert.deepEqual(second, first, "and it is the identical record (idempotent key)");
  } finally {
    await rm(s.dir, { recursive: true, force: true });
  }
});

// ── R9/R10/R11: determinism and warm/cold agreement ──────────────────────────

import { reduceIncremental, snapshotReduce } from "../src/reducer/incremental.ts";

/** The same op set as `scenario`, but as raw parts so a test can vary evidence/reliability. */
function parts(edits: Edit[]): { input: ReduceInput; blobContent: Map<string, Buffer> } {
  const b = scenario(edits);
  return { input: b.input, blobContent: b.input.blobContent! };
}
const textOf = (r: ReturnType<typeof reduce>, blobContent: Map<string, Buffer>): string | undefined => {
  const oid = r.tree.get(FILE);
  return oid === undefined ? undefined : (r.synthBlobs.get(oid) ?? blobContent.get(oid))?.toString("utf8");
};

test("R9: shuffling the input order — and swapping who wrote first — leaves the tree identical", () => {
  const mk = (humanAt: number, aiAt: number, shuffle: boolean): ReturnType<typeof reduce> => {
    const { input } = parts([
      { actor: HUMAN, text: say("HUMAN"), at: humanAt },
      { actor: AI_A, text: say("AGENT"), at: aiAt },
    ]);
    const ops = shuffle ? [...input.ops].reverse() : input.ops;
    return reduce({ ...input, ops });
  };
  const hashes = new Set([
    mk(1, 2, false).treeHash,
    mk(1, 2, true).treeHash,
    mk(2, 1, false).treeHash,
    mk(2, 1, true).treeHash,
  ]);
  assert.equal(hashes.size, 1, "one treeHash for every ordering — policy decided, not order");
});

test("R11: a region whose SCORE inputs changed is re-decided on the incremental path too", () => {
  // The op set is identical in base and next; only the evidence differs. Nothing about the
  // projection changed, so without a score-driven dirty path the warm path would keep the
  // region it decided under the OLD evidence while a full reduce re-decides it.
  const withEv = parts([
    { actor: AI_A, text: say("A"), at: 1 },
    { actor: AI_B, text: say("B"), at: 2, verified: true },
  ]);
  const noEv = parts([
    { actor: AI_A, text: say("A"), at: 1 },
    { actor: AI_B, text: say("B"), at: 2 },
  ]);
  const baseInput: ReduceInput = { ...noEv.input };
  const nextInput: ReduceInput = { ...baseInput, evidence: withEv.input.evidence };

  const snap = snapshotReduce(baseInput);
  assert.equal(textOf(snap.result, noEv.blobContent), say("A"), "tie before the evidence lands");

  const inc = reduceIncremental(snap, nextInput).result;
  const full = reduce(nextInput);
  assert.equal(textOf(full, noEv.blobContent), say("B"), "the evidence decides the region");
  assert.equal(inc.treeHash, full.treeHash, "incremental ≡ full after an evidence-only delta");
  assert.deepEqual([...inc.tree], [...full.tree]);
});

test("R11b: a reliability shift alone also re-decides the region incrementally", () => {
  const { input, blobContent } = parts([
    { actor: AI_A, text: say("A"), at: 1 },
    { actor: AI_B, text: say("B"), at: 2 },
  ]);
  const baseInput: ReduceInput = { ...input, reliability: new Map<string, number>() };
  const nextInput: ReduceInput = { ...input, reliability: new Map([[AI_B.id, 1]]) };
  const snap = snapshotReduce(baseInput);
  const inc = reduceIncremental(snap, nextInput).result;
  const full = reduce(nextInput);
  assert.equal(textOf(full, blobContent), say("B"), "the learned-trust nudge breaks the tie");
  assert.equal(inc.treeHash, full.treeHash, "incremental ≡ full after a reliability-only delta");
});

test("R12: a policy change that flips a region's winner survives a cold load of a compacted base", async () => {
  const l = await liveRepo();
  try {
    const base = { sessionOid: l.sess, intentOid: l.intent };
    const scaffold = await l.repo.proposeFileWrite({
      ...base, actor: HUMAN, path: FILE, content: SCAFFOLD, declaredPurpose: "scaffold",
    });
    await l.repo.proposeEdit({
      ...base, actor: AI_A, path: FILE, baseText: SCAFFOLD, newText: say("AGENT"),
      declaredPurpose: "agent", causalDeps: [scaffold],
    });
    await l.repo.proposeEdit({
      ...base, actor: HUMAN, path: FILE, baseText: SCAFFOLD, newText: say("HUMAN"),
      declaredPurpose: "human", causalDeps: [scaffold],
    });
    const before = await l.repo.materialize();
    assert.equal(
      (await l.repo.materializedFiles(before)).find((f) => f.path === FILE)?.content,
      say("HUMAN"),
      "the default policy's ladder puts the human on top",
    );
    await l.repo.compact("main");

    // Invert the ladder and drop the prefer-human rule: the SAME ops must now yield the
    // agent's region content. The persisted base was computed under the old policy, so the
    // cold load must reject it (its header stamps the policy oid) rather than serve a tree
    // the current policy would never produce.
    const policy = await l.repo.policy();
    await l.repo.setPolicy({
      ...policy,
      version: `${policy.version}+inverted`,
      actorTrust: ["human", "ci_bot", "ai_agent"],
      rules: policy.rules.filter((r) => r.name !== "human_wins_conflicts"),
      createdAt: new Date().toISOString(),
    });

    const cold = await Repo.open(l.dir);
    const after = await cold.materialize();
    assert.equal(
      (await cold.materializedFiles(after)).find((f) => f.path === FILE)?.content,
      say("AGENT"),
      "the inverted ladder gives the region to the agent",
    );
    assert.equal(cold.metrics.snapshot().counters["snapshot.cold.rejected"], 1, "stale base rejected");
  } finally {
    await rm(l.dir, { recursive: true, force: true });
  }
});

// ── R4: code ownership — what the current policy engine can and cannot express ──
//
// docs/22 R4 expects "the code-owner's side takes the region". Against the code as it
// stands that is only half expressible: `ownersFor`/`Conflict.requiredOwners` ROUTE a
// conflict to its owners but contribute nothing to `evaluateOp`'s score, so ownership alone
// cannot win a region. What a policy CAN declare is `prefer_actor`, and that does decide it.
// Both halves are pinned here so the gap is a recorded fact rather than a surprise.
test("R4: an owner rule alone does not decide a region; a declared prefer_actor does", () => {
  const owned = scenario(
    [
      { actor: AI_A, text: say("A"), at: 1 },
      { actor: AI_B, text: say("B"), at: 2 },
    ],
    undefined,
    { ...defaultPolicy(), owners: [{ scope: `file:${FILE}`, owners: [AI_B.id] }] },
  );
  assert.equal(
    owned.text(),
    say("A"),
    "ownership routes the decision, it does not score it — so the region stays undecided",
  );

  const preferred = scenario(
    [
      { actor: AI_A, text: say("A"), at: 1 },
      { actor: CI, text: say("CI"), at: 2 },
    ],
    undefined,
    {
      ...defaultPolicy(),
      rules: [
        ...defaultPolicy().rules,
        { name: "prefer_the_runner", when: { onConflict: true }, effect: { type: "prefer_actor", kind: "ci_bot" } },
      ],
    },
  );
  assert.equal(preferred.text(), say("CI"), "a policy-declared actor preference takes the region");
});

test("R10: two replicas that partition the authoring converge on the policy's region winner", async () => {
  const a = await liveRepo();
  const bDir = await mkdtemp(join(tmpdir(), "avcs-region-b-"));
  try {
    // A establishes the file, B clones that state, then each authors ONE concurrent edit.
    const scaffold = await a.repo.proposeFileWrite({
      sessionOid: a.sess, intentOid: a.intent, actor: HUMAN, path: FILE, content: SCAFFOLD,
      declaredPurpose: "scaffold",
    });
    const b = await Repo.init(bDir);
    await b.pull(a.dir);
    const bIntent = await b.createIntent({ title: "region-b", owner: AI_B.id });
    const bSess = await b.startSession({ intentOid: bIntent, actor: AI_B });

    await a.repo.proposeEdit({
      sessionOid: a.sess, intentOid: a.intent, actor: AI_A, path: FILE, baseText: SCAFFOLD,
      newText: say("UNVERIFIED"), declaredPurpose: "A", causalDeps: [scaffold],
    });
    const bOp = await b.proposeEdit({
      sessionOid: bSess, intentOid: bIntent, actor: AI_B, path: FILE, baseText: SCAFFOLD,
      newText: say("VERIFIED"), declaredPurpose: "B", causalDeps: [scaffold],
    });
    await b.attachEvidence({ forOps: [bOp], kind: "unit_test", result: "pass", producedBy: CI });

    // Cross-pull: both replicas now hold the identical object set.
    await a.repo.pull(bDir);
    await b.pull(a.dir);

    const ra = await a.repo.materialize();
    const rb = await b.materialize();
    assert.equal(rb.treeHash, ra.treeHash, "identical object sets ⇒ identical treeHash");
    const ca = (await a.repo.materializedFiles(ra)).find((f) => f.path === FILE)?.content;
    const cb = (await b.materializedFiles(rb)).find((f) => f.path === FILE)?.content;
    assert.equal(ca, say("VERIFIED"), "the verified change owns the region on replica A");
    assert.equal(cb, say("VERIFIED"), "…and on replica B, which authored the loser's rival");
    assert.equal(ra.fileConflicts.length, 0, "and neither replica reports it as open");
    assert.equal(rb.fileConflicts.length, 0);
  } finally {
    await rm(a.dir, { recursive: true, force: true });
    await rm(bDir, { recursive: true, force: true });
  }
});
