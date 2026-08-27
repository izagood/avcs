// Bridge-layer name mapping (docs/20): which AVCS scope a git branch stands for, and which
// branch a git merge brought in. Both are PURE — no git, no store, no I/O — so the decisions
// that matter most here can be tested directly instead of through a hook firing inside a
// temporary repository. The git calls that feed them stay in the CLI (src/cli.ts), keeping
// the core git-agnostic.

/** The AVCS scope a working tree writes into. Empty ⇒ the base view (no tag at all). */
export type BranchScope = { line?: string; workspace?: string };

/**
 * Map a git branch to an AVCS scope (docs/20 §3.2). A topic branch is work that intends to
 * CONVERGE, so it becomes a workspace; a line is permanent divergence and is only ever
 * chosen deliberately.
 *
 *   explicit `--line`         → { line }        a human asking to diverge
 *   detached HEAD / no git    → { }             the base view, untagged
 *   a branch with a line ref  → { line }        pre-existing work keeps its history (W9)
 *   trunk                     → { }             the base view, untagged
 *   anything else             → { workspace }   a converging topic branch
 *
 * `hasExistingLine` is the caller's answer to "is there already a `line:<branch>` ref?".
 * Remapping such a branch to a workspace would leave its captured history unreachable from
 * the view it has been accumulating in, so the old mapping wins for as long as it exists.
 * It is checked BEFORE trunk on purpose: in a repository from before `trunk` existed, a trunk
 * named anything but main/master had itself become a line, and its accumulated work lives in
 * that line's view — sending new captures to the default view would split the history in two.
 */
export function scopeForBranch(
  branch: string | null | undefined,
  trunks: Iterable<string>,
  opts: { explicitLine?: string; hasExistingLine?: boolean } = {},
): BranchScope {
  if (opts.explicitLine) return { line: opts.explicitLine };
  // Detached HEAD or no git: there is no branch to name a scope after, so write to base —
  // identical to what the pre-trunk `lineFor` did with `"HEAD"`.
  if (!branch || branch === "HEAD") return {};
  if (opts.hasExistingLine) return { line: branch };
  for (const t of trunks) if (branch === t) return {};
  return { workspace: branch };
}

/**
 * The single branch a completed git merge brought in, read off git's own reflog subject, or
 * `null` when it cannot be read off unambiguously (docs/20 §3.4).
 *
 * `post-merge` receives no arguments and runs after `MERGE_HEAD` is gone, so the reflog is
 * the only record of what was merged. Landing is append-only and irreversible, so anything
 * short of one unmistakable branch name returns null and the caller must land NOTHING
 * (docs/20 R1): an octopus merge names several, a squash merge (R2) names none at all.
 */
export function mergedBranchFromReflog(subject: string | null | undefined): string | null {
  if (!subject) return null;
  // git writes "<what happened>: <how>", e.g. "merge topic: Merge made by the 'ort' strategy."
  const head = subject.trim().split(": ")[0];
  if (!head) return null;
  // Flags carry no branch name and vary by invocation; drop them before counting operands.
  const tokens = head.split(/\s+/).filter((t) => !t.startsWith("-"));
  const verb = tokens[0];
  let name: string | undefined;
  // Exactly one operand in either shape. More than one is an octopus merge (or a multi-ref
  // pull): several branches landed at once, there is no single answer, and that is precisely
  // when guessing is worst. Fewer means git recorded no ref at all ("pull: Fast-forward").
  if (verb === "merge" && tokens.length === 2) name = tokens[1];
  else if (verb === "pull" && tokens.length === 3) name = tokens[2];
  else return null;
  return !name || name === "HEAD" ? null : name; // "HEAD" is a position, not a branch

}
