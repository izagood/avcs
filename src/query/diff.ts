// Phase 10: diffing two materialized states.
//
// Tree entries are content-addressed (put_file blob oids and synth oids are both
// content-derived), so a path whose oid is unchanged is unchanged — diffing is just
// a map comparison. The AVCS-only axis is a *policy diff*: reduce the same ops under
// two policies and diff the trees to see what the policy change alone did.

import { diffHunks } from "../merge/merge3.ts";
import type { ReductionResult } from "../reducer/reducer.ts";

export interface TreeDiff {
  added: string[];
  removed: string[];
  modified: string[];
}

export function diffTrees(a: ReductionResult, b: ReductionResult): TreeDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [path, oid] of b.tree) {
    if (!a.tree.has(path)) added.push(path);
    else if (a.tree.get(path) !== oid) modified.push(path);
  }
  for (const path of a.tree.keys()) if (!b.tree.has(path)) removed.push(path);
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort() };
}

/**
 * Unified diff of two texts (Phase 16 M1.2, docs/18 §1.2).
 *
 * Built on merge3's LCS hunk core rather than a second diff implementation: a patch an
 * agent reads must describe the same line changes the reducer would merge, and two
 * independent algorithms would eventually disagree about which lines moved.
 *
 * `context` lines surround each hunk; adjacent hunks whose context would overlap are
 * emitted as one, the way `diff -u` does.
 */
export function unifiedDiff(a: string, b: string, opts: { context?: number } = {}): string {
  const ctx = opts.context ?? 3;
  const split = (s: string): string[] => (s === "" ? [] : s.split("\n").slice(0, s.endsWith("\n") ? -1 : undefined));
  const al = split(a);
  const bl = split(b);
  const hunks = diffHunks(al, bl);
  if (!hunks.length) return "";

  // Group hunks whose context windows touch, so the output reads like diff -u.
  const groups: (typeof hunks)[] = [];
  for (const h of hunks) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && h.start - prev.end <= ctx * 2) last!.push(h);
    else groups.push([h]);
  }

  const out: string[] = [];
  for (const group of groups) {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const from = Math.max(0, first.start - ctx);
    const to = Math.min(al.length, last.end + ctx);
    // Count the b-side span: leading context + each hunk's replacement + the gaps between.
    let bCount = 0;
    let cur = from;
    const body: string[] = [];
    for (const h of group) {
      for (let i = cur; i < h.start; i++) { body.push(` ${al[i]!}`); bCount++; }
      for (let i = h.start; i < h.end; i++) body.push(`-${al[i]!}`);
      for (const l of h.lines) { body.push(`+${l}`); bCount++; }
      cur = h.end;
    }
    for (let i = cur; i < to; i++) { body.push(` ${al[i]!}`); bCount++; }
    const aCount = to - from;
    out.push(`@@ -${from + 1},${aCount} +${from + 1},${bCount} @@`, ...body);
  }
  return out.join("\n") + "\n";
}

export interface OpSetDiff {
  /** Accepted in b but not a. */
  added: string[];
  /** Accepted in a but not b. */
  removed: string[];
}

/** Symmetric difference of the accepted operation sets of two reductions. */
export function diffAcceptedOps(a: ReductionResult, b: ReductionResult): OpSetDiff {
  const accepted = (r: ReductionResult) =>
    new Set([...r.statuses].filter(([, s]) => s === "accepted").map(([oid]) => oid));
  const sa = accepted(a);
  const sb = accepted(b);
  return {
    added: [...sb].filter((o) => !sa.has(o)).sort(),
    removed: [...sa].filter((o) => !sb.has(o)).sort(),
  };
}
