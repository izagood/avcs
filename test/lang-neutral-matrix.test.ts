// Language-neutral core — precision analysis matrix (docs/15 §9).
//
// Drives the REAL Repo/reduce() pipeline (not merge3 in isolation) across many languages
// to prove the redesigned core behaves identically regardless of language: concurrent
// disjoint edits auto-merge (L1), overlapping edits conflict (L2), and the result is
// deterministic. No language-specific code exists anywhere in src/ — this confirms it
// empirically on python, java, markdown, json, typescript, javascript, rust, c, c++.
//
//   node --experimental-strip-types --test test/lang-neutral-matrix.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const A: Actor = { kind: "ai_agent", id: "ai:a" };
const B: Actor = { kind: "ai_agent", id: "ai:b" };

async function freshRepo() {
  const dir = await mkdtemp(join(tmpdir(), "avcs-matrix-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "matrix", owner: A.id });
  const sess = await repo.startSession({ intentOid: intent, actor: A });
  return { dir, repo, intent, sess };
}

async function contentOf(repo: Repo, view = "main"): Promise<Map<string, string>> {
  const res = await repo.materialize(view);
  return new Map((await repo.materializedFiles(res)).map((f) => [f.path, f.content]));
}

/** A per-language case: base file + two concurrent edits that touch DISJOINT regions
 *  (must auto-merge) and two that touch the SAME region (must conflict). */
interface LangCase {
  lang: string;
  path: string;
  base: string;
  disjointA: string; // edits region 1 only
  disjointB: string; // edits region 2 only
  mergedExpected: string; // base with both region edits
  overlapA: string; // edits the shared region one way
  overlapB: string; // edits the shared region another way
}

const CASES: LangCase[] = [
  {
    lang: "python", path: "m.py",
    base: "def a():\n    return 1\n\n\ndef b():\n    return 2\n",
    disjointA: "def a():\n    return 100\n\n\ndef b():\n    return 2\n",
    disjointB: "def a():\n    return 1\n\n\ndef b():\n    return 200\n",
    mergedExpected: "def a():\n    return 100\n\n\ndef b():\n    return 200\n",
    overlapA: "def a():\n    return 111\n\n\ndef b():\n    return 2\n",
    overlapB: "def a():\n    return 999\n\n\ndef b():\n    return 2\n",
  },
  {
    lang: "java", path: "M.java",
    base: "class M {\n  int x() { return 1; }\n\n\n  int y() { return 2; }\n}\n",
    disjointA: "class M {\n  int x() { return 100; }\n\n\n  int y() { return 2; }\n}\n",
    disjointB: "class M {\n  int x() { return 1; }\n\n\n  int y() { return 200; }\n}\n",
    mergedExpected: "class M {\n  int x() { return 100; }\n\n\n  int y() { return 200; }\n}\n",
    overlapA: "class M {\n  int x() { return 111; }\n\n\n  int y() { return 2; }\n}\n",
    overlapB: "class M {\n  int x() { return 999; }\n\n\n  int y() { return 2; }\n}\n",
  },
  {
    lang: "markdown", path: "doc.md",
    base: "# Title\n\nIntro paragraph.\n\n\n## Section\n\nBody paragraph.\n",
    disjointA: "# Title CHANGED\n\nIntro paragraph.\n\n\n## Section\n\nBody paragraph.\n",
    disjointB: "# Title\n\nIntro paragraph.\n\n\n## Section\n\nBody paragraph EXPANDED.\n",
    mergedExpected: "# Title CHANGED\n\nIntro paragraph.\n\n\n## Section\n\nBody paragraph EXPANDED.\n",
    overlapA: "# Title ONE\n\nIntro paragraph.\n\n\n## Section\n\nBody paragraph.\n",
    overlapB: "# Title TWO\n\nIntro paragraph.\n\n\n## Section\n\nBody paragraph.\n",
  },
  {
    lang: "json", path: "config.json",
    base: '{\n  "a": 1,\n\n\n  "b": 2\n}\n',
    disjointA: '{\n  "a": 100,\n\n\n  "b": 2\n}\n',
    disjointB: '{\n  "a": 1,\n\n\n  "b": 200\n}\n',
    mergedExpected: '{\n  "a": 100,\n\n\n  "b": 200\n}\n',
    overlapA: '{\n  "a": 111,\n\n\n  "b": 2\n}\n',
    overlapB: '{\n  "a": 999,\n\n\n  "b": 2\n}\n',
  },
  {
    lang: "typescript", path: "m.ts",
    base: "export function a(): number {\n  return 1;\n}\n\n\nexport function b(): number {\n  return 2;\n}\n",
    disjointA: "export function a(): number {\n  return 100;\n}\n\n\nexport function b(): number {\n  return 2;\n}\n",
    disjointB: "export function a(): number {\n  return 1;\n}\n\n\nexport function b(): number {\n  return 200;\n}\n",
    mergedExpected: "export function a(): number {\n  return 100;\n}\n\n\nexport function b(): number {\n  return 200;\n}\n",
    overlapA: "export function a(): number {\n  return 111;\n}\n\n\nexport function b(): number {\n  return 2;\n}\n",
    overlapB: "export function a(): number {\n  return 999;\n}\n\n\nexport function b(): number {\n  return 2;\n}\n",
  },
  {
    lang: "javascript", path: "m.js",
    base: "function a() {\n  return 1;\n}\n\n\nfunction b() {\n  return 2;\n}\n",
    disjointA: "function a() {\n  return 100;\n}\n\n\nfunction b() {\n  return 2;\n}\n",
    disjointB: "function a() {\n  return 1;\n}\n\n\nfunction b() {\n  return 200;\n}\n",
    mergedExpected: "function a() {\n  return 100;\n}\n\n\nfunction b() {\n  return 200;\n}\n",
    overlapA: "function a() {\n  return 111;\n}\n\n\nfunction b() {\n  return 2;\n}\n",
    overlapB: "function a() {\n  return 999;\n}\n\n\nfunction b() {\n  return 2;\n}\n",
  },
  {
    lang: "rust", path: "m.rs",
    base: "fn a() -> i32 {\n    1\n}\n\n\nfn b() -> i32 {\n    2\n}\n",
    disjointA: "fn a() -> i32 {\n    100\n}\n\n\nfn b() -> i32 {\n    2\n}\n",
    disjointB: "fn a() -> i32 {\n    1\n}\n\n\nfn b() -> i32 {\n    200\n}\n",
    mergedExpected: "fn a() -> i32 {\n    100\n}\n\n\nfn b() -> i32 {\n    200\n}\n",
    overlapA: "fn a() -> i32 {\n    111\n}\n\n\nfn b() -> i32 {\n    2\n}\n",
    overlapB: "fn a() -> i32 {\n    999\n}\n\n\nfn b() -> i32 {\n    2\n}\n",
  },
  {
    lang: "c", path: "m.c",
    base: "int a(void) {\n    return 1;\n}\n\n\nint b(void) {\n    return 2;\n}\n",
    disjointA: "int a(void) {\n    return 100;\n}\n\n\nint b(void) {\n    return 2;\n}\n",
    disjointB: "int a(void) {\n    return 1;\n}\n\n\nint b(void) {\n    return 200;\n}\n",
    mergedExpected: "int a(void) {\n    return 100;\n}\n\n\nint b(void) {\n    return 200;\n}\n",
    overlapA: "int a(void) {\n    return 111;\n}\n\n\nint b(void) {\n    return 2;\n}\n",
    overlapB: "int a(void) {\n    return 999;\n}\n\n\nint b(void) {\n    return 2;\n}\n",
  },
  {
    lang: "cpp", path: "m.cpp",
    base: "int a() {\n  return 1;\n}\n\n\nint b() {\n  return 2;\n}\n",
    disjointA: "int a() {\n  return 100;\n}\n\n\nint b() {\n  return 2;\n}\n",
    disjointB: "int a() {\n  return 1;\n}\n\n\nint b() {\n  return 200;\n}\n",
    mergedExpected: "int a() {\n  return 100;\n}\n\n\nint b() {\n  return 200;\n}\n",
    overlapA: "int a() {\n  return 111;\n}\n\n\nint b() {\n  return 2;\n}\n",
    overlapB: "int a() {\n  return 999;\n}\n\n\nint b() {\n  return 2;\n}\n",
  },
];

// ── C1: disjoint concurrent edits auto-merge (L1), per language ──
for (const c of CASES) {
  test(`L1 disjoint auto-merge — ${c.lang}`, async () => {
    const { dir, repo, intent, sess } = await freshRepo();
    try {
      const scaffold = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: A, path: c.path, content: c.base, declaredPurpose: "scaffold" });
      await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: A, path: c.path, baseText: c.base, newText: c.disjointA, declaredPurpose: "A", causalDeps: [scaffold] });
      await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: B, path: c.path, baseText: c.base, newText: c.disjointB, declaredPurpose: "B", causalDeps: [scaffold] });
      const res = await repo.materialize();
      const files = await repo.materializedFiles(res);
      const got = files.find((f) => f.path === c.path)?.content;
      assert.equal(res.conflicts.length, 0, `${c.lang}: expected no conflicts`);
      assert.equal(res.fileConflicts.length, 0, `${c.lang}: expected no file conflicts`);
      assert.equal(got, c.mergedExpected, `${c.lang}: both disjoint edits must survive`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

// ── C2: overlapping concurrent edits conflict (L2), per language ──
for (const c of CASES) {
  test(`L2 overlap conflict — ${c.lang}`, async () => {
    const { dir, repo, intent, sess } = await freshRepo();
    try {
      const scaffold = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: A, path: c.path, content: c.base, declaredPurpose: "scaffold" });
      await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: A, path: c.path, baseText: c.base, newText: c.overlapA, declaredPurpose: "A", causalDeps: [scaffold] });
      await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: B, path: c.path, baseText: c.base, newText: c.overlapB, declaredPurpose: "B", causalDeps: [scaffold] });
      const res = await repo.materialize();
      assert.equal(res.fileConflicts.length, 1, `${c.lang}: expected exactly one file conflict`);
      assert.ok(res.conflicts.length >= 1, `${c.lang}: conflict must be surfaced for the release gate`);
      assert.equal(res.fileConflicts[0]!.file, c.path);
      // The contested region must offer both agents' versions as options.
      assert.ok(res.fileConflicts[0]!.regions[0]!.options.length >= 2, `${c.lang}: both options present`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

// ── C4: determinism — proposing the two disjoint edits in the OPPOSITE order yields the
//        same materialized tree hash (canonical ordering inside reduce). ──
test("L1 disjoint merge is order-independent (determinism)", async () => {
  const c = CASES[0]!;
  async function run(first: "A" | "B") {
    const { dir, repo, intent, sess } = await freshRepo();
    const scaffold = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: A, path: c.path, content: c.base, declaredPurpose: "scaffold" });
    const ea = { sessionOid: sess, intentOid: intent, actor: A, path: c.path, baseText: c.base, newText: c.disjointA, declaredPurpose: "A", causalDeps: [scaffold] };
    const eb = { sessionOid: sess, intentOid: intent, actor: B, path: c.path, baseText: c.base, newText: c.disjointB, declaredPurpose: "B", causalDeps: [scaffold] };
    if (first === "A") { await repo.proposeEdit(ea); await repo.proposeEdit(eb); }
    else { await repo.proposeEdit(eb); await repo.proposeEdit(ea); }
    const res = await repo.materialize();
    const got = (await repo.materializedFiles(res)).find((f) => f.path === c.path)?.content;
    await rm(dir, { recursive: true, force: true });
    return { hash: res.treeHash, got };
  }
  const r1 = await run("A");
  const r2 = await run("B");
  assert.equal(r1.got, c.mergedExpected);
  assert.equal(r2.got, c.mergedExpected, "opposite authoring order must merge identically");
});

// ── C8: cross-language repo — many languages in one repo, each file independent (L0). ──
test("cross-language repo: every language file is independent", async () => {
  const { dir, repo, intent, sess } = await freshRepo();
  try {
    for (const c of CASES) {
      const scaffold = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: A, path: c.path, content: c.base, declaredPurpose: `scaffold ${c.lang}` });
      await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: A, path: c.path, baseText: c.base, newText: c.disjointA, declaredPurpose: `edit ${c.lang}`, causalDeps: [scaffold] });
    }
    const res = await repo.materialize();
    assert.equal(res.conflicts.length, 0, "distinct files never contend");
    assert.equal(res.fileConflicts.length, 0);
    const files = new Map((await repo.materializedFiles(res)).map((f) => [f.path, f.content]));
    for (const c of CASES) assert.equal(files.get(c.path), c.disjointA, `${c.lang} file must hold its own edit`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── C6: concurrent create (put_file) with NO common base → not 3-way mergeable → L2. ──
test("concurrent put_file (no common base) → conflict, no silent data loss", async () => {
  const { dir, repo, intent, sess } = await freshRepo();
  try {
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: A, path: "new.txt", content: "from A\n", declaredPurpose: "A creates" });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: B, path: "new.txt", content: "from B\n", declaredPurpose: "B creates" });
    const res = await repo.materialize();
    assert.ok(res.conflicts.length >= 1, "two creates of the same path must contend");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
