// C22 (docs/19 §5, §6 R2) — incremental reduce must agree with a full reduce once
// renames are in play.
//
// The alias map is a function of the WHOLE op set, not of the delta: a rename arriving
// now changes where PRE-EXISTING content ops write. If the dirty set does not cover both
// ends of that move, a warm replica and a cold one materialize DIFFERENT trees from the
// same objects — the one failure this project cannot have. `incremental-equivalence`
// covers the random case; these are the targeted ones.
//
//   node --experimental-strip-types --test test/rename-incremental.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { reduce, type ReduceInput } from "../src/reducer/reducer.ts";
import { reduceIncremental, snapshotReduce } from "../src/reducer/incremental.ts";
import { defaultPolicy } from "../src/reducer/policy.ts";
import { Repo } from "../src/api/repo.ts";
import type { Actor, Operation, OperationBody } from "../src/objects/types.ts";

const A: Actor = { kind: "ai_agent", id: "ai:a" };
const B: Actor = { kind: "ai_agent", id: "ai:b" };

const BASE = "alpha\nbeta\ngamma\ndelta\n";
const EDITED = "alpha\nbeta CHANGED\ngamma\ndelta\n";

// ── direct reduce/reduceIncremental control (no repo, exact control over the delta) ──

const blobContent = new Map<string, Buffer>();
function blob(content: string): string {
  const oid = `blob_${Buffer.byteLength(content)}_${content.replace(/\W/g, "").slice(0, 10)}`;
  blobContent.set(oid, Buffer.from(content, "utf8"));
  return oid;
}

function op(a: { oid: string; lamport: number; body: OperationBody; deps?: string[]; actor?: Actor }): Operation {
  const path = a.body.fromPath ?? a.body.path ?? "";
  return {
    type: "operation",
    oid: a.oid,
    sessionOid: "session_s",
    intentOid: "intent_i",
    actor: a.actor ?? A,
    target: { entityKind: "file", entityId: path },
    body: a.body,
    causalDeps: a.deps ?? [],
    declaredPurpose: a.oid,
    lamport: a.lamport,
    createdAt: `2026-01-01T00:00:${String(a.lamport).padStart(2, "0")}.000Z`,
  } as unknown as Operation;
}

// ONE policy object for both sides. `defaultPolicy()` stamps a fresh `createdAt`, so two
// calls that straddle a millisecond read as "policy changed" and `reduceIncremental` would
// refuse the fast path — which is exactly the path under test here.
const POLICY = defaultPolicy();

function input(ops: Operation[]): ReduceInput {
  return { ops, evidence: [], decisions: [], intents: new Map(), policy: POLICY, blobContent };
}

/** `reduceIncremental(snapshotReduce(base), next)` must equal `reduce(next)` exactly. */
function assertEquivalent(label: string, baseOps: Operation[], nextOps: Operation[]): Map<string, string> {
  const warm = reduceIncremental(snapshotReduce(input(baseOps)), input(nextOps)).result;
  const cold = reduce(input(nextOps));
  assert.equal(warm.treeHash, cold.treeHash, `${label}: warm and cold treeHash must match`);
  assert.deepEqual([...warm.tree].sort(), [...cold.tree].sort(), `${label}: same tree`);
  assert.deepEqual([...warm.statuses].sort(), [...cold.statuses].sort(), `${label}: same statuses`);
  assert.deepEqual([...warm.headOps].sort(), [...cold.headOps].sort(), `${label}: same headOps`);
  assert.equal(warm.conflicts.length, cold.conflicts.length, `${label}: same conflict count`);
  return cold.tree;
}

const bBase = blob(BASE);
const bEdited = blob(EDITED);

test("C22: a rename arriving into a warm state re-routes the edits already there", () => {
  const s = op({ oid: "op_1_scaffold", lamport: 1, body: { kind: "put_file", path: "P.ts", blobOid: bBase } });
  const e = op({ oid: "op_2_edit", lamport: 2, actor: B, body: { kind: "edit_file", path: "P.ts", blobOid: bEdited, baseBlobOid: bBase }, deps: ["op_1_scaffold"] });
  const r = op({ oid: "op_3_rename", lamport: 3, body: { kind: "rename_file", fromPath: "P.ts", path: "Q.ts" }, deps: ["op_1_scaffold"] });
  const tree = assertEquivalent("rename arrives last", [s, e], [s, e, r]);
  assert.deepEqual([...tree.keys()], ["Q.ts"], "the warm tree must not keep the vacated path");
});

test("C22: an edit arriving into a warm state that already has the rename", () => {
  const s = op({ oid: "op_1_scaffold", lamport: 1, body: { kind: "put_file", path: "P.ts", blobOid: bBase } });
  const r = op({ oid: "op_2_rename", lamport: 2, body: { kind: "rename_file", fromPath: "P.ts", path: "Q.ts" }, deps: ["op_1_scaffold"] });
  const e = op({ oid: "op_3_edit", lamport: 3, actor: B, body: { kind: "edit_file", path: "P.ts", blobOid: bEdited, baseBlobOid: bBase }, deps: ["op_1_scaffold"] });
  const tree = assertEquivalent("edit arrives last", [s, r], [s, r, e]);
  assert.deepEqual([...tree.keys()], ["Q.ts"]);
});

test("C22: a SECOND rename extending the chain into a warm state", () => {
  const s = op({ oid: "op_1_scaffold", lamport: 1, body: { kind: "put_file", path: "P.ts", blobOid: bBase } });
  const e = op({ oid: "op_2_edit", lamport: 2, actor: B, body: { kind: "edit_file", path: "P.ts", blobOid: bEdited, baseBlobOid: bBase }, deps: ["op_1_scaffold"] });
  const r1 = op({ oid: "op_3_rename", lamport: 3, body: { kind: "rename_file", fromPath: "P.ts", path: "Q.ts" }, deps: ["op_1_scaffold"] });
  const r2 = op({ oid: "op_4_rename", lamport: 4, body: { kind: "rename_file", fromPath: "Q.ts", path: "R.ts" }, deps: ["op_3_rename"] });
  const tree = assertEquivalent("chain extended", [s, e, r1], [s, e, r1, r2]);
  assert.deepEqual([...tree.keys()], ["R.ts"], "the chain closure must reach R on the warm path too");
});

test("C22: a rename arriving out of causal order (its own ancestor is already warm)", () => {
  // Sync delivers ops out of causal order: the base holds an op that depends on one only
  // the delta brings. Here the delta's rename is an ancestor of an op already in base.
  const s = op({ oid: "op_1_scaffold", lamport: 1, body: { kind: "put_file", path: "P.ts", blobOid: bBase } });
  const r = op({ oid: "op_2_rename", lamport: 2, body: { kind: "rename_file", fromPath: "P.ts", path: "Q.ts" }, deps: ["op_1_scaffold"] });
  const later = op({ oid: "op_3_put", lamport: 3, body: { kind: "put_file", path: "P.ts", blobOid: blob("a brand new P\n") }, deps: ["op_2_rename"] });
  const tree = assertEquivalent("rename backfilled", [s, later], [s, r, later]);
  assert.deepEqual([...tree.keys()].sort(), ["P.ts", "Q.ts"]);
});

test("C22: a re-move of the same source into a warm state vacates the FIRST destination", () => {
  // The case that isolates the invariant this whole file exists for: the base tree holds
  // the file at Q, and the arriving op makes Q wrong WITHOUT naming Q anywhere. Only the
  // rule that dirties both ends of every projected rename can know that Q's cached entry
  // must be thrown away — nothing in the delta mentions it.
  const s = op({ oid: "op_1_scaffold", lamport: 1, body: { kind: "put_file", path: "P.ts", blobOid: bBase } });
  const e = op({ oid: "op_2_edit", lamport: 2, actor: B, body: { kind: "edit_file", path: "P.ts", blobOid: bEdited, baseBlobOid: bBase }, deps: ["op_1_scaffold"] });
  const r1 = op({ oid: "op_3_rename", lamport: 3, body: { kind: "rename_file", fromPath: "P.ts", path: "Q.ts" }, deps: ["op_1_scaffold"] });
  const r2 = op({ oid: "op_4_rename", lamport: 4, body: { kind: "rename_file", fromPath: "P.ts", path: "Z.ts" }, deps: ["op_3_rename"] });
  const warmBase = reduce(input([s, e, r1]));
  assert.deepEqual([...warmBase.tree.keys()], ["Q.ts"], "the base this starts from really does hold Q");
  const tree = assertEquivalent("source re-moved", [s, e, r1], [s, e, r1, r2]);
  assert.deepEqual([...tree.keys()], ["Z.ts"], "the last hop wins and Q must not linger");
});

test("C22: a contested rename pair arriving into a warm state", () => {
  const s = op({ oid: "op_1_scaffold", lamport: 1, body: { kind: "put_file", path: "P.ts", blobOid: bBase } });
  const r1 = op({ oid: "op_2_rename", lamport: 2, body: { kind: "rename_file", fromPath: "P.ts", path: "Q.ts" }, deps: ["op_1_scaffold"] });
  const r2 = op({ oid: "op_3_rename", lamport: 3, actor: B, body: { kind: "rename_file", fromPath: "P.ts", path: "R.ts" }, deps: ["op_1_scaffold"] });
  assertEquivalent("contest arrives", [s, r1], [s, r1, r2]);
});

// ── the real Repo path: warm (materialize after every op) vs cold (materialize once) ──

async function c9(mode: "warm" | "cold"): Promise<{ treeHash: string; files: Map<string, string>; conflicts: number }> {
  const dir = await mkdtemp(join(tmpdir(), `avcs-rename-inc-${mode}-`));
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "c22", owner: A.id });
    const sess = await repo.startSession({ intentOid: intent, actor: A });
    const tick = async () => {
      // A warm run materializes between authoring steps, which is what populates the
      // incremental snapshot the next materialize re-reduces from.
      if (mode === "warm") await repo.materialize();
    };
    const scaffold = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: A, path: "app/P.ts", content: BASE, declaredPurpose: "scaffold" });
    await tick();
    await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: B, path: "app/P.ts", baseText: BASE, newText: EDITED, declaredPurpose: "edit P", causalDeps: [scaffold] });
    await tick();
    await repo.proposeOperation({
      sessionOid: sess, intentOid: intent, actor: A,
      target: { entityKind: "file", entityId: "app/P.ts" },
      body: { kind: "rename_file", fromPath: "app/P.ts", path: "app/x/P.ts" },
      declaredPurpose: "move", causalDeps: [scaffold],
    });
    await tick();
    const res = await repo.materialize();
    return {
      treeHash: res.treeHash,
      files: new Map((await repo.materializedFiles(res)).map((f) => [f.path, f.content])),
      conflicts: res.conflicts.length,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("C22: the repo's warm incremental path materializes the same tree as a cold one", async () => {
  const warm = await c9("warm");
  const cold = await c9("cold");
  assert.equal(warm.conflicts, 0);
  assert.equal(cold.conflicts, 0);
  assert.equal(warm.files.get("app/x/P.ts"), EDITED);
  assert.deepEqual([...warm.files.keys()], ["app/x/P.ts"]);
  assert.equal(warm.treeHash, cold.treeHash, "warm and cold replicas must agree byte for byte");
});
