// A topic branch's fork point is trunk's work and belongs to base (issue #178). When trunk has
// advanced outside avcs — merges made on the forge, a main checkout parked on another branch —
// a worktree checked out at that newer trunk used to see trunk's advance as its own delta and
// author all of it as workspace ops. The capture now brings base up to the merge-base first,
// from git's own objects, and links it; the branch diff is then the branch's own changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Repo } from "../src/api/repo.ts";
import { catchUpTrunk } from "../src/git/trunkCatchUp.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const dev = { kind: "human" as const, id: "human:dev" };

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
const avcs = (cwd: string, ...a: string[]) =>
  spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...a], { cwd, encoding: "utf8", env: { ...process.env, AVCS_HOOK_TIMEOUT_MS: "0" } });

/** A git repo on `main` with an avcs store (no hooks), base captured at commit c1. */
async function trunkRepo(): Promise<{ main: string; repo: Repo; c1: string }> {
  const main = await mkdtemp(join(tmpdir(), "avcs-catchup-"));
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  const repo = await Repo.init(main);
  // What `avcs init` arranges in a git repo: the sidecar store stays out of git, or a
  // `git worktree add` would check a `.avcs/` directory out into the new tree.
  await writeFile(join(main, ".gitignore"), ".avcs/\n");
  await writeFile(join(main, "base.ts"), "export const base = 1\n");
  git(main, "add", "-A");
  git(main, "commit", "-qm", "c1: base");
  const c1 = git(main, "rev-parse", "HEAD");
  // Base captured at c1, and linked — what a hook-driven trunk commit leaves behind.
  const s = await repo.gitSync({ message: "c1: base", actor: dev, workDir: main });
  await repo.recordGitCommit(c1, s.checkpoint!);
  return { main, repo, c1 };
}

/** Advance trunk OUTSIDE avcs: a plain git commit, nothing captured. */
async function advanceTrunkOutsideAvcs(main: string): Promise<string> {
  await writeFile(join(main, "trunk.ts"), "export const trunk = 2\n");
  git(main, "add", "-A");
  git(main, "commit", "-qm", "c2: trunk moved on the forge");
  return git(main, "rev-parse", "HEAD");
}

/** The view's files, minus the fixture's own `.gitignore` — the assertions are about code. */
const files = async (repo: Repo, workspace?: string) =>
  [...(await repo.materialize("main", workspace ? { workspace } : undefined)).tree.keys()].filter((p) => p !== ".gitignore").sort();

test("a worktree at a trunk commit base has not seen: base catches up first, the branch captures only its own change", { skip: !hasGit }, async () => {
  const { main, c1 } = await trunkRepo();
  let wt = "";
  try {
    const c2 = await advanceTrunkOutsideAvcs(main);
    wt = join(main, "..", `wt-${Date.now()}`);
    git(main, "worktree", "add", "-q", "-b", "feature", wt); // forks at c2, which base does not know
    // What the post-checkout hook does on `git worktree add`: point the tree at the one store.
    const att = avcs(wt, "worktree", "attach", "--to", main);
    assert.equal(att.status, 0, `${att.stdout}${att.stderr}`);
    await writeFile(join(wt, "feat.ts"), "export const feat = 3\n");

    const r = avcs(wt, "commit", "-m", "feat work", "--author", dev.id);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /base caught up to trunk/, "the catch-up is named, once");

    const repo = await Repo.open(main);
    assert.deepEqual(await files(repo), ["base.ts", "trunk.ts"], "base now holds trunk's advance");
    assert.ok(await repo.gitCheckpoint(c2), "the fork point is linked, so the next capture skips the catch-up");
    assert.ok(await repo.gitCheckpoint(c1));
    assert.deepEqual(await files(repo, "feature"), ["base.ts", "feat.ts", "trunk.ts"]);

    // The decisive assertion: the workspace holds ONLY the branch's own op.
    const ws = await repo.materialize("main", { workspace: "feature" });
    const wsOps: string[] = [];
    for (const oid of ws.statuses.keys()) { const op = (await repo.store.get(oid)) as { workspace?: string; body: { path?: string } }; if (op.workspace === "feature") wsOps.push(op.body.path ?? ""); }
    assert.deepEqual(wsOps, ["feat.ts"], "trunk.ts must not be attributed to the branch");
  } finally {
    if (wt) { try { git(main, "worktree", "remove", "--force", wt); } catch { /* best effort */ } }
    await rm(main, { recursive: true, force: true });
  }
});

test("base already level with the fork point: nothing is captured to base", { skip: !hasGit }, async () => {
  const { main, repo } = await trunkRepo();
  let wt = "";
  try {
    wt = join(main, "..", `wt-${Date.now()}`);
    git(main, "worktree", "add", "-q", "-b", "feature", wt); // forks at c1, which base knows
    const before = (await repo.materialize("main")).statuses.size;
    const r = await catchUpTrunk(await Repo.open(main), wt, { workspace: "feature" }, dev);
    assert.deepEqual(r, { skipped: "base-has-it" });
    assert.equal((await (await Repo.open(main)).materialize("main")).statuses.size, before);
  } finally {
    if (wt) { try { git(main, "worktree", "remove", "--force", wt); } catch { /* best effort */ } }
    await rm(main, { recursive: true, force: true });
  }
});

test("base AHEAD of the fork point (trunk pulled past where the branch forked): never rolled back", { skip: !hasGit }, async () => {
  const { main, c1 } = await trunkRepo();
  let wt = "";
  try {
    // Fork at c1 (known), then trunk advances to c2 and base captures it (a hook would).
    wt = join(main, "..", `wt-${Date.now()}`);
    git(main, "worktree", "add", "-q", "-b", "feature", wt);
    const c2 = await advanceTrunkOutsideAvcs(main);
    const repo = await Repo.open(main);
    const s = await repo.gitSync({ message: "c2", actor: dev, workDir: main });
    await repo.recordGitCommit(c2, s.checkpoint!);
    assert.deepEqual(await files(repo), ["base.ts", "trunk.ts"]);

    // The branch's merge-base is c1; base knows c1 too, so nothing to do — and even if the
    // c1 link were missing, c2's link would say base is ahead.
    assert.deepEqual(await catchUpTrunk(repo, wt, { workspace: "feature" }, dev), { skipped: "base-has-it" });
    await repo.store.setRef(`git:${c1}`, "checkpoint_" + "0".repeat(32)); // pretend the c1 link is gone/foreign
    // (a bogus link still counts as "has it"; drop it entirely to exercise the ahead-guard)
    const r = await catchUpTrunk(repo, wt, { workspace: "feature" }, dev);
    assert.ok("skipped" in r && (r.skipped === "base-has-it" || r.skipped === "base-ahead"));
    assert.deepEqual(await files(repo), ["base.ts", "trunk.ts"], "base was not rolled back to c1's tree");
  } finally {
    if (wt) { try { git(main, "worktree", "remove", "--force", wt); } catch { /* best effort */ } }
    await rm(main, { recursive: true, force: true });
  }
});

test("outside a workspace scope (trunk itself, a line) the catch-up is a no-op", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-catchup-nows-"));
  try {
    const repo = await Repo.init(dir);
    assert.deepEqual(await catchUpTrunk(repo, dir, {}, dev), { skipped: "not-a-workspace" });
    assert.deepEqual(await catchUpTrunk(repo, dir, { line: "x" }, dev), { skipped: "not-a-workspace" });
    assert.ok(!existsSync(join(dir, "nothing")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
