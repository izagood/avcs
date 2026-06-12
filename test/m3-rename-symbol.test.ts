// M3 AST op: rename_symbol — renames a symbol's declaration + same-file references,
// auto-merges with disjoint-symbol edits, conflicts with same-symbol edits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { renameSymbol } from "../src/semantic/symbols.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const aiB: Actor = { kind: "ai_agent", id: "ai:b" };

const MOD = `export function greet() {\n  return helper();\n}\n\nfunction helper() {\n  return 1;\n}\n`;

test("renameSymbol pure: decl + references, word-boundary", () => {
  const out = renameSymbol(MOD, "helper", "helper2");
  assert.match(out, /function helper2\(\)/);
  assert.match(out, /return helper2\(\)/);
  assert.doesNotMatch(out, /[^2]helper\(/);
});

async function content(repo: Repo, path = "mod.ts") {
  return (await repo.materializedFiles(await repo.materialize())).find((f) => f.path === path)?.content ?? "";
}

test("rename_symbol op renames decl + references in the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  const base = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", content: MOD, declaredPurpose: "scaffold" });
  await repo.proposeRenameSymbol({ sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", from: "helper", to: "compute", declaredPurpose: "rename helper→compute", causalDeps: [base] });
  const c = await content(repo);
  assert.match(c, /function compute\(\)/);
  assert.match(c, /return compute\(\)/, "reference updated");
  await rm(dir, { recursive: true, force: true });
});

test("rename of one symbol auto-merges with a set_symbol of another", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sA = await repo.startSession({ intentOid: intent, actor: ai });
  const sB = await repo.startSession({ intentOid: intent, actor: aiB });
  const base = await repo.proposeFileWrite({ sessionOid: sA, intentOid: intent, actor: ai, path: "mod.ts", content: MOD, declaredPurpose: "scaffold" });
  // A renames helper; B edits greet's body — different symbols, concurrent.
  await repo.proposeRenameSymbol({ sessionOid: sA, intentOid: intent, actor: ai, path: "mod.ts", from: "helper", to: "compute", declaredPurpose: "rename", causalDeps: [base] });
  await repo.proposeSymbolEdit({ sessionOid: sB, intentOid: intent, actor: aiB, path: "mod.ts", symbolName: "greet", newText: "export function greet() {\n  return helper() + 1;\n}", declaredPurpose: "greet edit", causalDeps: [base] });
  const res = await repo.materialize();
  assert.equal(res.conflicts.length, 0, "disjoint symbols (rename helper ∥ edit greet) auto-merge");
  await rm(dir, { recursive: true, force: true });
});
