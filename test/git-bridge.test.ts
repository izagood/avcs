// PR-A — AVCS ↔ Git bridge: git modes, reindex, and the git-sync round trip (docs/14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const dev: Actor = { kind: "human", id: "human:dev" };
const mkrepo = () => mkdtemp(join(tmpdir(), "avcs-git-"));

test("init defaults to sidecar mode and ignores all of .avcs/", async () => {
  const dir = await mkrepo();
  const repo = await Repo.init(dir);
  await repo.setGitMode("sidecar"); // what `avcs init` does
  assert.equal(await repo.getGitMode(), "sidecar");
  const gi = await readFile(join(dir, ".avcs", ".gitignore"), "utf8");
  assert.match(gi, /^\*$/m, "sidecar ignores everything under .avcs/");
});

test("setGitMode('committed') tracks objects/refs but ignores rebuildable caches", async () => {
  const dir = await mkrepo();
  const repo = await Repo.init(dir);
  await repo.setGitMode("committed");
  assert.equal(await repo.getGitMode(), "committed");
  const gi = await readFile(join(dir, ".avcs", ".gitignore"), "utf8");
  // caches & local state are ignored…
  for (const ig of ["/indexes/", "/snapshot/", "/locks/", "/oplog", "/objlog"]) {
    assert.ok(gi.includes(ig), `committed mode ignores ${ig}`);
  }
  // …but objects/refs are NOT (no `*` blanket).
  assert.ok(!/^\*$/m.test(gi), "committed mode does not blanket-ignore .avcs/");
});

test("git mode survives a re-open (persisted in .avcs/config.json) and defaults safe", async () => {
  const dir = await mkrepo();
  const repo = await Repo.init(dir);
  await repo.setGitMode("committed");
  const reopened = await Repo.open(dir);
  assert.equal(await reopened.getGitMode(), "committed");

  // A repo created before this feature (no config.json) defaults to sidecar.
  const legacy = await mkrepo();
  const lrepo = await Repo.init(legacy);
  await rm(join(legacy, ".avcs", "config.json"), { force: true });
  assert.equal(await (await Repo.open(legacy)).getGitMode(), "sidecar");
});

test("git-sync captures edits, checkpoints, reprojects, and ensures a .gitignore", async () => {
  const dir = await mkrepo();
  const repo = await Repo.init(dir);
  await repo.setGitMode("sidecar");

  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/app.ts"), "export const v = 1\n", "utf8");
  await writeFile(join(dir, "README.md"), "# hi\n", "utf8");

  const r = await repo.gitSync({ message: "init", actor: dev });
  assert.equal(r.mode, "sidecar");
  assert.deepEqual(r.captured.added, ["README.md", "src/app.ts"]);
  assert.equal(r.captured.ops.length, 2);
  assert.equal(r.conflicts.length, 0);
  assert.ok(r.checkpoint, "a checkpoint was created");
  assert.ok(r.treeHash, "a treeHash was returned");

  // The working tree is now exactly the materialized projection.
  const files = (await repo.materializedFiles(await repo.materialize())).map((f) => f.path).sort();
  assert.deepEqual(files, ["README.md", "src/app.ts"]);
  assert.ok(existsSync(join(dir, ".avcs", ".gitignore")), "gitignore ensured");

  // A no-op second sync captures nothing and stays clean.
  const r2 = await repo.gitSync({ message: "noop", actor: dev });
  assert.equal(r2.captured.ops.length, 0);
  assert.equal(r2.conflicts.length, 0);
});

test("provenance: trailer + back-link round-trip, and checkpointFiles verifies the projection", async () => {
  const dir = await mkrepo();
  const repo = await Repo.init(dir);
  await repo.setGitMode("sidecar");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/app.ts"), "export const v = 1\n", "utf8");
  const r = await repo.gitSync({ message: "init", actor: dev });

  // trailer is a well-formed block linking checkpoint + treeHash.
  const trailer = repo.gitTrailer({ checkpoint: r.checkpoint!, treeHash: r.treeHash!, intent: r.captured.intent });
  assert.match(trailer, new RegExp(`AVCS-Checkpoint: ${r.checkpoint}`));
  assert.match(trailer, new RegExp(`AVCS-TreeHash: ${r.treeHash}`));

  // avcs→git back-link round-trips through a ref.
  const fakeSha = "0123456789abcdef0123456789abcdef01234567";
  await repo.recordGitCommit(fakeSha, r.checkpoint!);
  assert.equal(await repo.gitCheckpoint(fakeSha), r.checkpoint);
  assert.equal(await repo.gitCheckpoint("deadbeef"), null);

  // checkpointFiles reproduces the exact projection the checkpoint froze.
  const cf = await repo.checkpointFiles(r.checkpoint!);
  assert.equal(cf.treeHashOk, true, "recorded treeHash still reproduces from the frontier");
  assert.deepEqual(cf.files.map((f) => f.path).sort(), ["src/app.ts"]);
  assert.equal(cf.files.find((f) => f.path === "src/app.ts")?.content, "export const v = 1\n");
});

test("trailer can be disabled via config; defaults on", async () => {
  const dir = await mkrepo();
  const repo = await Repo.init(dir);
  assert.equal(await repo.gitTrailerEnabled(), true);
  await repo.store.writeAux("config.json", JSON.stringify({ gitMode: "sidecar", trailer: false }) + "\n");
  assert.equal(await (await Repo.open(dir)).gitTrailerEnabled(), false);
});

test("committed mode also writes a .avcs/.gitattributes (objects off the merge path)", async () => {
  const dir = await mkrepo();
  const repo = await Repo.init(dir);
  await repo.setGitMode("committed");
  const ga = await readFile(join(dir, ".avcs", ".gitattributes"), "utf8");
  assert.match(ga, /objects\/\*\* -diff -merge/);
});

test("convergence: objects arriving out-of-band (a git pull) + reindex reproject identically", async () => {
  // Repo A authors its first op.
  const a = await mkrepo();
  const repoA = await Repo.init(a);
  await repoA.setGitMode("committed");
  await mkdir(join(a, "src"), { recursive: true });
  await writeFile(join(a, "src/a.ts"), "export const a = 1\n", "utf8");
  await repoA.commitWorkingTree(a, { message: "a", actor: dev });
  const hash1 = (await repoA.materialize()).treeHash;

  // Repo B is a CLONE of A (shares A's exact objects — not an independent author), and
  // materializes once, which FREEZES its op-log at one op.
  const b = await mkrepo();
  await rm(join(b, ".avcs"), { recursive: true, force: true });
  await cp(join(a, ".avcs"), join(b, ".avcs"), { recursive: true });
  const repoBclone = await Repo.open(b);
  assert.equal((await repoBclone.materialize()).treeHash, hash1, "clone matches A");

  // A advances with a SECOND op.
  await writeFile(join(a, "src/b.ts"), "export const b = 2\n", "utf8");
  await repoA.commitWorkingTree(a, { message: "b", actor: dev });
  const hashA = (await repoA.materialize()).treeHash;
  assert.notEqual(hashA, hash1);

  // The git-pull effect: A's object files land in B's store, but B's git-ignored op-log is
  // untouched, so a bare re-materialize STILL misses the pulled op (the stale-log bug).
  await cp(join(a, ".avcs", "objects"), join(b, ".avcs", "objects"), { recursive: true });
  const repoBstale = await Repo.open(b);
  assert.equal((await repoBstale.materialize()).treeHash, hash1, "stale op-log misses the pulled op");

  // The post-merge recovery — reindex (rebuilds the op-log) THEN reproject — converges B to A.
  const repoB = await Repo.open(b);
  await repoB.reindex();
  assert.equal((await repoB.materialize()).treeHash, hashA, "after reindex B converges to A");
  const files = (await repoB.materializedFiles(await repoB.materialize())).map((f) => f.path).sort();
  assert.deepEqual(files, ["src/a.ts", "src/b.ts"]);
});

test("reindex rebuilds the entity index from scratch and is idempotent", async () => {
  const dir = await mkrepo();
  const repo = await Repo.init(dir);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/a.ts"), "export const a = 1\n", "utf8");
  await writeFile(join(dir, "src/b.ts"), "export const b = 1\n", "utf8");
  await repo.commitWorkingTree(dir, { message: "two files", actor: dev });

  // Wipe the index the way a fresh git-pull'd checkout would have none, then rebuild.
  await rm(join(dir, ".avcs", "indexes"), { recursive: true, force: true });
  const r1 = await repo.reindex();
  assert.equal(r1.ops, 2, "indexed both file ops");

  // Idempotent: a second reindex produces the same count and a still-correct tree.
  const r2 = await repo.reindex();
  assert.equal(r2.ops, 2);
  const files = (await repo.materializedFiles(await repo.materialize())).map((f) => f.path).sort();
  assert.deepEqual(files, ["src/a.ts", "src/b.ts"]);
});
