// `avcs init .` in a directory that already has files succeeds — and then goes silent
// (issue #116). The repo starts empty (`files: 0`), and nothing names the next step,
// `avcs import .`. A first-time user has to discover it from `avcs help`, while the
// CLI's other copy (`land` without an actor, `sync` without a remote) always names the
// fix. So init should notice the untracked files and say so, in that same style.
//
// The count must mirror what `import` would actually capture: `.avcs`/`.git` are never
// files-to-import, and gitignored paths are filtered by the same predicate `import` uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

const run = (cwd: string, ...a: string[]) =>
  spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...a], { cwd, encoding: "utf8" });

const mkdir_ = () => mkdtemp(join(tmpdir(), "avcs-hint-"));

test("init in a non-empty directory counts the untracked files and names `avcs import`", async () => {
  const dir = await mkdir_();
  try {
    await writeFile(join(dir, "a.txt"), "hello\n", "utf8");
    await writeFile(join(dir, "b.txt"), "world\n", "utf8");

    const r = run(dir, "init", ".");

    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr.trim(), "", "a hint is guidance, not an error");
    assert.match(r.stdout, /initialized AVCS repo/);
    assert.match(
      r.stdout,
      /2 file\(s\) present in the working tree are not yet tracked/,
      "init should notice the existing files instead of leaving `status` to show files: 0 unexplained",
    );
    assert.match(
      r.stdout,
      /avcs import \. -m "initial import"/,
      "like `land` without an actor or `sync` without a remote, the copy must name the exact fix",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init in an empty directory stays quiet — there is nothing to import", async () => {
  const dir = await mkdir_();
  try {
    const r = run(dir, "init", ".");

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /initialized AVCS repo/);
    assert.doesNotMatch(r.stdout, /not yet tracked/, "no files, no hint — the empty case was never broken");
    assert.doesNotMatch(r.stdout, /avcs import/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the hint counts what `import` would capture: gitignored files and .git/ excluded", { skip: !hasGit }, async () => {
  const dir = await mkdir_();
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: dir, stdio: "ignore" });
    await writeFile(join(dir, "a.txt"), "hello\n", "utf8");
    await writeFile(join(dir, ".gitignore"), "dist/\n", "utf8");
    await mkdir(join(dir, "dist"));
    await writeFile(join(dir, "dist", "bundle.js"), "js\n", "utf8");

    const r = run(dir, "init", ".");

    assert.equal(r.status, 0, r.stderr);
    // a.txt + .gitignore (which IS captured — it's code), but not dist/bundle.js and
    // nothing from .git/. A count inflated by build output would teach users to
    // distrust the hint on their first command.
    assert.match(r.stdout, /2 file\(s\) present in the working tree are not yet tracked/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
