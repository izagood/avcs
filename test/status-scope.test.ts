// `avcs status` and the scope it reports (issue #87).
//
// Topic branches map to workspaces (docs/20), so a session on one authors workspace-tagged
// ops that the base view deliberately excludes. `status` read the base view regardless, which
// meant it described a scope the user was not working in: their own work was invisible, and
// the head it named was not the head their next capture would build on.
//
// `conflicts` had the same shape and was already routed through `scopeFor` — there the
// mismatch was actively misleading, because `git-sync` refuses to stage a conflicted tree and
// points at `avcs conflicts`, which would then answer "no open conflicts". `status` has no
// such contradictory hand-off, which is why it was left alone at the time rather than
// widening an already-verified change. This closes it.
//
// The resolution logic is not new: `scopeForBranch` is a pure function and `scopeFor` wraps
// it with the one git call. This is about routing `status` through the same path and saying
// which scope the numbers belong to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const hasGit = (() => {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const human: Actor = { kind: "human", id: "human:h" };

/** Run the CLI in `cwd`, returning stdout+stderr together. */
function cli(cwd: string, ...a: string[]): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", CLI, ...a], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
}

function git(dir: string, ...a: string[]): string {
  // `-b main` pins the branch name: `git init` takes it from `init.defaultBranch`, a machine
  // setting, and these tests read branch names back.
  return execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** A bridged repo with one file committed on `main`. */
async function bridged(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-87-"));
  git(dir, "init", "-q", "-b", "main", ".");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  await writeFile(join(dir, "a.ts"), "export const a = 1\n", "utf8");
  cli(dir, "init", ".");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "feat: a");
  return dir;
}

test("status names the scope it is reporting", { skip: !hasGit }, async () => {
  const dir = await bridged();
  try {
    // On the trunk there is no workspace, and saying so is still worth a line: the numbers
    // below it are otherwise unattributed.
    const out = cli(dir, "status");
    assert.match(out, /base view/, `the scope must be named:\n${out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("on a topic branch, status reports that WORKSPACE, not the base view", { skip: !hasGit }, async () => {
  const dir = await bridged();
  try {
    git(dir, "checkout", "-q", "-b", "feature/x");
    await writeFile(join(dir, "b.ts"), "export const b = 2\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "feat: b");

    const out = cli(dir, "status");

    // The label first — an unlabelled report is what made this ambiguous to begin with.
    assert.match(out, /workspace/, `the workspace must be named:\n${out}`);
    assert.match(out, /feature\/x/, `and identified:\n${out}`);

    // …and the numbers must be the workspace's. The base view has one file; this branch's
    // capture added a second, which the base view deliberately excludes.
    const files = /files:\s*(\d+)/.exec(out)?.[1];
    assert.equal(files, "2", `status must count the work on this branch:\n${out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the base view is unchanged by the branch's work — the reason this matters", { skip: !hasGit }, async () => {
  const dir = await bridged();
  try {
    git(dir, "checkout", "-q", "-b", "feature/y");
    await writeFile(join(dir, "c.ts"), "export const c = 3\n", "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "feat: c");

    // Asking for the base view explicitly still answers about the base view: one file.
    const base = cli(dir, "status", "main");
    assert.equal(/files:\s*(\d+)/.exec(base)?.[1], "1", `explicit view must win:\n${base}`);

    // So the two answers differ, which is exactly the confusion #87 describes: without the
    // routing, the second number was the only one `status` ever gave.
    const scoped = cli(dir, "status");
    assert.notEqual(
      /files:\s*(\d+)/.exec(scoped)?.[1],
      /files:\s*(\d+)/.exec(base)?.[1],
      "the workspace and the base view must be distinguishable from status alone",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an explicit view argument still wins over the branch", { skip: !hasGit }, async () => {
  const dir = await bridged();
  try {
    git(dir, "checkout", "-q", "-b", "feature/z");
    const out = cli(dir, "status", "main");
    assert.match(out, /view: main/, `the named view must be honoured:\n${out}`);
    assert.doesNotMatch(out, /workspace feature\/z/, `and not silently redirected:\n${out}`);
    // …and named correctly: `main` is the base view, not a line.
    assert.match(out, /scope: base view/, `explicit main is the base view:\n${out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Standalone is the primary shape (docs/16 §2-1). A repo with no git must not grow output,
// and must certainly not acquire a workspace it never asked for.
test("outside git, status is unchanged and says nothing about workspaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-87-solo-"));
  try {
    await writeFile(join(dir, "a.ts"), "export const a = 1\n", "utf8");
    cli(dir, "init", ".");
    const repo = await Repo.open(dir);
    const intent = await repo.createIntent({ title: "t", owner: human.id });
    const sess = await repo.startSession({ intentOid: intent, actor: human });
    await repo.proposeFileWrite({
      sessionOid: sess, intentOid: intent, actor: human,
      path: "a.ts", content: "export const a = 1\n", declaredPurpose: "seed",
    });

    const out = cli(dir, "status");
    assert.match(out, /files:\s*1\b/);
    assert.doesNotMatch(out, /workspace/, `no git means no workspace:\n${out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
