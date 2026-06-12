// Phase 2: symbol-granular merge. Two agents editing different functions of the
// SAME file must auto-merge (Level 1); editing the same function still contends.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { symbolNames, spliceSymbol } from "../src/semantic/symbols.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const aiA: Actor = { kind: "ai_agent", id: "ai:a" };
const aiB: Actor = { kind: "ai_agent", id: "ai:b" };

const BASE = `import { db } from "./db";

function alpha() {
  return 1;
}

function beta() {
  return 2;
}
`;

test("symbol parser finds top-level names", () => {
  assert.deepEqual(symbolNames(BASE), ["alpha", "beta"]);
  const spliced = spliceSymbol(BASE, "beta", "function beta() {\n  return 22;\n}");
  assert.match(spliced, /return 22/);
  assert.match(spliced, /return 1/); // alpha untouched
  assert.deepEqual(symbolNames(spliced), ["alpha", "beta"]);
});

test("disjoint-symbol edits to the same file auto-merge (L1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sA = await repo.startSession({ intentOid: intent, actor: aiA });
  const sB = await repo.startSession({ intentOid: intent, actor: aiB });

  const base = await repo.proposeFileWrite({
    sessionOid: sA, intentOid: intent, actor: aiA, path: "mod.ts", content: BASE,
    declaredPurpose: "scaffold mod",
  });
  // Two agents edit DIFFERENT symbols, both building on the base.
  await repo.proposeSymbolEdit({
    sessionOid: sA, intentOid: intent, actor: aiA, path: "mod.ts", symbolName: "alpha",
    newText: "function alpha() {\n  return 111;\n}", declaredPurpose: "alpha→111", causalDeps: [base],
  });
  await repo.proposeSymbolEdit({
    sessionOid: sB, intentOid: intent, actor: aiB, path: "mod.ts", symbolName: "beta",
    newText: "function beta() {\n  return 222;\n}", declaredPurpose: "beta→222", causalDeps: [base],
  });

  const res = await repo.materialize();
  assert.equal(res.conflicts.length, 0, "different symbols must not conflict");

  const out = join(dir, "work");
  await repo.writeWorkspace(res, out);
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(join(out, "mod.ts"), "utf8");
  assert.match(content, /return 111/, "alpha edit present");
  assert.match(content, /return 222/, "beta edit present");
  await rm(dir, { recursive: true, force: true });
});

test("same-symbol edits contend (concurrent_write)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sA = await repo.startSession({ intentOid: intent, actor: aiA });
  const sB = await repo.startSession({ intentOid: intent, actor: aiB });
  const base = await repo.proposeFileWrite({
    sessionOid: sA, intentOid: intent, actor: aiA, path: "mod.ts", content: BASE, declaredPurpose: "scaffold",
  });
  await repo.proposeSymbolEdit({
    sessionOid: sA, intentOid: intent, actor: aiA, path: "mod.ts", symbolName: "alpha",
    newText: "function alpha() { return 9; }", declaredPurpose: "a", causalDeps: [base],
  });
  await repo.proposeSymbolEdit({
    sessionOid: sB, intentOid: intent, actor: aiB, path: "mod.ts", symbolName: "alpha",
    newText: "function alpha() { return 8; }", declaredPurpose: "b", causalDeps: [base],
  });
  const res = await repo.materialize();
  assert.equal(res.conflicts.length, 1, "same symbol must conflict");
  assert.equal(res.conflicts[0]!.key, "symbol:mod.ts#alpha");
  await rm(dir, { recursive: true, force: true });
});
