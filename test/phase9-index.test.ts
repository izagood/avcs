// Phase 9: entity index + materializeAt (time-travel). These are the primitives
// Phase 10 (blame/history/bisect/diff) builds on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const greet = (v: string) => `export function greet() {\n  return "${v}";\n}`;

async function repoWithHistory() {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  const base = await repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", content: greet("v0") + "\n", declaredPurpose: "scaffold",
  });
  const op1 = await repo.proposeSymbolEdit({
    sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", symbolName: "greet",
    newText: greet("v1"), declaredPurpose: "to v1", causalDeps: [base],
  });
  const op2 = await repo.proposeSymbolEdit({
    sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", symbolName: "greet",
    newText: greet("v2"), declaredPurpose: "to v2", causalDeps: [op1],
  });
  return { dir, repo, base, op1, op2 };
}

test("entity index: historyOf returns ops on an entity in causal order", async () => {
  const { dir, repo, base, op1, op2 } = await repoWithHistory();
  const symHist = (await repo.historyOf("symbol:mod.ts#greet")).map((o) => o.oid);
  assert.deepEqual(symHist, [op1, op2], "two symbol edits, in order");
  const fileHist = (await repo.historyOf("file:mod.ts")).map((o) => o.oid);
  assert.deepEqual(fileHist, [base], "the scaffold put_file");
  // declaredPurpose is carried — the 'why' for blame
  assert.equal((await repo.historyOf("symbol:mod.ts#greet"))[1]!.declaredPurpose, "to v2");
  await rm(dir, { recursive: true, force: true });
});

test("materializeAt reproduces the full state at the current frontier", async () => {
  const { dir, repo } = await repoWithHistory();
  const full = await repo.materialize();
  const at = await repo.materializeAt(full.headOps);
  assert.equal(at.treeHash, full.treeHash, "materializeAt(head) === full materialize");
  await rm(dir, { recursive: true, force: true });
});

test("materializeAt time-travels to an earlier frontier", async () => {
  const { dir, repo, base, op1 } = await repoWithHistory();
  const filesAt = async (heads: string[]) =>
    (await repo.materializedFiles(await repo.materializeAt(heads))).find((f) => f.path === "mod.ts")?.content ?? "";

  assert.match(await filesAt([base]), /"v0"/, "at base → v0");
  assert.match(await filesAt([op1]), /"v1"/, "at op1 → v1");
  assert.doesNotMatch(await filesAt([op1]), /"v2"/, "op2 not yet in scope");
  await rm(dir, { recursive: true, force: true });
});
