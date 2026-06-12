// Phase 8: lineage. Long-lived divergent release lines (v1.x ∥ v2.x) coexist —
// the same symbol can hold intentionally different content per line WITHOUT a
// conflict, because each line materializes only its own op subset. Backport ports
// one change onto another line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor, Operation } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const greet = (v: string) => `export function greet() {\n  return "${v}";\n}`;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  // main: a file with one symbol returning "v0"
  const base = await repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts",
    content: greet("v0") + "\n", declaredPurpose: "scaffold",
  });
  return { dir, repo, intent, sess, base };
}

async function symbolText(repo: Repo, line: string): Promise<string> {
  const res = await repo.materialize(line);
  const files = await repo.materializedFiles(res);
  return files.find((f) => f.path === "mod.ts")?.content ?? "";
}

test("two lines hold different content on the SAME symbol with no conflict", async () => {
  const { dir, repo, intent, sess, base } = await setup();

  // Fork v2 from main at the current state.
  await repo.createLine("v2", "main");

  // main edits greet → "main"; v2 edits greet → "v2". Same symbol, different lines.
  await repo.proposeSymbolEdit({
    sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", symbolName: "greet",
    newText: greet("main"), declaredPurpose: "main edit", causalDeps: [base], line: "main",
  });
  await repo.proposeSymbolEdit({
    sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", symbolName: "greet",
    newText: greet("v2"), declaredPurpose: "v2 edit", causalDeps: await repo.lineFrontier("v2"), line: "v2",
  });

  const mainRes = await repo.materialize("main");
  const v2Res = await repo.materialize("v2");
  assert.equal(mainRes.conflicts.length, 0, "main: no conflict");
  assert.equal(v2Res.conflicts.length, 0, "v2: no conflict (divergence is not a conflict)");
  assert.match(await symbolText(repo, "main"), /"main"/);
  assert.match(await symbolText(repo, "v2"), /"v2"/);
  assert.doesNotMatch(await symbolText(repo, "main"), /"v2"/, "lines do not bleed");
  await rm(dir, { recursive: true, force: true });
});

test("a line inherits pre-fork history but not the base line's post-fork ops", async () => {
  const { dir, repo, intent, sess, base } = await setup();
  await repo.createLine("v2", "main");

  // After the fork, main adds a brand-new file. v2 must NOT see it.
  await repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: ai, path: "only-main.ts",
    content: "export const x = 1\n", declaredPurpose: "post-fork main file", causalDeps: [base], line: "main",
  });

  const mainFiles = (await repo.materializedFiles(await repo.materialize("main"))).map((f) => f.path).sort();
  const v2Files = (await repo.materializedFiles(await repo.materialize("v2"))).map((f) => f.path).sort();
  assert.deepEqual(mainFiles, ["mod.ts", "only-main.ts"]);
  assert.deepEqual(v2Files, ["mod.ts"], "v2 inherits mod.ts (pre-fork) but not the post-fork file");
  await rm(dir, { recursive: true, force: true });
});

test("backport: portOp lands a main fix on v2 without touching main", async () => {
  const { dir, repo, intent, sess, base } = await setup();
  await repo.createLine("v2", "main");

  // A fix authored on main.
  const fix = await repo.proposeSymbolEdit({
    sessionOid: sess, intentOid: intent, actor: ai, path: "mod.ts", symbolName: "greet",
    newText: greet("fixed"), declaredPurpose: "fix greet", causalDeps: [base], line: "main",
  });
  // v2 still on the old content until we backport.
  assert.match(await symbolText(repo, "v2"), /"v0"/);

  const ported = await repo.portOp(fix, "v2");
  const portedOp = await repo.store.get<Operation>(ported);
  assert.equal(portedOp.line, "v2");
  assert.equal(portedOp.derivedFrom, fix);

  assert.match(await symbolText(repo, "v2"), /"fixed"/, "v2 now has the backported fix");
  assert.match(await symbolText(repo, "main"), /"fixed"/, "main unchanged by the backport");
  await rm(dir, { recursive: true, force: true });
});

test("line-less repos are unaffected (backward compatible with 'main')", async () => {
  const { dir, repo } = await setup();
  // No lines created; default materialize is 'main' and contains the scaffold.
  const files = (await repo.materializedFiles(await repo.materialize())).map((f) => f.path);
  assert.deepEqual(files, ["mod.ts"]);
  assert.deepEqual(await repo.listLines(), []);
  await rm(dir, { recursive: true, force: true });
});
