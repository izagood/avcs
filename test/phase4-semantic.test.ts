// Phase 4: semantic-conflict detection (undeclared contract breaks) + decision memory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { contractChanged, referencesSymbol } from "../src/semantic/contract.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const aiA: Actor = { kind: "ai_agent", id: "ai:a" };
const aiB: Actor = { kind: "ai_agent", id: "ai:b" };
const ci: Actor = { kind: "ci_bot", id: "ci" };

const API = `export function findById(id) {
  return id;
}
`;
const CALLER = `import { findById } from "./api";
export function run() {
  return findById(1);
}
`;

test("contract helpers detect signature drift and references", () => {
  assert.equal(contractChanged(API, "export function findById(id, tenant) {\n  return id;\n}\n", "findById"), true);
  assert.equal(contractChanged(API, "export function findById(id) {\n  return 0;\n}\n", "findById"), false);
  assert.equal(referencesSymbol(CALLER, "findById"), true);
  assert.equal(referencesSymbol(API, "findById"), false); // its own declaration only
});

test("undeclared contract break with a live caller escalates to a human", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sA = await repo.startSession({ intentOid: intent, actor: aiA });
  const sB = await repo.startSession({ intentOid: intent, actor: aiB });

  const apiBase = await repo.proposeFileWrite({
    sessionOid: sA, intentOid: intent, actor: aiA, path: "api.ts", content: API, declaredPurpose: "scaffold api",
  });
  await repo.proposeFileWrite({
    sessionOid: sB, intentOid: intent, actor: aiB, path: "caller.ts", content: CALLER, declaredPurpose: "add caller",
  });
  // Agent A changes findById's signature but does NOT declare breaksPublicApi.
  const breakingOp = await repo.proposeSymbolEdit({
    sessionOid: sA, intentOid: intent, actor: aiA, path: "api.ts", symbolName: "findById",
    newText: "export function findById(id, tenant) {\n  return id;\n}", declaredPurpose: "add tenant param",
    causalDeps: [apiBase],
  });

  const res = await repo.materialize();
  assert.equal(res.semanticConflicts.length, 1, "contract break detected despite no text overlap");
  assert.equal(res.semanticConflicts[0]!.symbol, "api.ts#findById");
  assert.equal(res.semanticConflicts[0]!.breakingOp, breakingOp);
  assert.equal(res.statuses.get(breakingOp), "needs_decision", "breaking op held back");
  // The unsafe change is NOT in the tree (api.ts keeps the old single-arg signature).
  const out = join(dir, "work");
  await repo.writeWorkspace(res, out);
  const { readFile } = await import("node:fs/promises");
  assert.doesNotMatch(await readFile(join(out, "api.ts"), "utf8"), /tenant/, "broken signature withheld");

  // With api_compat evidence (ci), the break is exonerated and applied.
  await repo.attachEvidence({ forOps: [breakingOp], kind: "api_compat", result: "pass", producedBy: ci });
  const res2 = await repo.materialize();
  assert.equal(res2.semanticConflicts.length, 0, "api_compat evidence exonerates");
  assert.equal(res2.statuses.get(breakingOp), "accepted");
  await rm(dir, { recursive: true, force: true });
});

test("decision memory recalls prior rulings and learned policies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const key = "symbol:cache.ts#strategy";
  await repo.recordDecision({
    conflictId: key, chosenOps: [], rejectedOps: [], reason: "use Redis; prod already runs it",
    decidedBy: human, futurePolicy: "cache strategy는 Redis 우선",
  });
  const recalled = await repo.recallDecisions(key);
  assert.equal(recalled.length, 1);
  assert.match(recalled[0]!.reason, /Redis/);
  assert.equal(recalled[0]!.decidedBy, "human:h");
  assert.deepEqual(await repo.learnedPolicies(), ["cache strategy는 Redis 우선"]);
  await rm(dir, { recursive: true, force: true });
});
