// Issue #149 — the bridge `pre-commit` hook re-stages the canonical projection, and used to do
// it as a blanket `git add -A`. That is correct about the projection and wrong about the index:
// it also swept in every unstaged edit in the working tree, so a commit the author deliberately
// scoped to a subset of files silently became a commit of everything.
//
// git's contract is that the index selects what goes into a commit. After `avcs init` installs
// the hooks, that contract has to keep holding — otherwise `git add <path>`, `git add -p`, and
// any workflow that splits work into separate commits (stacked branches, one-file fixes) are
// silently broken, and `git status` comes back clean so nothing signals the widened scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

const avcs = (cwd: string, ...a: string[]) =>
  spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...a], { cwd, encoding: "utf8" });

/** A bridged repo: git worktree root + one commit + the five hooks installed. */
async function bridged(): Promise<{ dir: string; git: (...a: string[]) => string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-partial-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "dev");
  git("config", "commit.gpgsign", "false");
  const r = avcs(dir, "init", ".");
  assert.equal(r.status, 0, `avcs init should succeed\n${r.stderr}`);

  await writeFile(join(dir, "a.txt"), "a\n", "utf8");
  await writeFile(join(dir, "b.txt"), "b\n", "utf8");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return { dir, git };
}

/** Paths in a commit, sorted — `.avcs/` is excluded so the assertion is about the user's files. */
const committed = (git: (...a: string[]) => string, rev = "HEAD"): string[] =>
  git("show", "--name-only", "--format=", rev)
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith(".avcs/"))
    .sort();

test("pre-commit keeps a partial `git add` partial", { skip: !hasGit }, async () => {
  const { dir, git } = await bridged();

  // An edit the author is NOT ready to commit…
  await appendFile(join(dir, "b.txt"), "work in progress\n", "utf8");
  // …and one they are, staged explicitly.
  await writeFile(join(dir, "c.txt"), "c\n", "utf8");
  git("add", "c.txt");

  git("commit", "-qm", "c.txt only");

  assert.deepEqual(committed(git), ["c.txt"], "only the staged path is in the commit");
  assert.match(git("status", "--porcelain"), /b\.txt/, "the unstaged edit is still uncommitted");
});

test("pre-commit honors `git commit -a` — tracked edits in, untracked files out", { skip: !hasGit }, async () => {
  const { dir, git } = await bridged();

  await appendFile(join(dir, "b.txt"), "more\n", "utf8"); // tracked: -a stages it
  await writeFile(join(dir, "c.txt"), "c\n", "utf8");     // untracked: -a does NOT

  git("commit", "-aqm", "all tracked edits");

  assert.deepEqual(committed(git), ["b.txt"], "-a means tracked edits, not untracked files");
  assert.match(git("status", "--porcelain"), /\?\? c\.txt/, "the untracked file stays untracked");
});

test("pre-commit stages a deletion that was staged, and leaves an unstaged one alone", { skip: !hasGit }, async () => {
  const { dir, git } = await bridged();

  git("rm", "-q", "a.txt");          // staged deletion
  await appendFile(join(dir, "b.txt"), "wip\n", "utf8"); // unstaged edit

  git("commit", "-qm", "drop a.txt");

  assert.deepEqual(committed(git), ["a.txt"], "the staged deletion is the whole commit");
  assert.match(git("status", "--porcelain"), /b\.txt/, "the unstaged edit survives");
});
