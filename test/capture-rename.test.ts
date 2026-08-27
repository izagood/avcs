// Stage 0 (docs/19 §3.1, C15–C19) — the capture path has to RECOGNISE a move.
//
// `commitWorkingTree` diffs path sets, so a moved file looks like `removed(P)` plus
// `added(Q)`: a delete racing an edit, and a base-less create that nothing can 3-way
// merge. Every bit of Stage 1's commutativity is unreachable from real usage until the
// capture emits `rename_file` in the first place.
//
// The pairing rules are deliberately conservative and deterministic: exact content match
// is a pure move; ≥50% line similarity is a move-and-modify; anything ambiguous stays a
// delete + create rather than guessing.
//
//   node --experimental-strip-types --test test/capture-rename.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { Repo } from "../src/api/repo.ts";
import type { Actor, Operation } from "../src/objects/types.ts";

const dev: Actor = { kind: "human", id: "human:dev" };

const mkrepo = () => mkdtemp(join(tmpdir(), "avcs-caprn-"));

async function bodiesOf(repo: Repo, oids: string[]): Promise<Operation["body"][]> {
  return Promise.all(oids.map(async (oid) => (await repo.store.get<Operation>(oid)).body));
}

async function files(repo: Repo, view = "main"): Promise<Map<string, string>> {
  const res = await repo.materialize(view);
  return new Map((await repo.materializedFiles(res)).map((f) => [f.path, f.content]));
}

/** A file long and distinctive enough that similarity to any OTHER fixture is near zero. */
const body = (tag: string, n = 12): string =>
  Array.from({ length: n }, (_, i) => `${tag} line ${i} — ${tag.repeat(2)}_${i}`).join("\n") + "\n";

// ── C15 — a pure move ──
test("C15: a file moved with no content change is captured as ONE rename_file", async () => {
  const dir = await mkrepo();
  try {
    const repo = await Repo.init(dir);
    await mkdir(join(dir, "app"), { recursive: true });
    await writeFile(join(dir, "app", "a.ts"), body("alpha"), "utf8");
    await repo.commitWorkingTree(dir, { message: "scaffold", actor: dev });

    await mkdir(join(dir, "app", "x"), { recursive: true });
    await unlink(join(dir, "app", "a.ts"));
    await writeFile(join(dir, "app", "x", "a.ts"), body("alpha"), "utf8");
    const cap = await repo.commitWorkingTree(dir, { message: "relocate", actor: dev });

    const bodies = await bodiesOf(repo, cap.ops);
    assert.deepEqual(bodies.map((b) => b.kind), ["rename_file"], "a pure move is one op, not delete + put");
    assert.equal(bodies[0]!.fromPath, "app/a.ts");
    assert.equal(bodies[0]!.path, "app/x/a.ts");
    assert.deepEqual(cap.renamed, [{ from: "app/a.ts", to: "app/x/a.ts" }]);
    assert.deepEqual(cap.added, [], "a recognised move is not reported as an addition");
    assert.deepEqual(cap.removed, [], "nor as a removal");

    const f = await files(repo);
    assert.equal(f.get("app/x/a.ts"), body("alpha"));
    assert.equal(f.has("app/a.ts"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── C16 — moved AND modified ──
test("C16: a file moved and modified becomes rename_file + edit_file based on the pre-move content", async () => {
  const dir = await mkrepo();
  try {
    const repo = await Repo.init(dir);
    const before = body("beta");
    const after = before.replace("beta line 3", "beta line 3 CHANGED");
    assert.notEqual(before, after);
    await writeFile(join(dir, "b.ts"), before, "utf8");
    await repo.commitWorkingTree(dir, { message: "scaffold", actor: dev });

    await unlink(join(dir, "b.ts"));
    await writeFile(join(dir, "moved-b.ts"), after, "utf8");
    const cap = await repo.commitWorkingTree(dir, { message: "move and tweak", actor: dev });

    const bodies = await bodiesOf(repo, cap.ops);
    assert.deepEqual(bodies.map((b) => b.kind).sort(), ["edit_file", "rename_file"]);
    const rn = bodies.find((b) => b.kind === "rename_file")!;
    const ed = bodies.find((b) => b.kind === "edit_file")!;
    assert.equal(rn.fromPath, "b.ts");
    assert.equal(rn.path, "moved-b.ts");
    assert.equal(ed.path, "moved-b.ts", "the edit is expressed at the NEW path");
    assert.ok(ed.baseBlobOid, "and it carries a 3-way merge base");
    assert.equal(
      (await repo.readBlob(ed.baseBlobOid!)).toString("utf8"),
      before,
      "the base is the content from BEFORE the move — that is what 'moved while editing' means",
    );

    const f = await files(repo);
    assert.equal(f.get("moved-b.ts"), after);
    assert.equal(f.has("b.ts"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── C17 — below the similarity threshold ──
test("C17: a removal and an unrelated addition are NOT paired as a move", async () => {
  const dir = await mkrepo();
  try {
    const repo = await Repo.init(dir);
    await writeFile(join(dir, "old.ts"), body("gamma"), "utf8");
    await repo.commitWorkingTree(dir, { message: "scaffold", actor: dev });

    await unlink(join(dir, "old.ts"));
    await writeFile(join(dir, "new.ts"), body("omega"), "utf8"); // shares no lines
    const cap = await repo.commitWorkingTree(dir, { message: "swap", actor: dev });

    const kinds = (await bodiesOf(repo, cap.ops)).map((b) => b.kind).sort();
    assert.deepEqual(kinds, ["delete_file", "put_file"], "below threshold ⇒ no guessing");
    assert.deepEqual(cap.renamed, []);
    assert.deepEqual(cap.added, ["new.ts"]);
    assert.deepEqual(cap.removed, ["old.ts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── C18 — binary ──
test("C18: a moved BINARY file is paired only on an exact content match", async () => {
  const dir = await mkrepo();
  try {
    const repo = await Repo.init(dir);
    const bin = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x7f, 0x10, 0x00]);
    await writeFile(join(dir, "asset.bin"), bin);
    await repo.commitWorkingTree(dir, { message: "scaffold", actor: dev });

    await unlink(join(dir, "asset.bin"));
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "assets", "asset.bin"), bin);
    const cap = await repo.commitWorkingTree(dir, { message: "relocate asset", actor: dev });

    const bodies = await bodiesOf(repo, cap.ops);
    assert.deepEqual(bodies.map((b) => b.kind), ["rename_file"]);
    assert.equal(bodies[0]!.fromPath, "asset.bin");
    assert.equal(bodies[0]!.path, "assets/asset.bin");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("C18b: a moved BINARY file whose bytes changed is NOT paired — no similarity on binary", async () => {
  const dir = await mkrepo();
  try {
    const repo = await Repo.init(dir);
    const bin = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x7f, 0x10, 0x00]);
    await writeFile(join(dir, "asset.bin"), bin);
    await repo.commitWorkingTree(dir, { message: "scaffold", actor: dev });

    await unlink(join(dir, "asset.bin"));
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "assets", "asset.bin"), Buffer.concat([bin, Buffer.from([0x42])]));
    const cap = await repo.commitWorkingTree(dir, { message: "relocate asset", actor: dev });

    const kinds = (await bodiesOf(repo, cap.ops)).map((b) => b.kind).sort();
    assert.deepEqual(kinds, ["delete_file", "put_file"], "line similarity is meaningless on binary");
    assert.deepEqual(cap.renamed, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── C19 — many-to-many ambiguity ──
test("C19: an ambiguous pairing (one removal, two similar additions) is NOT called a move", async () => {
  const dir = await mkrepo();
  try {
    const repo = await Repo.init(dir);
    const src = body("delta");
    await writeFile(join(dir, "src.ts"), src, "utf8");
    await repo.commitWorkingTree(dir, { message: "scaffold", actor: dev });

    await unlink(join(dir, "src.ts"));
    await writeFile(join(dir, "copy1.ts"), src, "utf8");
    await writeFile(join(dir, "copy2.ts"), src, "utf8");
    const cap = await repo.commitWorkingTree(dir, { message: "split", actor: dev });

    const kinds = (await bodiesOf(repo, cap.ops)).map((b) => b.kind).sort();
    assert.deepEqual(kinds, ["delete_file", "put_file", "put_file"], "which one is 'the' move is unknowable");
    assert.deepEqual(cap.renamed, []);
    assert.deepEqual(cap.added, ["copy1.ts", "copy2.ts"]);
    assert.deepEqual(cap.removed, ["src.ts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("C19b: two removals both similar to one addition is NOT called a move either", async () => {
  const dir = await mkrepo();
  try {
    const repo = await Repo.init(dir);
    const src = body("epsilon");
    await writeFile(join(dir, "one.ts"), src, "utf8");
    await writeFile(join(dir, "two.ts"), src, "utf8");
    await repo.commitWorkingTree(dir, { message: "scaffold", actor: dev });

    await unlink(join(dir, "one.ts"));
    await unlink(join(dir, "two.ts"));
    await writeFile(join(dir, "merged.ts"), src, "utf8");
    const cap = await repo.commitWorkingTree(dir, { message: "collapse", actor: dev });

    const kinds = (await bodiesOf(repo, cap.ops)).map((b) => b.kind).sort();
    assert.deepEqual(kinds, ["delete_file", "delete_file", "put_file"]);
    assert.deepEqual(cap.renamed, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── determinism of the pairing ──
test("the pairing is deterministic: a bulk relocation yields the same op set every time", async () => {
  async function run(): Promise<{ pairs: string[]; kinds: string[] }> {
    const dir = await mkrepo();
    try {
      const repo = await Repo.init(dir);
      await mkdir(join(dir, "app"), { recursive: true });
      const tags = ["alpha", "bravo", "charlie", "delta", "echo"];
      for (const t of tags) await writeFile(join(dir, "app", `${t}.ts`), body(t), "utf8");
      await repo.commitWorkingTree(dir, { message: "scaffold", actor: dev });

      await mkdir(join(dir, "app", "core"), { recursive: true });
      for (const t of tags) {
        await unlink(join(dir, "app", `${t}.ts`));
        await writeFile(join(dir, "app", "core", `${t}.ts`), body(t), "utf8");
      }
      const cap = await repo.commitWorkingTree(dir, { message: "relocate all", actor: dev });
      const kinds = (await bodiesOf(repo, cap.ops)).map((b) => b.kind);
      return { pairs: cap.renamed.map((r) => `${r.from}→${r.to}`), kinds };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const a = await run();
  const b = await run();
  assert.equal(a.pairs.length, 5, "all five moves recognised");
  assert.deepEqual(a.kinds, ["rename_file", "rename_file", "rename_file", "rename_file", "rename_file"]);
  assert.deepEqual(a.pairs, b.pairs, "same working tree ⇒ same op set, every time");
});
