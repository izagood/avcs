// Differential property harness for incremental reduce (docs/11 Track A, stage A0).
//
// THE invariant: for any `next` that is an append-superset of `base`,
//     reduceIncremental(snapshotReduce(base), next).result  ≡  reduce(next)
// — structurally identical (tree, treeHash, statuses, conflicts, autoDecisions,
// headOps, synthBlobs). If this ever fails, incremental reduce would silently break
// determinism — the project's absolute invariant — so the assertion fails loudly with
// the seed for a minimal repro. Nothing wires reduceIncremental into the repo until
// this is green (A0 is the gate, not a feature).
//
// We build synthetic ReduceInputs directly (full control over the delta) and pick the
// `base` as a RANDOM SUBSET of the full op set — NOT a causal prefix — so that an op in
// base can causally depend on an op that only arrives in the delta (sync delivers ops
// out of causal order). That is the subtle case that extends a pre-existing op's
// ancestry and can change a "clean-looking" group's decision.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce } from "../src/reducer/reducer.ts";
import { reduceIncremental, snapshotReduce } from "../src/reducer/incremental.ts";
import { defaultPolicy } from "../src/reducer/policy.ts";
import type { Actor, Decision, Evidence, Intent, Operation, OperationBody, Policy } from "../src/objects/types.ts";
import type { ReduceInput } from "../src/reducer/reducer.ts";

// ── seeded PRNG (mulberry32) ──────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
class Rng {
  #n: () => number;
  constructor(seed: number) { this.#n = mulberry32(seed); }
  float(): number { return this.#n(); }
  int(max: number): number { return Math.floor(this.#n() * max); }
  pick<T>(a: readonly T[]): T { return a[this.int(a.length)]!; }
  chance(p: number): boolean { return this.#n() < p; }
}

const ACTORS: Actor[] = [
  { kind: "human", id: "human:h" },
  { kind: "ai_agent", id: "ai:a" },
  { kind: "ai_agent", id: "ai:b" },
];
const PATHS = ["a.ts", "b.ts", "c.ts"] as const;
const SYMBOLS = ["alpha", "beta", "gamma"] as const;
const EV_KINDS = ["unit_test", "typecheck", "lint", "api_compat"] as const;
const EV_RESULTS = ["pass", "fail", "partial"] as const;

const symbolSrc = (name: string, v: string) => `export function ${name}() {\n  return "${v}";\n}\n`;
const blobOf = (content: string): string => `blob_${content.length}_${content.replace(/\W/g, "").slice(0, 8)}`;

interface Generated {
  ops: Operation[];
  evidence: Evidence[];
  decisions: Decision[];
  intents: Map<string, Intent>;
  blobContent: Map<string, string>;
  authority: Map<string, number>;
}

/** Generate a random valid op DAG + evidence + decisions over a tiny entity space. */
function generate(rng: Rng, n: number): Generated {
  const ops: Operation[] = [];
  const blobContent = new Map<string, string>();
  const intents = new Map<string, Intent>();
  for (const k of [0, 1]) {
    const oid = `intent_${k}`;
    intents.set(oid, {
      type: "intent", oid, title: `i${k}`, owner: "human:h", kind: "feature",
      constraints: k === 1 ? ["public API 변경 금지"] : [],
      constraintKinds: k === 1 ? ["forbid_public_api_break"] : [],
      createdAt: `2026-01-01T00:00:0${k}.000Z`,
    } as unknown as Intent);
  }

  for (let i = 0; i < n; i++) {
    const oid = `operation_${String(i).padStart(3, "0")}`;
    const actor = rng.pick(ACTORS);
    const intentOid = rng.pick(["intent_0", "intent_1"]);
    // deps drawn only from already-emitted ops (a DAG; any topo order valid).
    const deps: string[] = [];
    for (const prev of ops) if (rng.chance(0.25)) deps.push(prev.oid as string);
    const kind = rng.pick(["put_file", "edit_file", "edit_file", "rename_file", "delete_file", "note"] as const);
    let body: OperationBody;
    let target: Operation["target"];
    if (kind === "put_file") {
      const path = rng.pick(PATHS); const content = `put_${i}`; const blobOid = blobOf(content);
      blobContent.set(blobOid, content); body = { kind, path, blobOid }; target = { entityKind: "file", entityId: path };
    } else if (kind === "edit_file") {
      // MIGRATION: language-neutral whole-file edit (was set_symbol). Distinct content
      // per op keeps the op DAG varied; empty base (baseBlobOid: undefined).
      const path = rng.pick(PATHS); const text = symbolSrc(rng.pick(SYMBOLS), `v${i}`);
      const blobOid = blobOf(text); blobContent.set(blobOid, text);
      body = { kind, path, blobOid, baseBlobOid: undefined }; target = { entityKind: "file", entityId: path };
    } else if (kind === "rename_file") {
      const fromPath: string = rng.pick(PATHS); let path: string = rng.pick(PATHS); if (path === fromPath) path = `${fromPath}.r`;
      body = { kind, fromPath, path }; target = { entityKind: "file", entityId: fromPath };
    } else if (kind === "delete_file") {
      const path = rng.pick(PATHS); body = { kind, path }; target = { entityKind: "file", entityId: path };
    } else {
      body = { kind: "note" }; target = { entityKind: "file", entityId: rng.pick(PATHS) };
    }
    const op: Operation = {
      type: "operation", oid, sessionOid: "session_s", intentOid, actor, target, body,
      causalDeps: deps, declaredPurpose: `op ${i}`, lamport: i,
      createdAt: `2026-02-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      effects: rng.chance(0.2) ? { changesBehavior: true, breaksPublicApi: rng.chance(0.5) } : undefined,
    };
    ops.push(op);
  }

  // Evidence: attach to random op subsets.
  const evidence: Evidence[] = [];
  const evCount = rng.int(Math.max(1, Math.floor(n / 3)));
  for (let e = 0; e < evCount; e++) {
    const forOps = ops.filter(() => rng.chance(0.2)).map((o) => o.oid as string);
    if (!forOps.length) continue;
    evidence.push({
      type: "evidence", oid: `evidence_${e}`, forOps, kind: rng.pick(EV_KINDS), result: rng.pick(EV_RESULTS),
      producedBy: rng.chance(0.5) ? { kind: "ci_bot", id: "ci" } : { kind: "ai_agent", id: "ai:a" },
      createdAt: `2026-03-01T00:00:${String(e % 60).padStart(2, "0")}.000Z`,
    } as Evidence);
  }

  // Decisions: human/agent verdicts over random ops (exercise authority + forced accept/reject).
  const decisions: Decision[] = [];
  const decCount = rng.int(Math.max(1, Math.floor(n / 4)));
  for (let d = 0; d < decCount; d++) {
    const chosen = ops.filter(() => rng.chance(0.12)).map((o) => o.oid as string);
    const rejected = ops.filter(() => rng.chance(0.12)).map((o) => o.oid as string).filter((id) => !chosen.includes(id));
    if (!chosen.length && !rejected.length) continue;
    decisions.push({
      type: "decision", oid: `decision_${d}`, conflictId: `conflict_x${d}`, chosenOps: chosen, rejectedOps: rejected,
      reason: "r", decidedBy: rng.pick(ACTORS), createdAt: `2026-04-01T00:00:${String(d % 60).padStart(2, "0")}.000Z`,
    } as Decision);
  }

  const authority = new Map<string, number>([["human:h", 2], ["ai:a", 1], ["ai:b", 1]]);
  return { ops, evidence, decisions, intents, blobContent, authority };
}

/** A random subset (Bernoulli) — NOT a prefix, so base can dangle into the delta. */
function subset<T>(rng: Rng, arr: T[], p: number): T[] {
  return arr.filter(() => rng.chance(p));
}

function makeReliability(rng: Rng): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of ACTORS) if (rng.chance(0.6)) m.set(a.id, rng.int(3) - 1); // -1,0,1
  return m;
}

// ── structural equality ───────────────────────────────────────────────────────
function norm(r: ReturnType<typeof reduce>): unknown {
  return {
    treeHash: r.treeHash,
    tree: [...r.tree].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    statuses: [...r.statuses].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    conflicts: r.conflicts,
    autoDecisions: r.autoDecisions,
    headOps: [...r.headOps].sort(),
    synthBlobs: [...r.synthBlobs].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  };
}

function buildInput(g: Generated, ops: Operation[], evidence: Evidence[], decisions: Decision[], policy: Policy, reliability: Map<string, number>): ReduceInput {
  return { ops, evidence, decisions, intents: g.intents, policy, blobContent: g.blobContent, reliability, authority: g.authority };
}

test("incremental ≡ full reduce over random DAGs (append-superset, random base subset)", () => {
  const policy = defaultPolicy();
  const SEEDS = 1200;
  let checked = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rng = new Rng(seed);
    const n = 4 + rng.int(26);
    const g = generate(rng, n);
    // base = random subset of every input stream; reliability optionally perturbed.
    const baseOps = subset(rng, g.ops, 0.6);
    const baseEv = subset(rng, g.evidence, 0.6);
    const baseDec = subset(rng, g.decisions, 0.6);
    const fullRel = makeReliability(rng);
    const baseRel = rng.chance(0.5) ? makeReliability(rng) : fullRel; // sometimes differ → reliability-dirty path

    const baseInput = buildInput(g, baseOps, baseEv, baseDec, policy, baseRel);
    const fullInput = buildInput(g, g.ops, g.evidence, g.decisions, policy, fullRel);

    const snap = snapshotReduce(baseInput);
    const inc = reduceIncremental(snap, fullInput).result;
    const full = reduce(fullInput);

    assert.deepEqual(norm(inc), norm(full), `incremental≠full at seed=${seed} (n=${n}, base=${baseOps.length})`);
    checked++;
  }
  assert.ok(checked === SEEDS);
});

test("ancestry extension: a delta op that is a causal ancestor of a pre-existing op", () => {
  const policy = defaultPolicy();
  // Z (key file:a.ts) ← X (key file:b.ts, depends on Y) ← Y (key file:a.ts, depends on Z).
  // base lacks Y, so in base Z and (Y-less) chain look concurrent; adding Y links Z→…→ ops.
  const ai: Actor = { kind: "ai_agent", id: "ai:a" };
  const mk = (oid: string, path: string, deps: string[], lamport: number): Operation => ({
    type: "operation", oid, sessionOid: "s", intentOid: "intent_0", actor: ai,
    target: { entityKind: "file", entityId: path }, body: { kind: "put_file", path, blobOid: blobOf(oid) },
    causalDeps: deps, declaredPurpose: oid, lamport, createdAt: `2026-02-01T00:00:0${lamport}.000Z`,
  });
  const Z = mk("operation_Z", "a.ts", [], 0);
  const Y = mk("operation_Y", "a.ts", ["operation_Z"], 1); // same key as Z, depends on Z
  const X = mk("operation_X", "a.ts", ["operation_Y"], 2); // same key, depends on Y
  const blobContent = new Map([[blobOf("operation_Z"), "z"], [blobOf("operation_Y"), "y"], [blobOf("operation_X"), "x"]]);
  const intents = new Map<string, Intent>([["intent_0", { type: "intent", oid: "intent_0", title: "i", owner: "human:h", kind: "feature", constraints: [], createdAt: "2026-01-01T00:00:00.000Z" } as unknown as Intent]]);
  const mkInput = (ops: Operation[]): ReduceInput => ({ ops, evidence: [], decisions: [], intents, policy, blobContent });

  // base has Z and X but NOT Y → X's dep Y is dangling in base.
  const baseInput = mkInput([Z, X]);
  const fullInput = mkInput([Z, Y, X]);
  const snap = snapshotReduce(baseInput);
  const inc = reduceIncremental(snap, fullInput).result;
  const full = reduce(fullInput);
  assert.deepEqual(norm(inc), norm(full), "ancestry-extension case diverged");
  // X (latest) wins the file: only its content materializes.
  assert.equal(full.statuses.get("operation_X"), "accepted");
  assert.equal(full.statuses.get("operation_Z"), "superseded");
});

test("preconditions: non-append or changed policy/authority → NonIncrementalError", async () => {
  const { NonIncrementalError } = await import("../src/reducer/incremental.ts");
  const policy = defaultPolicy();
  const rng = new Rng(42);
  const g = generate(rng, 8);
  const rel = new Map<string, number>();
  const full = buildInput(g, g.ops, g.evidence, g.decisions, policy, rel);
  const snap = snapshotReduce(full);
  // remove an op from "next" → not an append-superset.
  const shrunk = buildInput(g, g.ops.slice(1), g.evidence, g.decisions, policy, rel);
  assert.throws(() => reduceIncremental(snap, shrunk), NonIncrementalError);
  // change authority.
  const otherAuth = buildInput(g, g.ops, g.evidence, g.decisions, policy, rel);
  otherAuth.authority = new Map([["human:h", 9]]);
  assert.throws(() => reduceIncremental(snap, otherAuth), NonIncrementalError);
});
