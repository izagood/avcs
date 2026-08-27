// C20 / C21 (docs/19 §5) — the reason this track exists, and the promise it must not break.
//
// C20 is a miniature of an observed failure in a parallel-agent project: one session
// relocated a directory of files while another session edited those same files with no
// causal knowledge of the move. Every file came back as a conflict, twice, and had to be
// re-merged by hand. It is reproduced end to end here — two working trees, two real
// captures, one convergence — because that is the only way to show the whole chain works:
// capture recognises the moves (Stage 0), and the reducer routes the edits to where the
// files went (Stage 1). Driving the reducer with hand-authored ops would skip the half
// that was broken in the field.
//
// C21 is the other half of the deal: a history with no moves in it must materialize the
// byte-identical tree it did before any of this existed.
//
//   node --experimental-strip-types --test test/rename-field-incident.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, unlink, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256hex, canonicalize } from "../src/core/canonical.ts";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const dev: Actor = { kind: "human", id: "human:dev" };
const alice: Actor = { kind: "ai_agent", id: "ai:alice" };
const bob: Actor = { kind: "ai_agent", id: "ai:bob" };

const mkrepo = () => mkdtemp(join(tmpdir(), "avcs-incident-"));

/** Fork a second session off the SAME frontier, the way a clone-then-work does. */
async function cloneStore(from: string, to: string): Promise<Repo> {
  await rm(join(to, ".avcs"), { recursive: true, force: true });
  await cp(join(from, ".avcs"), join(to, ".avcs"), { recursive: true });
  return Repo.open(to);
}

/** Converge two stores, the way a pull does: gossip objects, rebuild the local index. */
async function gossip(from: string, to: Repo): Promise<void> {
  await cp(join(from, ".avcs", "objects"), join(to.dir, ".avcs", "objects"), { recursive: true });
  await to.reindex();
}

const MODULES = ["auth", "billing", "config", "router", "store"] as const;
const source = (name: string): string =>
  [
    `// module ${name}`,
    `import { base } from "../base.ts";`,
    ``,
    `export function ${name}Init(): string {`,
    `  return "${name}:" + base();`,
    `}`,
    ``,
    `export function ${name}Reset(): void {`,
    `  // ${name} teardown`,
    `}`,
  ].join("\n") + "\n";

/** The edit the other session makes: touches ONE line, far from anything structural. */
const edited = (name: string): string => source(name).replace(`  // ${name} teardown`, `  // ${name} teardown — audited`);

// ── C20 ──
test("C20: one session relocates five files while another edits the same five — zero conflicts", async () => {
  const a = await mkrepo();
  const b = await mkrepo();
  try {
    // ── a shared starting point ──
    const repoA = await Repo.init(a);
    await mkdir(join(a, "app"), { recursive: true });
    for (const m of MODULES) await writeFile(join(a, "app", `${m}.ts`), source(m), "utf8");
    await repoA.commitWorkingTree(a, { message: "scaffold the app", actor: dev });

    const repoB = await cloneStore(a, b);
    await repoB.checkoutInto(b);

    // ── session A: relocate every module into app/core/ ──
    await mkdir(join(a, "app", "core"), { recursive: true });
    for (const m of MODULES) {
      await unlink(join(a, "app", `${m}.ts`));
      await writeFile(join(a, "app", "core", `${m}.ts`), source(m), "utf8");
    }
    const capA = await repoA.commitWorkingTree(a, { message: "relocate modules into app/core", actor: alice });
    assert.equal(capA.renamed.length, 5, "capture must see five moves, not five deletes and five creates");
    assert.deepEqual(
      capA.renamed.map((r) => `${r.from} -> ${r.to}`),
      MODULES.map((m) => `app/${m}.ts -> app/core/${m}.ts`),
    );

    // ── session B: edit every module, still at the OLD paths, knowing nothing of the move ──
    for (const m of MODULES) await writeFile(join(b, "app", `${m}.ts`), edited(m), "utf8");
    const capB = await repoB.commitWorkingTree(b, { message: "audit teardown paths", actor: bob });
    assert.deepEqual(capB.modified, MODULES.map((m) => `app/${m}.ts`));
    assert.deepEqual(capB.renamed, []);

    // ── converge ──
    await gossip(b, repoA);
    const res = await repoA.materialize();
    assert.equal(res.conflicts.length, 0, "a relocation and a concurrent edit of the relocated files must compose");
    assert.equal(res.fileConflicts.length, 0, "…and not as line conflicts either");

    const files = new Map((await repoA.materializedFiles(res)).map((f) => [f.path, f.content]));
    for (const m of MODULES) {
      assert.equal(files.get(`app/core/${m}.ts`), edited(m), `${m}: the edit must land at the NEW path`);
      assert.equal(files.has(`app/${m}.ts`), false, `${m}: the old path must be gone, not resurrected`);
    }
    assert.equal(files.size, 5, "five files in, five files out");
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("C20b: the same convergence in the other direction agrees byte for byte", async () => {
  // Whichever store does the merging must reach the same tree — the alias closure is a
  // function of the op set, not of who happened to pull whom.
  async function converge(direction: "A pulls B" | "B pulls A"): Promise<{ treeHash: string; paths: string[] }> {
    const a = await mkrepo();
    const b = await mkrepo();
    try {
      const repoA = await Repo.init(a);
      await mkdir(join(a, "app"), { recursive: true });
      for (const m of MODULES) await writeFile(join(a, "app", `${m}.ts`), source(m), "utf8");
      await repoA.commitWorkingTree(a, { message: "scaffold the app", actor: dev });
      const repoB = await cloneStore(a, b);
      await repoB.checkoutInto(b);

      await mkdir(join(a, "app", "core"), { recursive: true });
      for (const m of MODULES) {
        await unlink(join(a, "app", `${m}.ts`));
        await writeFile(join(a, "app", "core", `${m}.ts`), source(m), "utf8");
      }
      await repoA.commitWorkingTree(a, { message: "relocate", actor: alice });
      for (const m of MODULES) await writeFile(join(b, "app", `${m}.ts`), edited(m), "utf8");
      await repoB.commitWorkingTree(b, { message: "audit", actor: bob });

      const [into, from] = direction === "A pulls B" ? [repoA, b] : [repoB, a];
      await gossip(from, into);
      const res = await into.materialize();
      assert.equal(res.conflicts.length, 0, `${direction}: no conflicts`);
      return { treeHash: res.treeHash, paths: [...res.tree.keys()].sort() };
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  }
  const ab = await converge("A pulls B");
  const ba = await converge("B pulls A");
  assert.deepEqual(ab.paths, MODULES.map((m) => `app/core/${m}.ts`).sort());
  assert.deepEqual(ba.paths, ab.paths);
  assert.equal(ba.treeHash, ab.treeHash, "both replicas converge on the identical tree");
});

// ── C21 — backward compatibility (docs/19 §6 R1) ──
//
// The gate on rewriting the rename branch of `applyOp`. `MATERIALIZER_VERSION` is the
// determinism boundary for every replica and every stored snapshot, so a history with no
// moves in it has to hash exactly as it did before — otherwise the constant would have to
// be bumped, and that is not an implementer's call.
//
// The treeHash is recomputed here from the projected tree by the same definition the
// reducer uses (sha256 over the canonicalized, path-sorted path→blob map). That pins it to
// something independent of the rename code path rather than to a literal hash, which would
// break on any unrelated policy or merge-version change and prove nothing.
test("C21: a history with no moves hashes exactly as its projected tree defines", async () => {
  const dir = await mkrepo();
  try {
    const repo = await Repo.init(dir);
    const base = "one\ntwo\nthree\nfour\nfive\nsix\n";
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), base, "utf8");
    await writeFile(join(dir, "src", "b.ts"), base, "utf8");
    await writeFile(join(dir, "src", "gone.ts"), "bye\n", "utf8");
    await writeFile(join(dir, "notes.md"), "# notes\n", "utf8");
    await repo.commitWorkingTree(dir, { message: "scaffold", actor: dev });

    await writeFile(join(dir, "src", "a.ts"), base.replace("two", "two X"), "utf8");
    await unlink(join(dir, "src", "gone.ts"));
    const cap = await repo.commitWorkingTree(dir, { message: "edit and delete", actor: dev });
    assert.deepEqual(cap.renamed, [], "this history must contain no moves at all");

    const res = await repo.materialize();
    assert.equal(res.conflicts.length, 0);
    const expected = sha256hex(canonicalize(Object.fromEntries([...res.tree].sort())));
    assert.equal(res.treeHash, expected, "treeHash is still exactly the hash of the projected tree");
    assert.deepEqual([...res.tree.keys()].sort(), ["notes.md", "src/a.ts", "src/b.ts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("C21b: with no renames in the op set, materializing twice is bit-identical", async () => {
  // The alias map is empty here, so path resolution is the identity and every op applies at
  // the path it names. Any drift would mean the alias layer leaked into the rename-free path.
  const dir = await mkrepo();
  try {
    const repo = await Repo.init(dir);
    await mkdir(join(dir, "pkg"), { recursive: true });
    for (const m of MODULES) await writeFile(join(dir, "pkg", `${m}.ts`), source(m), "utf8");
    await repo.commitWorkingTree(dir, { message: "scaffold", actor: dev });
    for (const m of MODULES) await writeFile(join(dir, "pkg", `${m}.ts`), edited(m), "utf8");
    const cap = await repo.commitWorkingTree(dir, { message: "edit all", actor: alice });
    assert.deepEqual(cap.renamed, []);
    assert.deepEqual(cap.modified, MODULES.map((m) => `pkg/${m}.ts`));

    const first = await repo.materialize();
    const second = await repo.materialize();
    assert.equal(first.treeHash, second.treeHash);
    const files = new Map((await repo.materializedFiles(first)).map((f) => [f.path, f.content]));
    for (const m of MODULES) assert.equal(files.get(`pkg/${m}.ts`), edited(m));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
