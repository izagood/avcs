// Issue #133 — `avcs init` in a SUBDIRECTORY of a git repo used to install the bridge hooks
// into the OUTER repo's `.git/hooks`, which then broke every commit in that repo.
//
// Two searches both go UPWARD and only one of them can win:
//   - `git rev-parse --git-path hooks` (run at init time, cwd = the target dir) ascends to the
//     nearest `.git` — the outer repo's.
//   - the installed hook later resolves its store by ascending from the commit's cwd (the outer
//     root) looking for `.avcs` — which sits one level DOWN, so it is never found.
// The mismatch is permanent, and the symptom (`error: not an AVCS repo: <outer>`) shows up long
// after the init that caused it. Fixed on both ends: install only at the worktree root, and let
// a hook that cannot find a store fall through instead of aborting git.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

const run = (cwd: string, ...a: string[]) =>
  spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...a], { cwd, encoding: "utf8" });

const HOOKS = ["pre-commit", "prepare-commit-msg", "post-commit", "post-merge", "post-checkout"];

/** A git repo with one commit and an identity, so `git commit` works unattended. */
async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-hookscope-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "dev");
  git("config", "commit.gpgsign", "false");
  await writeFile(join(dir, "a.txt"), "x\n", "utf8");
  git("add", ".");
  git("commit", "-qm", "initial");
  return dir;
}

test("init below the git root does not touch the outer repo's hooks", { skip: !hasGit }, async () => {
  const outer = await gitRepo();
  try {
    const sandbox = join(outer, "sandbox");
    await mkdir(sandbox, { recursive: true });

    const r = run(sandbox, "init", ".");
    assert.equal(r.status, 0, `init should succeed\n${r.stderr}`);

    // The store belongs to the subdirectory…
    assert.ok(existsSync(join(sandbox, ".avcs")), "store created in the target dir");
    // …and nothing was written outside it.
    for (const h of HOOKS) {
      assert.ok(
        !existsSync(join(outer, ".git", "hooks", h)),
        `init in a subdirectory must not install ${h} into the outer repo`,
      );
    }
    // The skip is announced, and it names both the repo it declined to bridge and the way out.
    assert.match(r.stdout, /hook/i, "init says why no hooks were installed");
    assert.match(r.stdout, /install-hooks/, "init names the command that installs them anyway");

    // The outer repo still commits — the actual regression this issue reports.
    await writeFile(join(outer, "a.txt"), "y\n", "utf8");
    const c = spawnSync("git", ["commit", "-qam", "anything"], { cwd: outer, encoding: "utf8" });
    assert.equal(c.status, 0, `the outer repo must still be able to commit\n${c.stderr}`);
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test("init at the git root still installs the bridge hooks", { skip: !hasGit }, async () => {
  const dir = await gitRepo();
  try {
    const r = run(dir, "init", ".");
    assert.equal(r.status, 0, `init should succeed\n${r.stderr}`);
    assert.match(r.stdout, /installed git hooks/, "the normal path still installs");
    for (const h of HOOKS) {
      const p = join(dir, ".git", "hooks", h);
      assert.ok(existsSync(p), `${h} installed at the git root`);
      assert.match(readFileSync(p, "utf8"), /avcs-git-bridge-hook/, `${h} is the AVCS hook`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hook that cannot find a store lets git through instead of blocking it", { skip: !hasGit }, async () => {
  const dir = await gitRepo();
  try {
    assert.equal(run(dir, "init", ".").status, 0);
    assert.ok(existsSync(join(dir, ".git", "hooks", "pre-commit")), "hooks are in place");
    // The state issue #133 leaves behind: hooks installed by an older version, no store for
    // them to talk to. (Reproduced by removing the store; the hooks are untouched.)
    await rm(join(dir, ".avcs"), { recursive: true, force: true });

    const h = run(dir, "git-hook", "pre-commit");
    assert.equal(h.status, 0, `a store-less hook must exit 0, not abort git\n${h.stderr}`);

    // …and end to end: the repo commits again.
    await writeFile(join(dir, "a.txt"), "y\n", "utf8");
    const c = spawnSync("git", ["commit", "-qam", "anything"], { cwd: dir, encoding: "utf8" });
    assert.equal(c.status, 0, `commit must go through with no AVCS repo present\n${c.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an open conflict still aborts the commit — fail-open covers only a missing store", { skip: !hasGit }, async () => {
  // The fail-open above must stay narrow. docs/14: "열린(needs-human) 충돌이 있으면 pre-commit이
  // 커밋을 중단한다." Two concurrent, overlapping edits to the same line region mint exactly
  // such a conflict; the hook has to keep exiting non-zero on it.
  const root = await mkdtemp(join(tmpdir(), "avcs-hookscope-conflict-"));
  try {
    const alice = join(root, "alice");
    const bob = await gitRepo(); // bob's tree is the git repo the hooks bridge

    run(root, "init", alice);
    await writeFile(join(alice, "f.txt"), "a\nb\nc\n", "utf8");
    run(alice, "commit", "-m", "seed", "--author", "human:alice");

    assert.equal(run(bob, "init", ".").status, 0);
    run(bob, "pull", alice);
    run(bob, "checkout");

    await writeFile(join(alice, "f.txt"), "a\nb-alice\nc\n", "utf8");
    run(alice, "commit", "-m", "alice rewords line 2", "--author", "human:alice");
    await writeFile(join(bob, "f.txt"), "a\nb-bob\nc\n", "utf8");
    run(bob, "commit", "-m", "bob rewords line 2", "--author", "human:bob");
    run(bob, "pull", alice);
    // Reproject, then edit something else: the conflict has to still be OPEN when the hook
    // runs. (Re-editing f.txt would be the human resolving it — a new op supersedes both, and
    // the gate would then rightly let the commit through.)
    run(bob, "checkout");
    await writeFile(join(bob, "g.txt"), "unrelated\n", "utf8");

    assert.match(run(bob, "conflicts").stdout, /needs_human/, "the scene really is conflicted");

    const h = run(bob, "git-hook", "pre-commit");
    assert.equal(h.status, 1, `an open conflict must still abort the commit\n${h.stdout}${h.stderr}`);
    assert.match(h.stderr, /open conflict/, "and it names `avcs conflicts` as the way out");
    await rm(bob, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
