// Phase 10: diffing two materialized states.
//
// Tree entries are content-addressed (put_file blob oids and synth oids are both
// content-derived), so a path whose oid is unchanged is unchanged — diffing is just
// a map comparison. The AVCS-only axis is a *policy diff*: reduce the same ops under
// two policies and diff the trees to see what the policy change alone did.

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
