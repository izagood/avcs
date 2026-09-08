// Bring the base view up to the trunk commit a topic branch forked from, BEFORE capturing the
// branch's own work (issue #178).
//
// A workspace capture diffs the working tree against `materialize(view, { workspace })` — the
// base view plus the workspace's own ops. Base is whatever the store captured on trunk, and
// trunk can advance OUTSIDE avcs: merges made on the forge, a main checkout parked on some other
// branch for a week. A worktree checked out at that newer trunk then sees trunk's advance as its
// own delta and authors it as workspace ops — misattributed, flooding contention against the
// branches it was actually copied from, and later conflicting with base's own copy of the same
// changes once trunk does catch up.
//
// The fact that a branch holds a trunk commit is itself the evidence base is entitled to: the
// merge-base with trunk is trunk's work, and belongs to base. So when base has no record of it
// (`git:<sha>` — the commit↔checkpoint link the post-commit hook writes), that commit's tree is
// captured to base first, from git's own object store (`git archive`, tracked files only), and
// linked. Then the branch diff is what it should have been: the branch's own changes.
//
// Guarded against regressing base: if any trunk commit AFTER the merge-base is already linked,
// base is ahead of this branch's fork point and there is nothing to catch up.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../api/repo.ts";
import type { Actor } from "../objects/types.ts";
import type { BranchScope } from "./scope.ts";

export type CatchUpResult =
  | { caughtUp: { sha: string; ops: number; checkpoint?: string } }
  /** The capture was stopped by the signal before it finished: base holds part of the trunk
   *  tree. The caller must NOT capture the workspace on top of it this time. */
  | { partial: { sha: string; ops: number; remaining: number } }
  | { skipped: "not-a-workspace" | "no-git" | "no-trunk" | "no-merge-base" | "base-has-it" | "base-ahead" };

function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

/** The trunk branch this repo names that actually exists as a git ref here, if any. */
async function trunkRef(repo: Repo, cwd: string): Promise<string | null> {
  for (const t of await repo.trunkBranches()) {
    if (gitOut(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${t}`]) !== null) return t;
  }
  return null;
}

/**
 * Capture the branch's merge-base with trunk into base if base does not have it yet.
 * Idempotent: a second call finds the `git:<sha>` link and skips.
 */
export async function catchUpTrunk(
  repo: Repo,
  cwd: string,
  scope: BranchScope,
  actor: Actor,
  opts: { signal?: AbortSignal } = {},
): Promise<CatchUpResult> {
  if (!scope.workspace) return { skipped: "not-a-workspace" };
  if (gitOut(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") return { skipped: "no-git" };
  const trunk = await trunkRef(repo, cwd);
  if (!trunk) return { skipped: "no-trunk" };
  const mb = gitOut(cwd, ["merge-base", trunk, "HEAD"]);
  if (!mb) return { skipped: "no-merge-base" };
  if (await repo.gitCheckpoint(mb)) return { skipped: "base-has-it" };
  // Base may know a LATER trunk commit than this branch forked from — then capturing the
  // fork point would roll base back. Any linked commit between the merge-base and trunk's tip
  // means base is ahead; leave it alone.
  const later = gitOut(cwd, ["rev-list", `${mb}..${trunk}`]);
  for (const sha of (later ?? "").split("\n").filter(Boolean)) {
    if (await repo.gitCheckpoint(sha)) return { skipped: "base-ahead" };
  }

  // The fork point's tree, from git's objects (tracked files only — exactly what a trunk
  // capture with .gitignore applied would have seen), unpacked into a scratch directory.
  const tmp = await mkdtemp(join(tmpdir(), "avcs-trunk-catchup-"));
  try {
    const tar = execFileSync("git", ["archive", "--format=tar", mb], { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", tmp], { input: tar, stdio: ["pipe", "ignore", "ignore"] });
    const subject = gitOut(cwd, ["log", "-1", "--format=%s", mb]) ?? "";
    const message = `trunk catch-up: ${mb.slice(0, 7)} ${subject}`.trim();
    // Base scope on purpose: no line, no workspace. gitSync captures, checkpoints, and
    // reprojects into `tmp` (harmless — it is about to be deleted).
    const sync = await repo.gitSync({ message, actor, workDir: tmp, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (sync.partial) return { partial: { sha: mb, ops: sync.captured.ops.length, remaining: sync.partial.remaining } };
    if (sync.checkpoint) await repo.recordGitCommit(mb, sync.checkpoint);
    return { caughtUp: { sha: mb, ops: sync.captured.ops.length, ...(sync.checkpoint ? { checkpoint: sync.checkpoint } : {}) } };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** One stderr line when a catch-up did something — silence when it did not. */
export function catchUpMessage(r: CatchUpResult, branch: string): string | null {
  if ("caughtUp" in r) return `avcs: base caught up to trunk ${r.caughtUp.sha.slice(0, 7)} (${r.caughtUp.ops} op(s)) before capturing ${branch} — trunk had advanced outside avcs (#178)`;
  if ("partial" in r) return `avcs: base is catching up to trunk ${r.partial.sha.slice(0, 7)} — ${r.partial.ops} op(s) captured, ${r.partial.remaining} remaining; ${branch} itself was NOT captured this time and will be once base is level (#178)`;
  return null;
}
