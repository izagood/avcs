// Phase 10: observability — blame, log -p, diff, bisect. All built on the Phase 9
// entity index + materializeAt; deterministic, no checkout/rebuild.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { diffTrees } from "../src/query/diff.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const greet = (v: string) => `export function greet() {\n  return "${v}";\n}`;

async function lineared() {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "cache work", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  const base = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", content: greet("v0") + "\n", declaredPurpose: "scaffold" });
  const op1 = await repo.proposeSymbolEdit({ sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", symbolName: "greet", newText: greet("v1"), declaredPurpose: "to v1", causalDeps: [base] });
  const op2 = await repo.proposeSymbolEdit({ sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", symbolName: "greet", newText: greet("BAD"), declaredPurpose: "regress", causalDeps: [op1] });
  return { dir, repo, intent, sess, base, op1, op2 };
}

test("blame: who currently owns a symbol and why", async () => {
  const { dir, repo, op2 } = await lineared();
  const b = await repo.blame("symbol:mod.ts#greet");
  assert.equal(b?.op, op2, "current owner is the latest accepted edit");
  assert.equal(b?.purpose, "regress");
  assert.equal(b?.actor.id, "ai:a");
  assert.equal(b?.intentTitle, "cache work", "the 'why' carries the intent");
  await rm(dir, { recursive: true, force: true });
});

test("log -p: each edit with reconstructed before/after", async () => {
  const { dir, repo, op1, op2 } = await lineared();
  const log = await repo.logP("symbol:mod.ts#greet", "mod.ts");
  assert.equal(log.length, 2);
  const e1 = log.find((e) => e.op === op1)!;
  assert.match(e1.before, /"v0"/);
  assert.match(e1.after, /"v1"/);
  const e2 = log.find((e) => e.op === op2)!;
  assert.match(e2.before, /"v1"/);
  assert.match(e2.after, /"BAD"/);
  await rm(dir, { recursive: true, force: true });
});

test("bisect: pinpoint the op that introduced a regression", async () => {
  const { dir, repo, base, op2 } = await lineared();
  const culprit = await repo.bisect(
    [base], // known good (v0)
    [op2], // known bad (BAD)
    async (res) => (await repo.materializedFiles(res)).some((f) => f.content.includes("BAD")),
  );
  assert.equal(culprit, op2, "op2 introduced the regression");
  await rm(dir, { recursive: true, force: true });
});

test("diff: two lines differ on the edited file", async () => {
  const { dir, repo, intent, sess, base } = await lineared();
  await repo.createLine("v2", "main");
  await repo.proposeSymbolEdit({ sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", symbolName: "greet", newText: greet("v2-only"), declaredPurpose: "v2 edit", causalDeps: await repo.lineFrontier("v2"), line: "v2" });
  const d = await repo.diff("main", "v2");
  assert.deepEqual(d.modified, ["mod.ts"]);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  // pure diffTrees on two equal results is empty
  const same = diffTrees(await repo.materialize("main"), await repo.materialize("main"));
  assert.deepEqual(same, { added: [], removed: [], modified: [] });
  await rm(dir, { recursive: true, force: true });
});
