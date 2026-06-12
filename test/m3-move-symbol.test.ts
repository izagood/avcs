// M3 AST op: move_symbol — move a top-level symbol from one file to another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { extractSymbol } from "../src/semantic/symbols.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };

test("extractSymbol returns the symbol text and the remaining content", () => {
  const c = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
  const e = extractSymbol(c, "a")!;
  assert.match(e.text, /function a\(\)/);
  assert.doesNotMatch(e.rest, /function a\(\)/);
  assert.match(e.rest, /function b\(\)/);
  assert.equal(extractSymbol(c, "nope"), null);
});

test("move_symbol relocates a symbol between files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  const a = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "export function moveMe() {\n  return 7;\n}\n\nexport function stay() {\n  return 1;\n}\n", declaredPurpose: "a" });
  const b = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "b.ts", content: "export const x = 0\n", declaredPurpose: "b" });
  await repo.proposeMoveSymbol({ sessionOid: sess, intentOid: intent, actor: ai, fromPath: "a.ts", toPath: "b.ts", symbolName: "moveMe", declaredPurpose: "move moveMe a→b", causalDeps: [a, b] });

  const files = await repo.materializedFiles(await repo.materialize());
  const ac = files.find((f) => f.path === "a.ts")!.content;
  const bc = files.find((f) => f.path === "b.ts")!.content;
  assert.doesNotMatch(ac, /moveMe/, "removed from source");
  assert.match(ac, /function stay/, "other symbol stays in source");
  assert.match(bc, /function moveMe/, "added to destination");
  await rm(dir, { recursive: true, force: true });
});
