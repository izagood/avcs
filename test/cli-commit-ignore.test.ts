// `avcs commit` inside a git work tree must respect `.gitignore` the way the git-bridge hook
// (#10) and `avcs import` (#48) already do (issue #180). It did not: `commitWorkingTree` was
// called without an `ignorePredicate`, so the same tree captured very differently depending on
// which command you reached for — `avcs commit -m x` next to a `node_modules/` pulled all of it
// into history, twice in one repo, and the second time the hook was timing out on the first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Repo } from "../src/api/repo.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

const run = (cwd: string, ...a: string[]) =>
  spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...a], { cwd, encoding: "utf8" });
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

/** A git work tree whose .gitignore excludes node_modules/, holding one ignored and one real file. */
async function gitTreeWithIgnored(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-commit-ignore-"));
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, ".gitignore"), "node_modules/\n");
  await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  await writeFile(join(dir, "src.txt"), "real\n");
  return dir;
}

test("avcs commit respects .gitignore inside a git work tree — node_modules/ is not captured", { skip: !hasGit }, async () => {
  const dir = await gitTreeWithIgnored();
  try {
    assert.equal(run(dir, "init", ".", "--no-hooks").status, 0);
    const r = run(dir, "commit", "-m", "first");
    assert.equal(r.status, 0, r.stderr);

    const repo = await Repo.open(dir);
    const files = [...(await repo.materialize("main")).tree.keys()].sort();
    assert.deepEqual(files, [".gitignore", "src.txt"], `node_modules/ must be ignored like the hook and import do — got ${files.join(", ")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("avcs commit and avcs import capture the same tree from the same directory", { skip: !hasGit }, async () => {
  const dir = await gitTreeWithIgnored();
  const other = await mkdtemp(join(tmpdir(), "avcs-commit-ignore-import-"));
  try {
    assert.equal(run(dir, "init", ".", "--no-hooks").status, 0);
    assert.equal(run(dir, "commit", "-m", "via commit").status, 0);
    const viaCommit = [...(await (await Repo.open(dir)).materialize("main")).tree.keys()].sort();

    assert.equal(run(other, "init", ".", "--no-hooks").status, 0);
    assert.equal(run(other, "import", dir, "-m", "via import").status, 0);
    const viaImport = [...(await (await Repo.open(other)).materialize("main")).tree.keys()].sort();

    assert.deepEqual(viaCommit, viaImport, "two commands over one commitWorkingTree must not disagree about what a tree contains");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("a git work tree whose git cannot be run says so instead of silently ignoring nothing", { skip: !hasGit }, async () => {
  const dir = await gitTreeWithIgnored();
  try {
    assert.equal(run(dir, "init", ".", "--no-hooks").status, 0);
    // A PATH with no git on it — what an IDE- or agent-spawned process can inherit. node is
    // reached by absolute path, so only git disappears.
    const r = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "commit", "-m", "blind"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /git work tree but `git` could not be run/, "the degradation must be named, not silent");
    assert.match(r.stderr, /\.gitignore is NOT applied/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("outside git, avcs commit still uses only .avcsignore — no git, no gitignore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-commit-nogit-"));
  try {
    await writeFile(join(dir, ".gitignore"), "vendor/\n"); // present but meaningless without git
    await mkdir(join(dir, "vendor"), { recursive: true });
    await writeFile(join(dir, "vendor", "x.txt"), "v\n");
    await writeFile(join(dir, "src.txt"), "real\n");
    assert.equal(run(dir, "init", ".", "--no-hooks").status, 0);
    const r = run(dir, "commit", "-m", "first");
    assert.equal(r.status, 0, r.stderr);
    const files = [...(await (await Repo.open(dir)).materialize("main")).tree.keys()].sort();
    assert.deepEqual(files, [".gitignore", "src.txt", "vendor/x.txt"], "without git the .gitignore file is just a file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
