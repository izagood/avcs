// `avcs import` / commitWorkingTree with a RELATIVE source directory (issue #48).
//
// The walker derived each stored path by slicing a fixed prefix length off an absolute
// one — `join(dir, name).slice(workDir.length + 1)`. Node's `join` normalises, so
// `join(".", "src")` is "src", not "./src"; with workDir "." the slice removes two real
// characters and `src/a.ts` is stored as `c/a.ts`.
//
// Nothing errors. The op count looks right. The damage only shows later, when
// `file:src/a.ts` has no history because the op was recorded under `file:c/a.ts` — which
// reads as data loss rather than a path bug.
//
// It also defeats the exclusion guards: `.git/HEAD` becomes `it/HEAD`, so the
// `rel.startsWith(".git/")` check no longer matches and git's own directory gets captured.
// One defect manufacturing another is why the fix belongs at the path derivation, not at
// the filters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";

const human = { kind: "human", id: "human:h" } as const;

/** A repo whose working tree holds src/a.ts, top.txt and a junk dir. */
async function tree(): Promise<{ repo: Repo; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-imp-"));
  const repo = await Repo.init(dir);
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "real\n", "utf8");
  await writeFile(join(dir, "top.txt"), "top\n", "utf8");
  await writeFile(join(dir, "node_modules", "pkg", "index.js"), "junk\n", "utf8");
  return { repo, dir };
}

async function pathsIn(repo: Repo): Promise<string[]> {
  const res = await repo.materialize("main");
  return [...res.tree.keys()].sort();
}

test("a relative source directory stores the same paths as an absolute one", async () => {
  const { repo, dir } = await tree();
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    await repo.commitWorkingTree(".", { message: "rel", actor: human });
    assert.deepEqual(await pathsIn(repo), ["node_modules/pkg/index.js", "src/a.ts", "top.txt"]);
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an absolute source directory is unchanged by the fix", async () => {
  const { repo, dir } = await tree();
  try {
    await repo.commitWorkingTree(dir, { message: "abs", actor: human });
    assert.deepEqual(await pathsIn(repo), ["node_modules/pkg/index.js", "src/a.ts", "top.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a trailing slash on the source does not shift the paths either", async () => {
  const { repo, dir } = await tree();
  try {
    await repo.commitWorkingTree(`${dir}/`, { message: "slash", actor: human });
    assert.ok((await pathsIn(repo)).includes("src/a.ts"), `got ${JSON.stringify(await pathsIn(repo))}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the exclusion guards still bite when the source is relative", async () => {
  // `.git/` and `.avcs/` are skipped by name; a shifted path slipped past those checks and
  // pulled git's own directory into history.
  const { repo, dir } = await tree();
  const cwd = process.cwd();
  try {
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    process.chdir(dir);
    await repo.commitWorkingTree(".", { message: "rel", actor: human });
    const paths = await pathsIn(repo);
    assert.ok(!paths.some((p) => p.includes("HEAD")), `git internals excluded, got ${JSON.stringify(paths)}`);
    assert.ok(!paths.some((p) => p.startsWith(".avcs")), "avcs's own store is excluded");
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an ignore predicate prunes an ignored directory", async () => {
  const { repo, dir } = await tree();
  try {
    await repo.commitWorkingTree(dir, {
      message: "filtered",
      actor: human,
      ignorePredicate: (rel) => rel === "node_modules" || rel.startsWith("node_modules/"),
    });
    assert.deepEqual(await pathsIn(repo), ["src/a.ts", "top.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("import applies the repo's ignore rules, so node_modules never enters history", async () => {
  // `git-sync` passed an ignore predicate and `import` did not, so the same tree captured
  // very differently depending on which command the caller reached for.
  const { repo, dir } = await tree();
  try {
    await writeFile(join(dir, ".avcsignore"), "node_modules/\n", "utf8");
    await repo.commitWorkingTree(dir, { message: "ignored", actor: human });
    const paths = await pathsIn(repo);
    assert.ok(!paths.some((p) => p.startsWith("node_modules")), `got ${JSON.stringify(paths)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
