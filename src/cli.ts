#!/usr/bin/env -S node --experimental-strip-types
// AVCS CLI — inspection & materialization.
//
// In an agent-native VCS the primary interface is the MCP server (src/mcp/server.ts);
// agents author intents/sessions/operations through it. This CLI is the human's
// read-and-decide surface: see what the agents did, why, and what still needs a call.
//
//   avcs init [dir]
//   avcs status [view]
//   avcs conflicts [view]
//   avcs log
//   avcs materialize [view] [--out <dir>]
//   avcs checkpoint <view> [-m <summary>]
//   avcs show <oid>
//   avcs mcp [install]

import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { Repo, type GitMode } from "./api/repo.ts";
import { type BranchScope, mergedBranchFromReflog, scopeForBranch } from "./git/scope.ts";
import { ObjectStore } from "./store/objectStore.ts";
import type { Operation, Actor } from "./objects/types.ts";
import { withDeadline, hookTimeoutMs } from "./concurrency/deadline.ts";

const args = process.argv.slice(2);
let cmd = args[0];
const cwd = process.cwd();

// Normalize the version/help flags so `avcs --version` / `avcs -h` work like
// every other CLI, instead of falling through to the usage exit-1 path.
if (cmd === "--version" || cmd === "-v") cmd = "version";
if (cmd === "--help" || cmd === "-h") cmd = "help";

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// ── git-bridge worktree resolution ──────────────────────────────────────────
// AVCS keeps a SINGLE store and is git-agnostic at its core. These helpers live
// in the CLI (the bridge layer, which already shells out to git) so the core
// never depends on git. They let `git-sync`/`git-hook` work correctly when run
// from a *linked git worktree*: the working tree is the worktree dir, but the
// store lives in the main checkout — which we locate via git's own resolution.
function gitCmd(dir: string, a: string[]): string | null {
  try {
    return execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

/** Locate the single AVCS store for a (possibly git-worktree) working dir: it's at `dir`
 *  or any ancestor if `.avcs` is present (AVCS's own upward root-finding — works with no
 *  git, like `git` ascending to `.git`); otherwise it lives in the main git checkout
 *  (resolved via `git rev-parse --git-common-dir`, whose parent is the main work tree).
 *  Falls back to `dir` so `Repo.open` surfaces its normal "not an AVCS repo" error when
 *  truly absent. */
function storeDirFor(dir: string): string {
  const root = ObjectStore.findRepoRoot(dir); // here, or any ancestor (non-git-dependent)
  if (root) return root;
  const common = gitCmd(dir, ["rev-parse", "--git-common-dir"]);
  if (common) {
    const main = dirname(isAbsolute(common) ? common : join(dir, common)); // <main>/.git → <main>
    if (ObjectStore.isRepo(main)) return main;
  }
  return dir;
}

/** The main checkout that owns this linked working tree, via git's own resolution:
 *  `git rev-parse --git-common-dir` yields the shared `.git`, whose parent is the main work
 *  tree. Null when git is absent, or when this *is* the main checkout — in both cases there
 *  is nothing to attach to and the caller must be told rather than guessed at. */
function mainCheckoutOf(dir: string): string | null {
  const common = gitCmd(dir, ["rev-parse", "--git-common-dir"]);
  if (!common) return null;
  const main = dirname(isAbsolute(common) ? common : join(dir, common));
  return main === resolve(dir) ? null : main;
}

/** Keep the pointer out of git. `info/exclude` lives in the common dir, so one entry covers
 *  every working tree of the repo — including ones that do not exist yet. No-op without git.
 *  (In sidecar mode `.avcs/`'s own .gitignore does this job, but that file is *inside* the
 *  store, which a pointer is not.) */
function excludePointerFromGit(dir: string): void {
  const common = gitCmd(dir, ["rev-parse", "--git-common-dir"]);
  if (!common) return;
  const p = join(isAbsolute(common) ? common : join(dir, common), "info", "exclude");
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (/^\/\.avcs$/m.test(existing)) return;
  mkdirSync(dirname(p), { recursive: true });
  const sep = !existing || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(p, `${existing}${sep}\n# AVCS store pointer in linked working trees\n/.avcs\n`);
}

/** Point `dir` at the store owned by `to`, and keep the pointer out of git. Returns the
 *  store path written. Shared by `avcs worktree attach` and the post-checkout hook. */
function attachWorktree(dir: string, to: string): string {
  const target = ObjectStore.resolveStoreDir(resolve(to));
  if (!ObjectStore.isRepo(resolve(to))) throw new Error(`${to} is not an AVCS repo (no .avcs/objects)`);
  // In committed mode git itself carries `.avcs` into every working tree, so a pointer would
  // sit exactly where git wants to write the store. Refuse rather than fight it. Checked here
  // rather than in the command so the hook cannot create a state the command forbids. (Read
  // the config directly: `Repo.getGitMode` is async, and this runs before any store opens.)
  if (gitModeOfStore(target) === "committed") {
    throw new Error("this repo is in committed git mode \u2014 git already delivers .avcs to every working tree, so attaching would fight it");
  }
  writeFileSync(join(dir, ".avcs"), `avcsdir: ${target}\n`);
  excludePointerFromGit(dir);
  return target;
}

/** The git-bridge mode recorded in a store, defaulting to `sidecar` exactly like
 *  `Repo.getGitMode` (which also treats a missing or torn config as empty). */
function gitModeOfStore(storeRoot: string): GitMode {
  const p = join(storeRoot, "config.json");
  if (!existsSync(p)) return "sidecar";
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { gitMode?: string }).gitMode === "committed" ? "committed" : "sidecar";
  } catch {
    return "sidecar";
  }
}

/**
 * The AVCS scope a working dir writes into (docs/20 §3.2): the current git branch, mapped
 * through this repo's trunk setting. A topic branch is work that intends to CONVERGE, so it
 * maps to a workspace, not to a line — a line is permanent divergence and stays opt-in via
 * `--line`. This replaces the earlier `lineFor`, which made every topic branch a line and so
 * gave each one a history the others could never see (docs/20 §1.1).
 *
 * The `line:<branch>` lookup is what protects work started before this mapping existed: such
 * a branch keeps writing to the line it has been accumulating in (case W9).
 */
async function scopeFor(repo: Repo, dir: string, explicitLine?: string): Promise<BranchScope> {
  if (explicitLine) return { line: explicitLine };
  const branch = gitCmd(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const hasExistingLine = !!branch && !!(await repo.store.getRef(`line:${branch}`));
  return scopeForBranch(branch, await repo.trunkBranches(), { hasExistingLine });
}

/** How to name a scope in output meant for a human. */
function scopeLabel(scope: BranchScope): string {
  return scope.workspace ? `workspace ${scope.workspace}` : scope.line ? `line ${scope.line}` : "base view";
}

/**
 * Turn a completed git merge into an AVCS workspace land (docs/20 §3.4) — the point of the
 * whole track: convergence recorded inside the graph rather than only in git.
 *
 * Every branch of this function that is not an unmistakable workspace land DECLINES, with the
 * reason, because `landWorkspace` is append-only and irreversible: landing the wrong
 * workspace publishes someone's unfinished work onto base and cannot be undone, which is
 * strictly worse than landing nothing (docs/20 R1). `post-merge` runs after `MERGE_HEAD` is
 * gone, so git's reflog is the only record of what was merged.
 */
async function landMergedWorkspace(
  repo: Repo,
  dir: string,
): Promise<{ landed: string } | { declined: string; needsHuman: boolean }> {
  const subject = gitCmd(dir, ["reflog", "-1", "--format=%gs"]);
  const branch = mergedBranchFromReflog(subject);
  // Could not tell WHAT was merged — the one case where a land may well be owed and only a
  // human can say so (a squash merge lands here, docs/20 R2).
  if (!branch) return { declined: `git's reflog names no single merged branch (\`${subject ?? "?"}\`)`, needsHuman: true };
  // Nothing to land: pulling trunk into trunk, or merging a line (divergence ported on
  // purpose, never landed). Both are ordinary and need no human.
  if ((await repo.trunkBranches()).includes(branch)) return { declined: `\`${branch}\` is trunk — nothing to land`, needsHuman: false };
  if (await repo.store.getRef(`line:${branch}`)) return { declined: `\`${branch}\` is an avcs line, not a workspace — lines are ported, not landed`, needsHuman: false };
  // The name is a plausible workspace but nothing was ever captured under it, so landing it
  // would record a land of an empty set. Say so: the real tag may simply be named differently.
  if (!(await repo.workspaceNames()).includes(branch)) return { declined: `no operation is tagged workspace \`${branch}\``, needsHuman: true };
  await repo.landWorkspace(branch);
  return { landed: branch };
}

/** An ignore predicate backed by `git check-ignore`, so `git-sync` respects `.gitignore`
 *  (and global excludes) without the core ever depending on git (issue #10). git absent or
 *  not-a-repo ⇒ a no-op, leaving the core's own `.avcsignore` as the only filter. The core
 *  prunes ignored directories, so this is invoked per surviving entry, not per ignored file. */
function gitIgnorePredicate(dir: string): (rel: string) => boolean {
  if (gitCmd(dir, ["rev-parse", "--is-inside-work-tree"]) !== "true") return () => false;
  // One git invocation for the whole tree, not one per entry (issue #64). The old
  // predicate spawned `git check-ignore` per surviving entry — hundreds of process
  // spawns per hook, the dominant cost of a pre-commit ingest and the reason a
  // deadline could not be honored. `ls-files -i -o --exclude-standard --directory`
  // lists ignored untracked paths once, collapsing whole ignored directories into a
  // single entry; a tracked file is by definition not filtered out here.
  const listed = gitCmd(dir, [
    "ls-files",
    "-i",
    "-o",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  if (listed === null) {
    // Fall back to the per-entry probe rather than silently filtering nothing.
    return (rel: string): boolean => gitCmd(dir, ["check-ignore", "-q", rel]) !== null;
  }
  const files = new Set<string>();
  const dirs: string[] = [];
  for (const raw of listed.split("\0")) {
    const entry = raw.replace(/\/$/, "");
    if (!entry) continue;
    if (raw.endsWith("/")) dirs.push(`${entry}/`);
    else files.add(entry);
  }
  return (rel: string): boolean =>
    files.has(rel) || dirs.some((d) => rel === d.slice(0, -1) || rel.startsWith(d));
}

/**
 * Put the capture path's cross-line contention warnings in front of the human (docs/17 §15.3).
 * The git bridge gives every branch its own AVCS line, so this is the only place a session
 * learns that another branch has live concurrent work on a file it just committed. Advisory:
 * it never changes the exit code — only an open conflict blocks a commit.
 */
function reportContention(warnings: import("./api/repo.ts").ContentionWarning[]): void {
  for (const w of warnings) {
    const file = w.key.startsWith("file:") ? w.key.slice("file:".length) : w.key;
    for (const t of w.theirs) {
      console.error(`avcs: contention on ${file} — ${t.actor} has live concurrent work on line '${t.line ?? "main"}' (${t.op.slice(0, 16)}: ${t.purpose}). Not blocking; coordinate before you land.`);
    }
    for (const l of w.leaseHolders) {
      console.error(`avcs: contention on ${file} — ${l.actor} holds a lease over '${l.scope}' until ${l.expiresAt}. Not blocking; coordinate before you land.`);
    }
  }
}

/** Ensure the line/view exists before sync targets it (auto-forked from main on the first
 *  commit on a branch). No-op for the default `main` line/view, which always exists. */
async function ensureLine(repo: Repo, line?: string): Promise<void> {
  if (!line) return;
  if (!(await repo.store.getRef(`view:${line}`))) await repo.createLine(line);
}

function pkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// The exact command that re-invokes this CLI (node + strip-types + this script path), so
// installed hooks call the same AVCS the user is running now — no global install assumed.
function avcsInvocation(): string {
  return `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(process.argv[1])}`;
}

const HOOK_PHASES = ["pre-commit", "prepare-commit-msg", "post-commit", "post-merge", "post-checkout"] as const;
const HOOK_MARKER = "# avcs-git-bridge-hook";

function hookScript(phase: string, avcsCmd: string): string {
  return `#!/bin/sh
${HOOK_MARKER} ${phase}
# Managed by \`avcs install-hooks\` (docs/14). Delete this file to disable.
exec ${avcsCmd} git-hook ${phase} "$@"
`;
}

/** Install the git-bridge hook scripts into `hooksDir`, preserving any non-AVCS hooks. */
async function installHooks(hooksDir: string, avcsCmd: string, force: boolean): Promise<{ installed: string[]; skipped: string[] }> {
  const { writeFile, mkdir, readFile, chmod } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  await mkdir(hooksDir, { recursive: true });
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const phase of HOOK_PHASES) {
    const p = join(hooksDir, phase);
    if (existsSync(p)) {
      const existing = await readFile(p, "utf8");
      if (!existing.includes(HOOK_MARKER) && !force) { skipped.push(phase); continue; } // a foreign hook — don't clobber
    }
    await writeFile(p, hookScript(phase, avcsCmd), "utf8");
    await chmod(p, 0o755);
    installed.push(phase);
  }
  return { installed, skipped };
}

/**
 * The git side of `undo --purge` (docs/23 §3.1).
 *
 * In bridge mode the same file lands in TWO stores, so an eviction that stops at `.avcs/`
 * leaves the secret readable in a git object while the CLI prints `bytes evicted, not
 * recoverable`. That is a trap, and telling the user to go run `filter-repo` themselves
 * hands back the hardest part of the job. So `--purge` finishes it in git too.
 *
 * It does so only where it can PROVE the rewrite is safe and local — every condition below
 * is checked against git itself, not assumed — and where it cannot, it does the AVCS side
 * anyway and names what is left plus the exact command for that situation. The dangerous
 * cases are refusals, not silent best-effort:
 *
 *  1. reachable from a remote ⇒ published; rotation is the only real remediation and a
 *     force-push is theatre. avcs never pushes, with or without a flag.
 *  2. reachable from another local ref (tag, second branch, a stash) ⇒ moving this branch
 *     alone would leave the bytes reachable, so the purge would not be one.
 *  3. detached HEAD ⇒ no branch to move.
 *  4. the commits are not a contiguous run at the tip ⇒ removing them is a genuine history
 *     rewrite, not a reset. Different, harder job: `filter-repo`.
 *  5. a commit in that run also carries work no undone op covers ⇒ a blind reset would
 *     destroy something the user did not ask to destroy.
 *  6. a dirty tree ⇒ HEAD must not move out from under uncommitted work.
 *
 * `pushedOps` (the AVCS push ledger, docs/23 §5) is a SEPARATE and independent check that
 * `repo.undo` already enforces: an op can be un-pushed to the hub while its git commit sits
 * on `origin`, and vice versa. Both have to hold.
 *
 * Silent probes throughout (`gitCmd`'s `stdio: ["ignore","pipe","ignore"]`), and no git means
 * no output at all: the standalone message is already accurate and gains nothing from a
 * caution about a tool that is not here.
 */
type GitPurge =
  | { do: "nothing" }
  | { do: "remove"; branch: string; resetTo: string | null; commits: string[] }
  | { do: "refuse"; because: string; detail: string[]; remedy: string[] };

const gitLines = (s: string | null): string[] => (s ?? "").split("\n").filter((l) => l.length > 0);

/** Paths the undone ops wrote — where git's own copy of the same bytes would be. */
async function pathsOfOps(repo: Repo, ops: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const oid of ops) {
    const op = await repo.store.get<Operation>(oid).catch(() => null);
    const path = op?.body.path ?? op?.target.entityId;
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** Every path one commit changed. `--root` because git omits the initial commit's diff
 *  without it, and `--no-renames` so a rename reports BOTH sides (a purge cares about both).
 *  `-z` so a path with a space is not returned quoted. */
function commitPaths(dir: string, sha: string): string[] {
  const raw = gitCmd(dir, ["log", "-1", "--root", "--pretty=format:", "--name-only", "--no-renames", "-z", sha]);
  return (raw ?? "").split("\0").map((p) => p.trim()).filter((p) => p.length > 0);
}

function shortSha(dir: string, sha: string): string {
  return gitCmd(dir, ["rev-parse", "--short", sha]) ?? sha.slice(0, 7);
}

/** `avcs undo --purge <oids>` — the retry that re-does only the git half, since the AVCS
 *  half has already converged. Never `--last`: after the undo, `--last` names a DIFFERENT
 *  commit, so telling the user to repeat it would walk them one commit further back. */
function retryCommand(ops: string[]): string {
  return `avcs undo --purge ${ops.join(" ")}`;
}

function planGitPurge(dir: string, paths: string[], ops: string[]): GitPurge {
  if (gitCmd(dir, ["rev-parse", "--is-inside-work-tree"]) !== "true") return { do: "nothing" };
  const head = gitCmd(dir, ["rev-parse", "HEAD"]);
  if (!head || !paths.length) return { do: "nothing" };
  // Newest first. Path-limited, so it names exactly the commits that could hold these bytes.
  const touching = gitLines(gitCmd(dir, ["log", "--pretty=%H", "HEAD", "--", ...paths]));
  if (!touching.length) return { do: "nothing" }; // git never committed these paths
  const invert = paths.map((p) => `--path ${p}`).join(" ");
  const rewrite = [
    `    git filter-repo ${invert} --invert-paths`,
    `    (no filter-repo? git filter-branch --index-filter 'git rm --cached --ignore-unmatch ${paths.join(" ")}' -- --all)`,
    "  Then confirm it worked:  git log --all -S '<the secret>'",
  ];

  // ① Published. Checked first because it outranks every other finding: once served, the
  //    secret is out, and no local surgery changes that.
  const refs = gitLines(gitCmd(dir, ["for-each-ref", "--format=%(refname)"]));
  const remotes = refs.filter((r) => r.startsWith("refs/remotes/"));
  const onRemote = remotes.length ? touching.filter((c) => reachableFrom(dir, c, remotes)) : [];
  if (onRemote.length) {
    const where = remotes.filter((r) => reachableFrom(dir, onRemote[0] as string, [r])).map((r) => r.replace("refs/remotes/", ""));
    return {
      do: "refuse",
      because: "the commit is already on a remote",
      detail: [`  ${shortSha(dir, onRemote[0] as string)} is reachable from ${where.join(", ") || "a remote-tracking ref"}`],
      remedy: [
        "  ROTATE THE CREDENTIAL. It is published — anyone who fetched already has it, so rewriting",
        "  history now is theatre: it cannot un-publish what was already served. avcs will not",
        "  force-push for you, and there is no flag for it.",
        "  Cleaning the remote afterwards is your host's procedure, and costs every collaborator a re-clone.",
      ],
    };
  }

  // ② No branch to move.
  const branch = gitCmd(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch) {
    return {
      do: "refuse",
      because: "HEAD is detached",
      detail: ["  there is no branch here for avcs to move"],
      remedy: [`  Check out the branch that holds those commits, then re-run:  ${retryCommand(ops)}`],
    };
  }

  // ③ Not at the tip. A secret buried under later commits is a rewrite, not a reset.
  const buried = (why: string): GitPurge => ({ do: "refuse", because: "the commit is not at the tip", detail: [`  ${why}`], remedy: ["  Removing it is a genuine history rewrite rather than a reset — a different, harder job:", ...rewrite] });
  if (touching[0] !== head) {
    const later = gitLines(gitCmd(dir, ["rev-list", `${touching[0]}..HEAD`])).length;
    return buried(`${shortSha(dir, touching[0] as string)} holds ${paths.join(", ")}, and ${later} later commit(s) sit on top of it`);
  }
  const chain = gitLines(gitCmd(dir, ["rev-list", "--first-parent", "HEAD"]));
  const oldest = touching[touching.length - 1] as string;
  const depth = chain.indexOf(oldest);
  if (depth < 0) return buried(`${shortSha(dir, oldest)} is not on this branch's first-parent line`);
  const window = chain.slice(0, depth + 1);
  if (gitLines(gitCmd(dir, ["rev-list", "--merges", "--no-walk", ...window])).length) {
    return buried("a merge commit is in the run that would have to be removed");
  }

  // ④ Another ref would keep the bytes reachable, so the reset would not purge anything.
  const others = refs.filter((r) => r !== `refs/heads/${branch}`);
  const held = others.length ? window.filter((c) => reachableFrom(dir, c, others)) : [];
  if (held.length) {
    const by = others.filter((r) => reachableFrom(dir, held[0] as string, [r]));
    return {
      do: "refuse",
      because: "another ref still points into that history",
      detail: [`  ${shortSha(dir, held[0] as string)} is also reachable from ${by.join(", ")}`],
      remedy: [
        `  Moving \`${branch}\` alone would leave the bytes reachable, so the purge would not be one.`,
        `  Delete or move that ref yourself, then re-run:  ${retryCommand(ops)}`,
      ],
    };
  }

  // ⑤ Something else in the run that the user never asked to lose.
  const covers = (p: string): boolean => paths.includes(p) || p === ".avcs" || p.startsWith(".avcs/");
  for (const sha of window) {
    const changed = commitPaths(dir, sha);
    const extra = changed.filter((p) => !covers(p));
    if (!extra.length) continue;
    if (changed.some(covers)) {
      return {
        do: "refuse",
        because: `${shortSha(dir, sha)} also carries work you did not undo`,
        detail: [`  it changes ${extra.join(", ")}, which no undone op covers`],
        remedy: [
          "  Dropping that commit would drop that work with it, and you did not ask for that.",
          `  Either undo those ops too and re-run, or rewrite just the leaked path:`,
          ...rewrite,
        ],
      };
    }
    return buried(`${shortSha(dir, sha)} changes only ${extra.join(", ")}, and sits inside the run that would have to go`);
  }

  // ⑥ HEAD must not move out from under uncommitted work. Untracked entries are exempt:
  //    a `--mixed` reset never touches them, and in sidecar mode `.avcs/` is one of them.
  const dirty = gitLines(gitCmd(dir, ["status", "--porcelain"]))
    .filter((l) => !l.startsWith("??"))
    .filter((l) => !l.slice(3).startsWith(".avcs/"));
  if (dirty.length) {
    return {
      do: "refuse",
      because: "the git tree is not clean",
      detail: dirty.slice(0, 5).map((l) => `  ${l}`),
      remedy: [
        "  Moving HEAD out from under uncommitted work is how work gets lost, so avcs stops here.",
        `  Commit those changes or set them aside, then re-run:  ${retryCommand(ops)}`,
      ],
    };
  }

  // Every condition holds. `resetTo === null` ⇒ the whole run is the branch's entire
  // history, so the branch itself goes and is left unborn — nothing extra is lost, since
  // the only thing it held is what we were asked to remove.
  const parent = gitCmd(dir, ["rev-parse", "--verify", "--quiet", `${window[window.length - 1]}^`]);
  return { do: "remove", branch, resetTo: parent, commits: window };
}

/** Is `sha` reachable from any of `from`? `rev-list -1 sha --not <refs>` prints nothing
 *  exactly when everything reachable from `sha` is already covered by them. */
function reachableFrom(dir: string, sha: string, from: string[]): boolean {
  return gitCmd(dir, ["rev-list", "-1", sha, "--not", ...from]) === "";
}

/**
 * Carry out the plan and REPORT what actually happened, verified rather than asserted.
 *
 * `--mixed`, deliberately: it moves the branch and resets the index but never touches the
 * working tree, so the leaked file stays on disk. That is correct — the user still has to
 * fix it — and it makes the two planes agree afterwards: git calls the file untracked (or
 * modified), and the AVCS view no longer selects the op, so `avcs status` calls it new. Both
 * say "this content is on disk and is recorded nowhere".
 *
 * Then the object itself goes, not merely its reachability: `--expire-unreachable` drops the
 * reflog entries that would otherwise hand the commit back (and only those — the user's
 * reflog for still-reachable work survives), `ORIG_HEAD` is removed because `reset` had just
 * written it, and `gc --prune=now` collects what is left.
 */
function applyGitPurge(dir: string, plan: Extract<GitPurge, { do: "remove" }>): void {
  const shorts = plan.commits.map((c) => `${shortSha(dir, c)} ${gitCmd(dir, ["log", "-1", "--pretty=%s", c]) ?? ""}`.trim());
  if (plan.resetTo) {
    gitCmd(dir, ["reset", "--mixed", plan.resetTo]);
  } else {
    gitCmd(dir, ["update-ref", "-d", `refs/heads/${plan.branch}`]);
    gitCmd(dir, ["rm", "-r", "--cached", "-q", "--", "."]);
  }
  gitCmd(dir, ["update-ref", "-d", "ORIG_HEAD"]);
  gitCmd(dir, ["reflog", "expire", "--expire-unreachable=now", "--all"]);
  gitCmd(dir, ["gc", "--prune=now", "--quiet"]);

  const survivors = plan.commits.filter((c) => gitCmd(dir, ["cat-file", "-e", `${c}^{commit}`]) !== null);
  console.log(`git: removed ${plan.commits.length} commit(s) holding those bytes from \`${plan.branch}\`, and pruned the objects.`);
  for (const s of shorts) console.log(`  - ${s}`);
  console.log(plan.resetTo ? `  ${plan.branch} is now at ${shortSha(dir, plan.resetTo)}.` : `  ${plan.branch} is unborn now — that run was its whole history.`);
  console.log("  The working tree is untouched, so the leaked file is still on disk and no longer tracked — fix it before you commit again.");
  if (survivors.length) {
    console.log(`  WARNING: git can still read ${survivors.map((c) => shortSha(dir, c)).join(", ")} — something else holds it.`);
    console.log("  Check `git fsck --lost-found`, other worktrees, and `git reflog --all`, then re-check with `git log --all -S '<the secret>'`.");
  }
}

/** The git half of `undo --purge`: do it where it is provably safe, and where it is not, say
 *  precisely what is left and the one command that fits that situation. */
async function settleGitAfterPurge(repo: Repo, ops: string[], noGit: boolean): Promise<void> {
  const paths = await pathsOfOps(repo, ops);
  const plan = planGitPurge(cwd, paths, ops);
  if (plan.do === "nothing") return;
  if (noGit) {
    console.log("git: --no-git — git still holds its own copy of those bytes, and clearing it is on you.");
    console.log(`  When you want avcs to try:  ${retryCommand(ops)}`);
    return;
  }
  if (plan.do === "remove") return applyGitPurge(cwd, plan);
  console.log(`git: those bytes are in git too, and avcs did NOT remove them — ${plan.because}.`);
  for (const d of plan.detail) console.log(d);
  for (const r of plan.remedy) console.log(r);
}

async function main(): Promise<void> {
  switch (cmd) {
    case "version": {
      console.log(`avcs ${pkgVersion()}`);
      break;
    }
    case "init": {
      const dir = args[1] && !args[1].startsWith("--") ? args[1] : cwd;
      // A linked working tree whose main checkout already has a store almost never wants a
      // second one: the two would accumulate separate history and push to separate remotes,
      // with nothing that could ever reconcile them — and it looks fine until it doesn't.
      // Stop and name the fix; `--force` stays available for a deliberate split.
      if (!args.includes("--force") && !ObjectStore.isRepo(dir)) {
        const owner = mainCheckoutOf(dir);
        if (owner && ObjectStore.isRepo(owner)) {
          throw new Error(
            `the main checkout of this linked working tree already has an AVCS store (${owner}). ` +
              "Creating another one here would fork the history. Run `avcs worktree attach` to share " +
              "that store, or `avcs init --force` if you really want an independent one.",
          );
        }
      }
      const repo = await Repo.init(dir);
      const want = flag("--mode");
      const mode: GitMode = want === "committed" ? "committed" : "sidecar";
      await repo.setGitMode(mode);
      console.log(`initialized AVCS repo at ${dir}/.avcs  [git mode: ${mode}]`);
      if (mode === "sidecar") console.log(`  .avcs/ is git-ignored — git tracks only the projection (run \`avcs git-mode committed\` to share history via git)`);
      // Record the trunk branch when — and only when — git can name it without guessing
      // (docs/20 §3.1, Q2). `refs/remotes/origin/HEAD` is the REMOTE's default branch, so
      // this cannot misfire from `avcs init` being run on a topic branch, the way reading
      // the current branch would. A repo whose trunk is main/master needs no field at all:
      // unset already means exactly that pair, so nothing is written and the pre-trunk
      // behaviour is preserved byte-for-byte (W7). No git, no origin, no field either.
      if ((await repo.trunkBranches()).length > 1) {
        const head = gitCmd(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
        const remoteDefault = head?.startsWith("origin/") ? head.slice("origin/".length) : null;
        if (remoteDefault && !(await repo.trunkBranches()).includes(remoteDefault)) {
          await repo.setTrunk(remoteDefault);
          console.log(`  detected trunk: ${remoteDefault} (origin's default branch) — \`avcs trunk <branch>\` to change`);
        }
      }
      // If this is a git repo, offer to install the bridge hooks so `git commit` just works.
      if (!args.includes("--no-hooks")) {
        const { execFileSync } = await import("node:child_process");
        try {
          // stderr is silenced deliberately: the catch below treats "no git here" as the
          // ordinary standalone case, and a probe whose failure we ignore must not print
          // git's `fatal:` to a user who never asked about git. Same stdio contract as
          // `gitCmd`, which every other git probe in this file already uses.
          const gp = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
          const { isAbsolute, join } = await import("node:path");
          const hooksDir = isAbsolute(gp) ? gp : join(dir, gp);
          const cmd = `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(process.argv[1])}`;
          const { installed } = await installHooks(hooksDir, cmd, false);
          if (installed.length) console.log(`  installed git hooks (${installed.join(", ")}) — \`git commit\` now auto-syncs AVCS (--no-hooks to skip)`);
        } catch { /* not a git repo — fine; user can `git init` then `avcs install-hooks` */ }
      }
      break;
    }
    case "status": {
      const repo = await Repo.open(cwd);
      const view = args[1] ?? "main";
      const res = await repo.materialize(view);
      const counts: Record<string, number> = {};
      for (const s of res.statuses.values()) counts[s] = (counts[s] ?? 0) + 1;
      console.log(`view: ${view}`);
      console.log(`operations: ${JSON.stringify(counts)}`);
      console.log(`files: ${res.tree.size}   conflicts: ${res.conflicts.length}   auto-merged: ${res.autoDecisions.length}`);
      console.log(`treeHash: ${res.treeHash}`);
      for (const a of res.autoDecisions)
        console.log(`  ✓ auto @ ${a.key}: chose ${a.chosenOp.slice(0, 16)} (policy ${a.policyVersion})`);
      if (res.conflicts.length) console.log(`\nrun \`avcs conflicts ${view}\` to review`);
      // Phase 15.3: early conflict warning — other actors' live concurrent work (and
      // lease holders) on the keys this replica's actor has authored on. Needs a local
      // identity for perspective; without one the section is simply omitted.
      const me = await repo.localActorId(flag("--as"));
      if (me) {
        const warnings = await repo.contention({ actorId: me });
        if (warnings.length) {
          console.log(`\ncontention (${warnings.length} key(s), from ${me}'s perspective):`);
          for (const w of warnings) {
            console.log(`  ⚠ ${w.key}`);
            for (const t of w.theirs) console.log(`     ~ ${t.op.slice(0, 16)}… ${t.actor} :: ${t.purpose}`);
            for (const l of w.leaseHolders) console.log(`     ⛔ lease held by ${l.actor} on ${l.scope} until ${l.expiresAt}`);
          }
        }
      }
      break;
    }
    case "key": {
      // Signing keys, reachable without writing a script (issue #51). `ls` prints actor
      // ids only — a listing that emitted key material would be the disclosure it exists
      // to help avoid.
      const repo = await Repo.open(cwd);
      const sub = args[1];
      if (sub === "provision") {
        const id = args[2];
        if (!id) throw new Error("usage: avcs key provision <actor-id> [--kind human|ai_agent|ci_bot]");
        const kind = (flag("--kind") ?? (id.startsWith("human:") ? "human" : id.startsWith("ci:") ? "ci_bot" : "ai_agent")) as Actor["kind"];
        const r = await repo.ensureOwnerKey({ kind, id });
        console.log(r.created ? `provisioned signing key for ${id}` : `${id} already has a local signing key (unchanged)`);
        break;
      }
      if (sub === "ls" || sub === undefined) {
        const [local, trusted] = await Promise.all([repo.listLocalKeys(), repo.listTrustedKeys()]);
        console.log(`signable on this machine (${local.length}):`);
        for (const a of local) console.log(`  ${a}`);
        console.log(`trusted by this repo (${trusted.length}):`);
        for (const a of trusted) console.log(`  ${a}`);
        break;
      }
      throw new Error(`unknown key subcommand: ${sub} — use \`avcs key provision <actor-id>\` or \`avcs key ls\``);
    }
    case "conflicts": {
      const repo = await Repo.open(cwd);
      // Default to the scope this working tree is actually writing into: on a topic branch the
      // conflicts that matter are the WORKSPACE's, and a base-view listing would report "none"
      // while `git-sync` refuses to stage the very tree they are in.
      const scope = await scopeFor(repo, cwd);
      const view = (args[1] && !args[1].startsWith("--") ? args[1] : undefined) ?? scope.line ?? "main";
      const workspace = flag("--workspace") ?? scope.workspace;
      const res = await repo.materialize(view, workspace ? { workspace } : undefined);
      if (workspace) console.log(`(workspace ${workspace} over ${view})`);
      if (!res.conflicts.length) {
        console.log("no open conflicts — nothing needs a human.");
        break;
      }
      for (const c of res.conflicts) {
        console.log(`\n● ${c.id}  [${c.kind}]  @ ${c.key}`);
        console.log(`  ${c.reason}`);
        for (const o of c.options) {
          const tags = [o.blocked && "blocked", o.requiresHuman && "needs-human"]
            .filter(Boolean)
            .join(",");
          console.log(`   - ${o.opOid}`);
          console.log(`     ${o.actor} :: ${o.purpose}  (score ${o.score}${tags ? ", " + tags : ""})`);
        }
        if (c.recommendedOp) console.log(`  → recommended: ${c.recommendedOp}`);
        console.log(`  decide via MCP avcs.decision.record or the API`);
      }
      break;
    }
    case "metrics": {
      const repo = await Repo.open(cwd);
      await repo.materialize(args[1] ?? "main"); // do some work so there's something to show
      console.log(JSON.stringify(repo.metrics.snapshot(), null, 2));
      break;
    }
    case "blame": {
      const repo = await Repo.open(cwd);
      const key = args[1];
      if (!key) throw new Error("usage: avcs blame <file:path | symbol:path#name>");
      const b = await repo.blame(key, flag("--line") ?? "main");
      if (!b) console.log("no owner (entity not present)");
      else console.log(`${b.actor.id}  ${b.op.slice(0, 16)}\n  why: ${b.purpose}${b.intentTitle ? `  [intent: ${b.intentTitle}]` : ""}\n  at:  ${b.at}`);
      break;
    }
    case "diff": {
      const repo = await Repo.open(cwd);
      const a = args[1] ?? "main";
      const b = args[2] ?? "main";
      const d = await repo.diff(a, b);
      for (const p of d.added) console.log(`+ ${p}`);
      for (const p of d.removed) console.log(`- ${p}`);
      for (const p of d.modified) console.log(`~ ${p}`);
      if (!d.added.length && !d.removed.length && !d.modified.length) console.log("(no differences)");
      break;
    }
    case "pull": {
      const repo = await Repo.open(cwd);
      const from = args[1];
      if (!from) throw new Error("usage: avcs pull <hub-url | other-repo-dir>");
      if (/^https?:\/\//.test(from)) {
        const r = await repo.pullHub(from);
        console.log(`pulled ${r.pulled} object(s) from hub ${from}`);
      } else {
        const r = await repo.pull(from);
        console.log(`pulled ${r.copied} object(s)${r.rejected ? `, rejected ${r.rejected}` : ""}`);
      }
      break;
    }
    case "push": {
      const repo = await Repo.open(cwd);
      const url = args[1];
      if (!url || !/^https?:\/\//.test(url)) throw new Error("usage: avcs push <hub-url> [--as <actorId>]");
      // --as picks which local identity key signs the request (SSH `-i`); omitted, avcs
      // auto-discovers it (AVCS_ACTOR → config.actorId → the sole private key), and an
      // unsigned push still works against a hub that doesn't require transport auth.
      const asIdx = args.indexOf("--as");
      const as = asIdx >= 0 ? args[asIdx + 1] : undefined;
      const r = await repo.pushHub(url, { as });
      console.log(`pushed ${r.pushed} object(s) to ${url}${r.rejected ? `, rejected ${r.rejected} (gated)` : ""}`);
      break;
    }
    case "clone": {
      const url = args[1];
      const dir = args[2] ?? cwd;
      if (!url || !/^https?:\/\//.test(url)) throw new Error("usage: avcs clone <hub-url> [dir] [--key <repo-dir|key-file>] [--as <actor-id>]");
      const repo = await Repo.init(dir);
      // A hub that gates reads refuses an unsigned GET /have, and a just-created repo holds
      // no key to sign it with (issue #58). `--key` brings one in from an existing repo dir
      // or a key file; it is adopted into the new repo first, so later syncs work too.
      const keySrc = flag("--key") ?? process.env.AVCS_KEY;
      const as = flag("--as");
      let signer: string | undefined = as;
      if (keySrc) signer = await repo.importLocalKey(keySrc, as);
      const r = await repo.pullHub(url, signer ? { as: signer } : undefined);
      // Phase 13.1: remember where we came from — `avcs sync` now works with no URL.
      await repo.addRemote("origin", url);
      console.log(
        `cloned ${r.pulled} object(s) from ${url} into ${dir}  [remote origin recorded]` +
          (signer ? `  [signing as ${signer}]` : ""),
      );
      break;
    }
    case "remote": {
      const repo = await Repo.open(cwd);
      const sub = args[1];
      if (sub === "add") {
        const name = args[2];
        const url = args[3];
        if (!name || !url) throw new Error("usage: avcs remote add <name> <url> [--auto-sync] [--freshness-ms N]");
        const freshness = flag("--freshness-ms");
        await repo.addRemote(name, url, {
          autoSync: args.includes("--auto-sync"),
          freshnessMs: freshness !== undefined ? Number(freshness) : undefined,
        });
        console.log(`remote ${name} → ${url}`);
      } else if (sub === "rm") {
        const name = args[2];
        if (!name) throw new Error("usage: avcs remote rm <name>");
        console.log((await repo.removeRemote(name)) ? `removed remote ${name}` : `no such remote: ${name}`);
      } else if (sub === "ls" || sub === undefined) {
        const remotes = await repo.listRemotes();
        const names = Object.keys(remotes).sort();
        if (!names.length) console.log("(no remotes — add one with `avcs remote add origin <url>`)");
        for (const n of names) {
          const r = remotes[n]!;
          console.log(`${n}\t${r.url}${r.autoSync ? "  [auto-sync]" : ""}${r.freshnessMs !== undefined ? `  [freshness ${r.freshnessMs}ms]` : ""}`);
        }
      } else {
        throw new Error("usage: avcs remote <add|rm|ls> ...");
      }
      break;
    }
    case "sync": {
      const repo = await Repo.open(cwd);
      const remote = args[1] && !args[1].startsWith("--") ? args[1] : "origin";
      const asIdx = args.indexOf("--as");
      const as = asIdx >= 0 ? args[asIdx + 1] : undefined;
      // Phase 15.2: `--watch` turns sync into the live-convergence daemon — long-poll
      // GET /events, incremental pull on wake, contention early warning on arrivals.
      if (args.includes("--watch")) {
        const { runSyncWatch } = await import("./hub/syncWatch.ts");
        const { consoleLogger } = await import("./observe/logger.ts");
        repo.logger = consoleLogger("info");
        const ac = new AbortController();
        const stop = () => ac.abort();
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        console.log(`watching ${remote} — live convergence via long-poll (Ctrl-C to stop)`);
        await runSyncWatch(repo, {
          remote,
          as,
          signal: ac.signal,
          onEvent: (ev) => {
            if (ev.type === "contention")
              console.log(`⚠ contention @ ${ev.key}: ${ev.incomingActor}'s op ${ev.incomingOp.slice(0, 16)}… arrived on a key with local work by ${[...new Set(ev.localOps.map((o) => o.actor))].join(", ")}`);
            else if (ev.type === "head") console.log(`↑ head:${ev.view} → ${ev.checkpoint.slice(0, 24)}…`);
          },
        });
        break;
      }
      const r = await repo.sync(remote, { as });
      console.log(`synced with ${remote}: pulled ${r.pulled}, pushed ${r.pushed}${r.rejected ? `, rejected ${r.rejected} (gated)` : ""}`);
      break;
    }
    case "land": {
      // Phase 16 M2 (docs/18 §2.2): CLI parity over the same land loop the MCP tool uses,
      // so a human and an agent get identical semantics — landed, or a conflict to decide.
      const repo = await Repo.open(cwd);
      const { land } = await import("./mcp/land.ts");
      const r = await land(repo, {
        view: flag("--view"),
        summary: flag("-m"),
        by: flag("--as") ?? process.env.AVCS_ACTOR ?? "human:cli",
        hub: flag("--remote"),
        workspace: flag("--workspace"),
        maxAttempts: flag("--max-attempts") ? Number(flag("--max-attempts")) : undefined,
      });
      if (r.landed) {
        console.log(`✓ landed — head is now ${r.head.slice(0, 24)}… (${r.attempts} attempt(s), via ${r.via})`);
        break;
      }
      console.error(`✗ not landed (${r.reason}) after ${r.attempts} attempt(s)${r.detail ? ` — ${r.detail}` : ""}`);
      for (const c of (r.conflicts ?? []) as { key?: string; reason?: string }[]) {
        console.error(`  ● ${c.key ?? "?"} — ${c.reason ?? ""}`);
      }
      console.error("  next:");
      for (const a of r.nextActions) console.error(`    - ${a}`);
      process.exitCode = 1;
      break;
    }
    case "submit": {
      // Phase 14 (docs/17): checkpoint the view and submit it to the remote's integration
      // queue. The result is ALWAYS a verdict — never "pull and redo".
      const repo = await Repo.open(cwd);
      const view = flag("--view") ?? "main";
      const remote = flag("--remote") ?? "origin";
      const by = flag("--as") ?? process.env.AVCS_ACTOR ?? "human:cli";
      const checkpoint = await repo.createCheckpoint(view, flag("-m") ?? `submit ${view}`);
      const r = await repo.integrateHub(remote, { view, checkpoint, by });
      switch (r.verdict) {
        case "advanced":
          console.log(`✓ advanced — head is now ${String(r.head).slice(0, 24)}…${r.legacy ? "  [legacy hub fallback]" : ""}`);
          break;
        case "conflict": {
          const packet = r.packet as import("./api/repo.ts").ConflictPacket | undefined;
          console.error(`✗ conflict — ${packet?.conflicts.length ?? 0} key(s) need a decision (repair packet below):`);
          for (const c of packet?.conflicts ?? []) {
            console.error(`  ● ${c.key} — ${c.reason}`);
            for (const o of c.options) console.error(`     - ${o.op.slice(0, 24)}… ${o.actor} :: ${o.purpose}`);
            for (const d of c.priorDecisions) console.error(`     ↩ precedent (${d.decidedBy}): ${d.reason}`);
          }
          console.error(`  decide via MCP avcs.decision.record, then resubmit.`);
          process.exitCode = 1;
          break;
        }
        case "needs_evidence":
          console.log(`… needs_evidence — run validation ONCE against the integrated tree, then resubmit the same ticket:`);
          console.log(`  integrated checkpoint : ${r.integratedCheckpoint}`);
          console.log(`  treeHash              : ${r.treeHash}`);
          console.log(`  required checks       : ${(r.requiredChecks as string[] | undefined)?.join(", ") ?? "(none)"}`);
          console.log(`  ticketId              : ${r.ticketId}`);
          break;
        case "queued":
          console.log(`… queued behind ticket ${String(r.behindTicket).slice(0, 16)}… — retry after ${r.retryAfterMs}ms`);
          break;
        default:
          console.error(`✗ rejected — ${r.reason}`);
          process.exitCode = 1;
      }
      break;
    }
    case "serve": {
      const { startHub } = await import("./hub/hubServer.ts");
      const { consoleLogger } = await import("./observe/logger.ts");
      const dir = args[1] && !args[1].startsWith("--") ? args[1] : cwd;
      const port = Number(flag("--port") ?? 0);
      const gated = args.includes("--gated");
      const quiet = args.includes("--quiet");
      const hub = await startHub({ repoDir: dir, port, gated, logger: quiet ? undefined : consoleLogger("info") });
      console.log(`avcs hub serving ${dir} at ${hub.url}${gated ? " (gated: member-signed ops only)" : ""}`);
      console.log("press Ctrl-C to stop");
      const stop = async () => { await hub.close(); process.exit(0); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await new Promise(() => {}); // run until signalled
      break;
    }
    case "head": {
      const repo = await Repo.open(cwd);
      const view = args[1] ?? "main";
      const h = await repo.protectedHead(view);
      console.log(h ? `${view}: ${h}` : `${view}: (not finalized)`);
      break;
    }
    case "import": {
      const repo = await Repo.open(cwd);
      const src = args[1];
      if (!src) throw new Error("usage: avcs import <source-dir> [-m message] [--author id]");
      const message = flag("-m") ?? flag("--message") ?? `import ${src}`;
      const author = flag("--author") ?? "human:cli";
      // Apply the repo's ignore rules, as `git-sync` already does (issue #48). Without this
      // the same tree captured very differently depending on which command you reached for —
      // `import` pulled node_modules/ and dist/ into history.
      const r = await repo.commitWorkingTree(src, {
        message,
        actor: { kind: "human", id: author },
        ignorePredicate: gitIgnorePredicate(src),
      });
      console.log(`imported ${r.ops.length} file(s) from ${src} (${r.added.length} new)`);
      break;
    }
    case "gc": {
      const repo = await Repo.open(cwd);
      const dryRun = args.includes("--dry-run");
      // `--shared` is opt-in on purpose (docs/21 §3.6): reclaiming a build-environment cache
      // costs somebody an install, which is not a price a routine `gc` may set.
      const shared = args.includes("--shared");
      const r = await repo.gc({ dryRun, ...(shared ? { shared: true } : {}) });
      const verb = dryRun ? "would collect" : "collected";
      console.log(`${verb} ${r.blobs.length} orphan blob(s), ${r.quarantinedOps.length} expired quarantine op(s)`);
      if (shared) console.log(`${verb} ${r.sharedKeys.length} shared cache(s)${r.sharedKeys.length ? `: ${r.sharedKeys.join(", ")}` : ""}`);
      break;
    }
    case "pack": {
      const repo = await Repo.open(cwd);
      const r = await repo.pack();
      console.log(`packed ${r.packed} loose object(s) into a packfile (blobs left loose)`);
      break;
    }
    case "compact": {
      const repo = await Repo.open(cwd);
      const view = args[1] && !args[1].startsWith("--") ? args[1] : "main";
      const r = await repo.compact(view);
      console.log(`compacted ${view}: persisted a base snapshot over ${r.baseOps} op(s) (cold materialize loads it automatically; AVCS_INCREMENTAL=0 to opt out)`);
      break;
    }
    case "bundle": {
      const repo = await Repo.open(cwd);
      const out = args[1];
      if (!out) throw new Error("usage: avcs bundle <out-file>");
      const { writeFile } = await import("node:fs/promises");
      const b = await repo.exportBundle();
      await writeFile(out, JSON.stringify(b), "utf8");
      console.log(`bundled ${b.objects.length} object(s) + ${Object.keys(b.refs).length} ref(s) → ${out}`);
      break;
    }
    case "unbundle": {
      const repo = await Repo.open(cwd);
      const file = args[1];
      if (!file) throw new Error("usage: avcs unbundle <bundle-file>");
      const { readFile } = await import("node:fs/promises");
      const b = JSON.parse(await readFile(file, "utf8"));
      const r = await repo.importBundle(b);
      console.log(`unbundled ${r.objects} object(s), ${r.refs} ref(s)`);
      break;
    }
    case "checkout": {
      const repo = await Repo.open(cwd);
      const view = args[1] && !args[1].startsWith("--") ? args[1] : "main";
      const written = await repo.checkoutInto(cwd, view);
      console.log(`checked out ${written.length} file(s) from ${view}`);
      break;
    }
    case "commit": {
      const repo = await Repo.open(cwd);
      const message = flag("-m") ?? flag("--message");
      if (!message) throw new Error("usage: avcs commit -m <message> [--author <id>] [--line <line>]");
      const author = flag("--author") ?? "human:cli";
      // Same branch → scope mapping as the git bridge, so a capture is in the same place
      // whichever command made it. Outside git this resolves to the base view, as before.
      const scope = await scopeFor(repo, cwd, flag("--line"));
      await ensureLine(repo, scope.line);
      const r = await repo.commitWorkingTree(cwd, { message, actor: { kind: "human", id: author }, ...scope });
      if (!r.ops.length) { console.log("nothing to commit (working tree matches the view)"); break; }
      for (const p of r.added) console.log(`  A ${p}`);
      for (const p of r.modified) console.log(`  M ${p}`);
      for (const p of r.removed) console.log(`  D ${p}`);
      for (const m of r.renamed) console.log(`  R ${m.from} -> ${m.to}`);
      reportContention(r.contention);
      console.log(`committed ${r.ops.length} change(s) into ${scopeLabel(scope)} as "${message}"`);
      break;
    }
    case "undo": {
      // `avcs undo [--last | <op-oid>…] [--purge]` — the pre-share escape hatch (issue #91).
      // Same branch → scope mapping as `commit`, so `--last` names the commit this branch
      // just made rather than whatever the base view happens to hold.
      const repo = await Repo.open(cwd);
      const VALUED = new Set(["--reason", "--author", "--line"]);
      const oids: string[] = [];
      for (let i = 1; i < args.length; i++) {
        const a = args[i] as string;
        if (a.startsWith("--")) { if (VALUED.has(a)) i++; continue; }
        oids.push(a);
      }
      const scope = await scopeFor(repo, cwd, flag("--line"));
      const r = await repo.undo({
        ...(args.includes("--last") ? { last: true } : { ops: oids }),
        ...(scope.line ? { view: scope.line } : {}),
        ...(scope.workspace ? { workspace: scope.workspace } : {}),
        purge: args.includes("--purge"),
        by: flag("--author") ?? "human:cli",
        ...(flag("--reason") ? { reason: flag("--reason") as string } : {}),
      });
      // The git half runs on every `--purge`, including a converged re-run that evicts
      // nothing new: the AVCS side is idempotent, so a retry after a refusal (say, once the
      // tree is clean) must be able to finish the git side it could not do the first time.
      const purging = args.includes("--purge");
      const targeted = [...r.excluded, ...r.alreadyExcluded];
      if (!r.excluded.length && !r.purged.length) {
        console.log(`nothing to undo — ${r.alreadyExcluded.length} op(s) were already undone in ${scopeLabel(scope)}`);
        if (purging) await settleGitAfterPurge(repo, targeted, args.includes("--no-git"));
        break;
      }
      console.log(`undid ${r.excluded.length} op(s) in ${scopeLabel(scope)}`);
      for (const o of r.excluded) console.log(`  - ${o}`);
      if (r.purged.length) console.log(`purged ${r.purged.length} blob(s) — bytes evicted, not recoverable`);
      if (purging) await settleGitAfterPurge(repo, targeted, args.includes("--no-git"));
      if (r.retained.length) console.log(`kept ${r.retained.length} blob(s) a still-selected op references`);
      if (!purging) console.log("(reversible: the ops and their bytes remain; --purge evicts the bytes)");
      console.log(`recorded as ${r.undoOid}`);
      break;
    }
    case "worktree": {
      const sub = args[1];
      const pointer = join(cwd, ".avcs");
      const isOwnStore = existsSync(pointer) && statSync(pointer).isDirectory();
      if (sub === "status") {
        if (!existsSync(pointer)) console.log("not an AVCS working tree (no .avcs here)");
        else if (isOwnStore) console.log(`own store: ${pointer}`);
        else console.log(`attached \u2192 ${ObjectStore.resolveStoreDir(cwd)}`);
        break;
      }
      if (sub === "detach") {
        if (isOwnStore) throw new Error(`${pointer} is a real store, not a pointer \u2014 refusing to remove it`);
        if (!existsSync(pointer)) { console.log("nothing to detach"); break; }
        unlinkSync(pointer);
        console.log("detached (pointer removed)");
        break;
      }
      if (sub !== "attach") throw new Error("usage: avcs worktree attach [--to <dir>] | detach | status");

      // Shadowing a real store is never what someone means: the history already here would
      // become unreachable while looking fine. Say so instead of overwriting it.
      if (isOwnStore) throw new Error(`${cwd} already has its own store (${pointer}) \u2014 move or remove it deliberately before attaching`);
      const to = flag("--to") ?? mainCheckoutOf(cwd);
      if (!to) {
        throw new Error(
          "could not find a main checkout to attach to \u2014 pass `--to <dir>` (the directory holding .avcs). " +
            "Outside a linked git working tree there is nothing to infer from.",
        );
      }
      console.log(`attached \u2192 ${attachWorktree(cwd, to)}`);
      break;
    }
    case "git-sync": {
      const repo = await Repo.open(storeDirFor(cwd));
      const message = flag("-m") ?? flag("--message");
      if (!message) throw new Error("usage: avcs git-sync -m <message> [--commit] [--author <id>] [--line <line>] [--no-add]");
      const author = flag("--author") ?? "human:cli";
      const scope = await scopeFor(repo, cwd, flag("--line"));
      await ensureLine(repo, scope.line);
      const r = await repo.gitSync({ message, actor: { kind: "human", id: author }, workDir: cwd, ...scope, ignorePredicate: gitIgnorePredicate(cwd) });
      for (const p of r.captured.added) console.log(`  A ${p}`);
      for (const p of r.captured.modified) console.log(`  M ${p}`);
      for (const p of r.captured.removed) console.log(`  D ${p}`);
      for (const m of r.captured.renamed) console.log(`  R ${m.from} -> ${m.to}`);
      reportContention(r.contention);
      if (r.conflicts.length) {
        console.error(`\n✗ ${r.conflicts.length} open conflict(s) need a human — refusing to stage a conflicted tree.`);
        console.error(`  run \`avcs conflicts\` to review (it inspects ${scopeLabel(scope)}); resolve, then re-run git-sync.`);
        process.exitCode = 1;
        break;
      }
      console.log(`captured ${r.captured.ops.length} op(s) into ${scopeLabel(scope)} · checkpoint ${r.checkpoint!.slice(0, 16)}… · treeHash ${r.treeHash!.slice(0, 12)}…`);
      console.log(`reprojected ${r.reprojected} file(s)  [git mode: ${r.mode}]`);
      const wantCommit = args.includes("--commit");
      if (!args.includes("--no-add") || wantCommit) {
        const { execFileSync } = await import("node:child_process");
        try {
          execFileSync("git", ["add", "-A"], { cwd, stdio: "inherit" });
          if (wantCommit) {
            // Inject the provenance trailer (git→avcs) then record the SHA back-link (avcs→git).
            const trailerOn = await repo.gitTrailerEnabled();
            const body = trailerOn
              ? `${message}\n\n${repo.gitTrailer({ checkpoint: r.checkpoint!, treeHash: r.treeHash!, ...(r.captured.intent ? { intent: r.captured.intent } : {}) })}`
              : message;
            execFileSync("git", ["commit", "-m", body], { cwd, stdio: "inherit" });
            const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();
            await repo.recordGitCommit(sha, r.checkpoint!);
            console.log(`committed ${sha.slice(0, 12)} ↔ checkpoint ${r.checkpoint!.slice(0, 16)}…  (\`avcs verify-git\` to check)`);
          } else {
            console.log(`staged working tree (git add -A) — now run \`git commit\` (or re-run with --commit)`);
          }
        } catch {
          console.error(`(git step failed — not a git repo? stage/commit manually, or pass --no-add)`);
          process.exitCode = 1;
        }
      }
      break;
    }
    case "verify-git": {
      const repo = await Repo.open(cwd);
      const { execFileSync } = await import("node:child_process");
      const git = (a: string[]): string => execFileSync("git", a, { cwd }).toString();
      let sha: string;
      try {
        sha = args[1] && !args[1].startsWith("--") ? git(["rev-parse", args[1]]).trim() : git(["rev-parse", "HEAD"]).trim();
      } catch {
        console.error(`not a git repo (or bad ref) — verify-git needs a git commit`);
        process.exitCode = 1;
        break;
      }
      // Find the checkpoint: prefer the local back-link ref, fall back to the commit trailer.
      let cp = await repo.gitCheckpoint(sha);
      if (!cp) {
        const m = git(["log", "-1", "--format=%B", sha]).match(/^AVCS-Checkpoint:\s*(\S+)/m);
        cp = m?.[1] ?? null;
      }
      if (!cp) {
        console.error(`✗ no AVCS checkpoint linked to ${sha.slice(0, 12)} (no back-link ref, no trailer)`);
        process.exitCode = 1;
        break;
      }
      const { treeHashOk, files } = await repo.checkpointFiles(cp);
      const avcs = new Map(files.map((f) => [f.path, f.content]));
      // Compare against git's committed tree, excluding the .avcs/ history itself (committed mode).
      const gitPaths = git(["ls-tree", "-r", "--name-only", sha]).split("\n").filter((p) => p && !p.startsWith(".avcs/"));
      const gitSet = new Set(gitPaths);
      const diffs: string[] = [];
      for (const p of gitSet) if (!avcs.has(p)) diffs.push(`  +git only: ${p}`);
      for (const p of avcs.keys()) if (!gitSet.has(p)) diffs.push(`  -avcs only: ${p}`);
      for (const p of gitSet) if (avcs.has(p) && git(["show", `${sha}:${p}`]) !== avcs.get(p)) diffs.push(`  ≠ content: ${p}`);
      if (!treeHashOk) diffs.push(`  ! checkpoint treeHash no longer reproduces from its frontier`);
      if (diffs.length) {
        console.error(`✗ ${sha.slice(0, 12)} does NOT match checkpoint ${cp.slice(0, 16)}… (${diffs.length} difference(s)):`);
        for (const d of diffs.slice(0, 20)) console.error(d);
        process.exitCode = 1;
      } else {
        console.log(`✓ ${sha.slice(0, 12)} is a faithful projection of checkpoint ${cp.slice(0, 16)}… (${avcs.size} file(s) match)`);
      }
      break;
    }
    case "git-mode": {
      const repo = await Repo.open(cwd);
      const want = args[1];
      if (!want) { console.log(`git mode: ${await repo.getGitMode()}`); break; }
      if (want !== "sidecar" && want !== "committed") throw new Error("usage: avcs git-mode [sidecar|committed]");
      await repo.setGitMode(want);
      console.log(`git mode set to: ${want} (rewrote .avcs/.gitignore)`);
      if (want === "committed") console.log(`  next: \`git add .avcs\` to start tracking AVCS history, then commit`);
      else console.log(`  .avcs/ is now git-ignored; \`git rm -r --cached .avcs\` to stop tracking already-committed history`);
      break;
    }
    case "trunk": {
      // The branch that carries the base view (docs/20 §3.1). Everything else on this repo's
      // branches is a converging workspace, so this one setting decides the whole mapping.
      const repo = await Repo.open(cwd);
      const want = args[1];
      if (!want || want.startsWith("--")) {
        console.log(`trunk: ${await repo.getTrunk()}`);
        const branches = await repo.trunkBranches();
        if (branches.length > 1) console.log(`  (not configured — ${branches.join(" and ")} both count as trunk, as before \`avcs trunk\` existed)`);
        console.log(`  every other branch maps to a workspace of the same name; \`git merge\` into trunk lands it`);
        break;
      }
      await repo.setTrunk(want);
      console.log(`trunk set to: ${want}`);
      break;
    }
    case "reindex": {
      const repo = await Repo.open(cwd);
      const r = await repo.reindex();
      console.log(`reindexed ${r.ops} operation(s) into the entity index`);
      break;
    }
    case "install-hooks": {
      await Repo.open(cwd); // validate this is an AVCS repo
      const { execFileSync } = await import("node:child_process");
      let hooksDir: string;
      try {
        // Silenced for the same reason as in `init`: the catch below reports the missing
        // git repo in this CLI's own words, so git's raw `fatal:` would only duplicate it.
        const gp = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
        const { isAbsolute, join } = await import("node:path");
        hooksDir = isAbsolute(gp) ? gp : join(cwd, gp);
      } catch {
        console.error(`not a git repo — run \`git init\` first`);
        process.exitCode = 1;
        break;
      }
      const { installed, skipped } = await installHooks(hooksDir, avcsInvocation(), args.includes("--force"));
      if (installed.length) console.log(`installed git hooks: ${installed.join(", ")}`);
      if (skipped.length) console.log(`skipped (foreign hook present, use --force): ${skipped.join(", ")}`);
      console.log(`now \`git commit\` auto-runs avcs sync; \`git pull\`/\`merge\` auto-reprojects`);
      break;
    }
    case "git-hook": {
      // Internal dispatch target for the installed hook scripts (docs/14). Each phase is
      // designed to be safe to run by hand, and a no-op when there is nothing to do.
      const phase = args[1];
      // A git-bridge hook must never hard-block git indefinitely (#33). Every store-touching
      // step runs under a deadline; if it elapses we fail open — let git proceed, warn, and
      // let the next sync catch up — rather than spinning forever. AVCS_HOOK_TIMEOUT_MS=0
      // restores the old unbounded behavior; a non-zero value overrides the default.
      const hookMs = hookTimeoutMs();
      // `git worktree add` fires post-checkout inside the brand-new tree, which is exactly
      // when the store pointer should appear — before anything tries to open a store there.
      // A plain branch switch is a no-op: the tree already has a store or a pointer.
      if (phase === "post-checkout") {
        if (!existsSync(join(cwd, ".avcs"))) {
          const to = mainCheckoutOf(cwd);
          if (to && ObjectStore.isRepo(to)) {
            try {
              console.log(`avcs: attached this working tree \u2192 ${attachWorktree(cwd, to)}`);
            } catch (e) {
              console.error(`avcs: could not attach this working tree (${(e as Error).message})`);
            }
          }
        }
        break; // never blocks the checkout
      }
      // A timed-out hook must EXIT, not merely `break` (issue #64). `withDeadline`
      // races a timer against the work; it cannot cancel it (deadline.ts has no
      // AbortSignal, and a synchronous section would starve the timer anyway). The
      // abandoned ingest keeps running — reading the whole work tree, spawning git per
      // entry, rewriting the projection — and git waits for this child process to exit,
      // so "fail open" held only on paper: the commit still blocked for as long as the
      // full ingest took (10s+ on a mid-sized repo against a 300ms deadline).
      //
      // Exiting drops that work with the process. Safe by design here: every hook phase
      // already treats a timeout as skippable (the change is captured on the next sync),
      // and exiting also removes a worse hazard — a zombie hook's `checkoutInto`
      // overwriting the work tree while git is committing it.
      function failOpen(message: string): never {
        console.error(message);
        process.exit(0);
      }

      const author = process.env.AVCS_AUTHOR ?? "human:cli";
      // cwd is the working tree (possibly a linked git worktree); the store may live in
      // the main checkout. Opening the store can itself block under contention, so bound it.
      const opened = await withDeadline(() => Repo.open(storeDirFor(cwd)), hookMs);
      if (!opened.ok)
        failOpen(`avcs: opening the store exceeded ${hookMs}ms — skipping git-hook ${phase} (#33). Another avcs process may be holding it; set AVCS_HOOK_TIMEOUT_MS=0 to wait.`);
      const repo = opened.value;
      switch (phase) {
        case "pre-commit": {
          // Capture working-tree edits as ops, gate on conflicts, checkpoint, reproject,
          // re-stage the canonical projection, and stash the provenance for the next hooks.
          const message = process.env.AVCS_COMMIT_MESSAGE ?? "git commit";
          const res = await withDeadline(async () => {
            // docs/20 §3.3: on trunk this captures to the base view; on a topic branch it
            // captures into that branch's workspace, where it stays isolated until it lands.
            const scope = await scopeFor(repo, cwd);
            await ensureLine(repo, scope.line);
            return repo.gitSync({ message, actor: { kind: "human", id: author }, workDir: cwd, ...scope, ignorePredicate: gitIgnorePredicate(cwd) });
          }, hookMs);
          if (!res.ok)
            failOpen(`avcs: pre-commit ingest exceeded ${hookMs}ms — proceeding without audit capture (#33). The change will be captured on the next sync. Set AVCS_HOOK_TIMEOUT_MS=0 to wait, or check for another avcs process holding the store.`);
          const r = res.value;
          reportContention(r.contention);
          if (r.conflicts.length) {
            console.error(`avcs: ${r.conflicts.length} open conflict(s) — resolve via \`avcs conflicts\` before committing.`);
            process.exit(1); // abort the commit
          }
          execFileSync("git", ["add", "-A"], { cwd, stdio: "inherit" });
          await repo.writeGitPending({ checkpoint: r.checkpoint!, treeHash: r.treeHash!, ...(r.captured.intent ? { intent: r.captured.intent } : {}) }, cwd);
          break;
        }
        case "prepare-commit-msg": {
          // args: [2]=msgFile [3]=source [4]=sha. Append the trailer if enabled & absent.
          const msgFile = args[2];
          if (!msgFile) break;
          const res = await withDeadline(async () => {
            const pending = await repo.readGitPending(cwd);
            if (!pending || !(await repo.gitTrailerEnabled())) return;
            const { readFile, writeFile } = await import("node:fs/promises");
            const cur = await readFile(msgFile, "utf8");
            if (cur.includes("AVCS-Checkpoint:")) return;
            const trailer = repo.gitTrailer({ checkpoint: pending.checkpoint, treeHash: pending.treeHash, ...(pending.intent ? { intent: pending.intent } : {}) });
            await writeFile(msgFile, `${cur.replace(/\n*$/, "")}\n\n${trailer}\n`, "utf8");
          }, hookMs);
          if (!res.ok) failOpen(`avcs: prepare-commit-msg exceeded ${hookMs}ms — commit trailer skipped (#33).`);
          break;
        }
        case "post-commit": {
          // `git rev-parse` is a synchronous interop call that returns instantly; keep it
          // outside the deadline, whose callback is meant to bound *async* store work — a
          // sync call inside it would starve the timer (see deadline.ts). All store I/O
          // (read/record/clear pending) stays within the bound.
          const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();
          const res = await withDeadline(async () => {
            const pending = await repo.readGitPending(cwd);
            if (!pending) return;
            await repo.recordGitCommit(sha, pending.checkpoint);
            await repo.clearGitPending(cwd);
          }, hookMs);
          if (!res.ok) failOpen(`avcs: post-commit bookkeeping exceeded ${hookMs}ms — commit↔checkpoint link deferred (#33).`);
          break;
        }
        case "post-merge": {
          // A git pull/merge changed the working tree. Committed mode also unioned new
          // `.avcs` objects straight onto disk — rebuild the rebuildable logs/indexes
          // first so materialize sees them. Then CAPTURE-then-reproject (gitSync), not a
          // bare checkoutInto: in sidecar mode the pulled content exists ONLY in git, and
          // reprojecting a stale avcs view would silently revert files the pull just
          // updated (observed live: a release version bump undone by the old hook).
          // Capturing first ingests the pulled tree as ops, making reprojection a no-op
          // on it; in committed mode the capture finds no diff and this reduces to the
          // old behavior plus a checkpoint.
          const res = await withDeadline(async () => {
            await repo.reindex();
            // docs/20 §3.4 — the seam this track exists for: a merge into trunk IS the land
            // of the merged branch's workspace. It runs BEFORE the capture on purpose. Once
            // landed, those ops are in the base view, so the merged content already projects
            // and the capture below has nothing to re-author; land afterwards and the same
            // content would be captured a second time as untagged base ops.
            const outcome = await landMergedWorkspace(repo, cwd);
            const scope = await scopeFor(repo, cwd);
            await ensureLine(repo, scope.line);
            const sync = await repo.gitSync({ message: process.env.AVCS_COMMIT_MESSAGE ?? "git merge", actor: { kind: "human", id: author }, workDir: cwd, ...scope, ignorePredicate: gitIgnorePredicate(cwd) });
            return { outcome, scope, sync };
          }, hookMs);
          if (!res.ok) failOpen(`avcs: post-merge sync exceeded ${hookMs}ms — skipped; run \`avcs git-sync -m "post-merge" --no-add\` if the store looks stale (#33).`);
          else {
            const { outcome, scope, sync } = res.value;
            if ("landed" in outcome) console.log(`avcs: landed workspace ${outcome.landed} — its ops are now part of the base view`);
            else if (outcome.needsHuman) {
              // Never silent: a hook that says nothing lets someone believe the land happened.
              console.error(`avcs: landed NOTHING — ${outcome.declined}.`);
              console.error(`  a squash merge leaves no merge commit to read, so this can be normal; confirm it by hand with \`avcs workspace land <workspace>\` (\`avcs workspace list\` shows what has landed).`);
            } else console.log(`avcs: nothing to land — ${outcome.declined}`);
            reportContention(sync.contention);
            if (sync.conflicts.length) console.error(`avcs: ${sync.conflicts.length} open conflict(s) after merge — run \`avcs conflicts ${scope.line ?? "main"}\`.`);
          }
          break;
        }
        default:
          console.error(`unknown git-hook phase: ${phase}`);
          process.exitCode = 1;
      }
      break;
    }
    case "lines": {
      const repo = await Repo.open(cwd);
      const lines = await repo.listLines();
      console.log("main  (root)");
      for (const l of lines) console.log(`${l.name}  ← forked from ${l.baseLine} @ ${l.forkCheckpointOid?.slice(0, 16)}`);
      break;
    }
    case "log": {
      const store = new ObjectStore(cwd);
      const ops = await store.collect<Operation>("operation");
      ops.sort((a, b) => a.lamport - b.lamport);
      for (const op of ops) {
        const tgt = `${op.target.entityKind}:${op.target.entityId}`;
        console.log(
          `[${String(op.lamport).padStart(3, "0")}] ${op.actor.id}  ${op.body.kind} ${tgt}` +
            `\n        ${op.declaredPurpose}`,
        );
      }
      break;
    }
    case "materialize": {
      const repo = await Repo.open(cwd);
      const view = args[1] && !args[1].startsWith("--") ? args[1] : "main";
      const res = await repo.materialize(view);
      const out = flag("--out");
      if (out) {
        await repo.writeWorkspace(res, out);
        console.log(`wrote ${res.tree.size} files to ${out}`);
      } else {
        for (const p of [...res.tree.keys()].sort()) console.log(p);
      }
      break;
    }
    case "shared": {
      // Build-environment sharing (docs/21): the path rules whose content the core keeps out
      // of the op graph but still puts in the directory. This command only EDITS the rules —
      // the linking happens at projection time, and nothing here ever runs an install.
      const repo = await Repo.open(cwd);
      const sub = args[1];
      if (!sub || sub === "ls") {
        const entries = await repo.readSharedPaths();
        if (!entries.length) { console.log("(no shared paths — `avcs shared add <path> --key-from <file>`)"); break; }
        for (const e of entries) {
          const keyFrom = e.keyFrom?.length ? e.keyFrom.join(",") : "(unkeyed — one cache for every workspace)";
          console.log(`${e.path}  mode=${e.mode ?? "symlink"}  key-from=${keyFrom}`);
        }
      } else if (sub === "add") {
        const path = args[2];
        if (!path || path.startsWith("--")) throw new Error("usage: avcs shared add <path> [--key-from <file>[,<file>...]] [--mode symlink|copy]");
        const keyFrom = (flag("--key-from") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const mode = flag("--mode");
        if (mode && mode !== "symlink" && mode !== "copy") throw new Error(`--mode must be symlink or copy: ${mode}`);
        await repo.addSharedPath({ path, keyFrom, ...(mode ? { mode: mode as "symlink" | "copy" } : {}) });
        console.log(`shared: ${path} (mode=${mode ?? "symlink"}, key-from=${keyFrom.length ? keyFrom.join(",") : "(unkeyed)"})`);
        if (!keyFrom.length) console.log("  warning: no --key-from, so EVERY workspace shares one cache regardless of its lockfiles (docs/21 §3.2)");
      } else if (sub === "rm") {
        // `--cache <key>` throws away a cache directory (docs/21 R2: the core only reports
        // "non-empty", so a half-finished install is the caller's to discard).
        const key = flag("--cache");
        if (key) {
          const dropped = await repo.dropSharedCache(key);
          console.log(dropped ? `dropped shared cache ${key}` : `no shared cache ${key}`);
          break;
        }
        const path = args[2];
        if (!path) throw new Error("usage: avcs shared rm <path> | avcs shared rm --cache <key>");
        console.log(await repo.removeSharedPath(path) ? `removed shared path ${path} (its cache is kept — use \`avcs gc --shared\`)` : `no shared path ${path}`);
      } else {
        throw new Error("usage: avcs shared <ls|add|rm> ...");
      }
      break;
    }
    case "workspace": {
      // Native build/verify isolation (docs/16): project a workspace's view to a dir,
      // land it onto its base, or list landed workspaces. `project` is the physical
      // checkout that lets concurrent agents build without colliding on disk.
      const repo = await Repo.open(cwd);
      const sub = args[1];
      if (sub === "project") {
        const name = args[2];
        if (!name || name.startsWith("--")) throw new Error("usage: avcs workspace project <name> [--out <dir>]");
        const out = flag("--out") ?? cwd;
        // The base a workspace sits on is its TRUNK's view, which the view name `main` only
        // happened to spell in repos whose trunk is called main. Resolve it through the very
        // same mapping the capture path uses, so `project` and `git-sync` can never disagree
        // about what "base" means: a trunk that is (still) an avcs line projects that line,
        // otherwise the default view.
        const trunk = await repo.getTrunk();
        const trunkScope = scopeForBranch(trunk, await repo.trunkBranches(), {
          hasExistingLine: !!(await repo.store.getRef(`line:${trunk}`)),
        });
        const view = flag("--view") ?? trunkScope.line ?? "main";
        const projected = await repo.projectInto(out, view, { workspace: name });
        console.log(`projected workspace ${name} over ${view}: ${projected.written.length} file(s) to ${out}`);
        // Shared build environment (docs/21). The core linked a cache and reported whether it
        // is empty; running the install is the caller's job and stays the caller's job, so all
        // this does is say which side of that line each path is on.
        for (const s of projected.shared) {
          const state = !s.linked ? "NOT LINKED" : s.populated ? "ready" : "EMPTY — run your install once";
          console.log(`shared: ${s.path} → ${s.cache} (${state})`);
          if (s.warning) console.log(`  warning: ${s.warning}`);
        }
        if (projected.skipped.length) {
          console.error(`avcs: ${projected.skipped.length} recorded file(s) live inside a shared path and were NOT written (e.g. ${projected.skipped[0]}).`);
          console.error(`  that history predates this shared-path rule; capture can no longer add to it.`);
        }
      } else if (sub === "land") {
        const name = args[2];
        if (!name) throw new Error("usage: avcs workspace land <name>");
        await repo.landWorkspace(name);
        console.log(`landed workspace ${name}`);
      } else if (sub === "list") {
        // Since a topic branch maps to a workspace (docs/20), being UN-landed is the normal
        // state of live work — a listing that showed only landed ones would hide everything
        // currently in flight. Both are shown, each marked for what it is.
        const landed = new Set(await repo.landedWorkspaces());
        const all = await repo.workspaceNames();
        for (const n of landed) if (!all.includes(n)) all.push(n); // landed but ops gone (redacted/gc)
        if (!all.length) { console.log("(no workspaces)"); break; }
        for (const n of all.sort()) console.log(`${landed.has(n) ? "landed   " : "in flight"}  ${n}`);
      } else {
        throw new Error("usage: avcs workspace <project|land|list> ...");
      }
      break;
    }
    case "checkpoint": {
      const repo = await Repo.open(cwd);
      const view = args[1] ?? "main";
      const oid = await repo.createCheckpoint(view, flag("-m") ?? "checkpoint");
      console.log(oid);
      break;
    }
    case "release": {
      const repo = await Repo.open(cwd);
      const view = args[1] && !args[1].startsWith("--") ? args[1] : "main";
      const res = await repo.cutRelease(view, { summary: flag("-m") ?? `release of ${view}` });
      if (!res.released) {
        console.error(`cannot release: ${res.reason}`);
        process.exitCode = 1;
        break;
      }
      const rel = await repo.store.get(res.releaseOid) as { treeHash: string; sbom: { components: unknown[] }; evidence: Record<string, string> };
      console.log(`released ${res.releaseOid}`);
      console.log(`  treeHash : ${rel.treeHash}`);
      console.log(`  sbom     : ${rel.sbom.components.length} components`);
      console.log(`  evidence : ${JSON.stringify(rel.evidence)}`);
      break;
    }
    case "fsck": {
      const store = new ObjectStore(cwd);
      if (!ObjectStore.isRepo(cwd)) throw new Error("not an AVCS repo (no .avcs here)");
      const rebuild = args.includes("--rebuild");
      const r = await store.fsck({ rebuild });
      console.log(`checked ${r.objectsChecked} object(s)`);
      if (r.corrupt.length) {
        console.log(`\n✗ ${r.corrupt.length} corrupt object(s):`);
        for (const c of r.corrupt) console.log(`   ${c.oid}  — ${c.reason}`);
      }
      const d = r.oplogDrift;
      if (d.opsMissingFromLog.length)
        console.log(`\n${rebuild ? "↻ repaired" : "✗"} op-log drift: ${d.opsMissingFromLog.length} operation(s) missing from the log${rebuild ? "" : " (run `avcs fsck --rebuild`)"}`);
      if (d.logEntriesMissingObject.length)
        console.log(`\nℹ ${d.logEntriesMissingObject.length} op-log entr(y/ies) without an object (GC'd or lost)`);
      if (r.repaired) console.log(`   op-log rebuilt → ${r.repaired.oplogEntries} entr(y/ies)`);
      console.log(r.ok ? "\n✓ healthy" : rebuild && r.corrupt.length === 0 ? "\n✓ repaired" : "\n✗ problems found");
      if (!r.ok && !(rebuild && r.corrupt.length === 0)) process.exitCode = 1;
      break;
    }
    case "show": {
      const store = new ObjectStore(cwd);
      const oid = args[1];
      if (!oid) throw new Error("usage: avcs show <oid>");
      console.log(JSON.stringify(await store.get(oid), null, 2));
      break;
    }
    case "mcp": {
      // AVCS's primary, agent-facing interface. `avcs mcp` boots the stdio MCP server
      // (this is what Claude/agents spawn); `avcs mcp install` registers it with the
      // Claude Code CLI. The server loads `@modelcontextprotocol/sdk` lazily, so all the
      // commands above keep working even when that optionalDependency is absent.
      const sub = args[1] && !args[1].startsWith("-") ? args[1] : undefined;
      if (sub === "install") {
        // Mirror `install-hooks`: the registered command re-invokes the EXACT binary the
        // user is running now — node + any --experimental-strip-types flag + this script —
        // so it works for a global install and a source checkout alike.
        const scope = flag("-s") ?? flag("--scope") ?? "user";
        const repoDir = flag("--repo");
        const serverArgv = [process.execPath, ...process.execArgv, process.argv[1]!, "mcp"];
        const addArgs = ["mcp", "add", "avcs", "-s", scope];
        if (repoDir) addArgs.push("-e", `AVCS_REPO=${repoDir}`);
        addArgs.push("--", ...serverArgv);
        const pretty = `claude ${addArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
        const { execFileSync } = await import("node:child_process");
        try {
          execFileSync("claude", addArgs, { stdio: "inherit" });
          console.log(`\nregistered avcs MCP server (scope: ${scope}). Verify with \`claude mcp list\`.`);
        } catch (e) {
          const enoent = (e as NodeJS.ErrnoException)?.code === "ENOENT";
          console.error(
            (enoent
              ? "Claude Code CLI ('claude') not found on PATH. Register it manually:"
              : "`claude mcp add` failed. You can register it manually:") + `\n\n  ${pretty}\n`,
          );
          process.exitCode = 1;
        }
        break;
      }
      if (sub) {
        console.error(`unknown mcp subcommand: ${sub} — use \`avcs mcp\` to serve or \`avcs mcp install\` to register`);
        process.exitCode = 1;
        break;
      }
      const { startMcpServer } = await import("./mcp/server.ts");
      // `--profile core` advertises only the canonical loop's 13 tools (docs/18 §M5).
      await startMcpServer({ profile: flag("--profile") });
      break;
    }
    case "help":
    default:
      console.log(
        "avcs <command>\n\n" +
          "  init [dir] [--mode m]       create a repo (--mode sidecar|committed, default sidecar)\n" +
          "  status [view]               operation/conflict summary\n" +
          "  key provision <actor-id> | key ls   local signing keys (decisions, hub writes)\n" +
          "  conflicts [view] [--workspace w]  list decisions a human owes (defaults to this branch's scope)\n" +
          "  import <dir> [-m msg]       import an existing tree (e.g. a git repo) as ops\n" +
          "  gc [--dry-run] [--shared]   reclaim orphan blobs + expired quarantine ops (--shared: unused build caches)\n" +
          "  pack                        fold loose objects into a packfile (blobs stay loose)\n" +
          "  compact [view]              persist a base snapshot (cold materialize folds history)\n" +
          "  fsck [--rebuild]            verify object integrity + op-log; --rebuild repairs the log\n" +
          "  bundle <file>               export the whole repo to a portable file\n" +
          "  unbundle <file>             import a bundle into this repo\n" +
          "  checkout [view]             write the view's files into the working dir\n" +
          "  commit -m <msg> [--author id]  author ops for working-tree changes\n" +
          "  undo [--last | <op-oid>…] [--purge] [--no-git] [--reason r]  drop local ops from the view;\n" +
          "                              --purge also evicts the bytes they uniquely reference (irreversible),\n" +
          "                              and in a git repo removes the commit(s) holding them too — only when\n" +
          "                              nothing is pushed, they are at the tip, and no other work would be\n" +
          "                              lost. Otherwise it says what is left. --no-git skips the git half.\n" +
          "                              Refuses once the ops have been pushed — that case is `redact` (admin)\n" +
          "  git-sync -m <msg> [--commit]   capture edits → checkpoint → reproject → git add (--commit: also commit w/ trailer)\n" +
          "  git-mode [sidecar|committed]   show/set how AVCS history relates to git\n" +
          "  verify-git [<commit>]       check a git commit is a faithful projection of its AVCS checkpoint\n" +
          "  install-hooks [--force]     install git hooks so `git commit`/`pull` auto-sync AVCS\n" +
          "  worktree attach|detach|status  share the main checkout's store from a linked working tree\n" +
          "  reindex                     rebuild the entity index (after a git pull of .avcs objects)\n" +
          "  serve [dir] [--port N] [--gated]  run a hub (HTTP) over a repo\n" +
          "  clone <hub-url> [dir] [--key <repo-dir|key-file>] [--as <id>]  create a repo from a hub\n" +
          "  remote add <name> <url>     register a named hub ([--auto-sync] [--freshness-ms N])\n" +
          "  remote rm <name> | remote ls   manage named hubs (.avcs/remotes.json)\n" +
          "  sync [remote] [--as <id>]   pull + push against a named remote (default origin)\n" +
          "  sync --watch [remote]       live-convergence daemon: /events long-poll + contention early warning\n" +
          "  land [--view v] [--remote r] [-m msg] [--as <id>] [--workspace w]  push+merge-check+checkpoint+integrate in one step\n" +
          "  submit [--view v] [--remote r] [-m msg] [--as <id>]  checkpoint + integration-queue submit (never pull-and-redo)\n" +
          "  push <hub-url> [--as <id>] push objects to a hub (signs writes with the actor's key)\n" +
          "  pull <hub-url | dir>        sync objects from a hub or local repo\n" +
          "  head [view]                 show the protected head\n" +
          "  lines                       list lineage lines (Phase 8)\n" +
          "  trunk [<branch>]            show/set the branch that carries the base view (docs/20)\n" +
          "  workspace project <n> [--out d] | land <n> | list   converging work scopes (docs/16, 20)\n" +
          "  shared ls | add <path> [--key-from f,f] [--mode symlink|copy] | rm <path>|--cache <key>\n" +
          "                              build environments shared across workspaces (docs/21)\n" +
          "  blame <entityKey> [--line l] who owns an entity and why\n" +
          "  diff <viewA> <viewB>        added/removed/modified paths\n" +
          "  log                         operation history\n" +
          "  materialize [view] [--out d]  project the code tree\n" +
          "  checkpoint <view> [-m msg]  freeze a verified state\n" +
          "  release [view] [-m msg]     cut a verified release + SBOM\n" +
          "  show <oid>                  dump an object\n" +
          "  mcp [--profile core]        run the agent-facing MCP server over stdio (primary interface)\n" +
          "  mcp install [-s scope] [--repo d]  register avcs with the Claude Code CLI (`claude mcp add`)\n" +
          "  version | --version | -v    print the avcs version\n" +
          "  help | --help | -h          show this help\n",
      );
      if (cmd && cmd !== "help") process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
