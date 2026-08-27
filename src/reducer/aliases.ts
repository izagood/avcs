// Path aliases: the rename closure that restores rename × edit commutativity (docs/19 §3.2).
//
// A file's identity in this core is its PATH (`OperationTarget.entityId`). That makes a
// move and a concurrent edit of the same file look like two unrelated writes to two
// unrelated paths, and which of the two the reducer sees first decides whether the tree
// comes out right — correctness left to a lamport coincidence.
//
// The fix is to stop applying a content op at the path its author NAMED and apply it at
// the path the file actually ended up at. This module computes that mapping — "original
// path → final path" — from the accepted `rename_file` closure alone. It is a pure
// function of (rename set, canonical order, causal relation), all three of which are
// already deterministic, so the mapping is deterministic too and Pass B only reads it.
//
// Deliberately NOT here: any notion of identity stored on an operation. That is a later
// stage (docs/19 §3.3) and needs a schema field; this stage DERIVES identity from the
// rename graph and needs none.

import type { Operation } from "../objects/types.ts";

export interface AliasMap {
  /** Original path → final path, chased through the whole rename chain. */
  readonly final: ReadonlyMap<string, string>;
  /** Paths no single destination can be derived for (concurrent multi-destination
   *  renames, or a rename cycle). These are NOT moved — conflict detection reports
   *  them and a human decides. */
  readonly contested: ReadonlySet<string>;
  /** rename op oid → the `fromPath` that op moved. Input to the causal condition in
   *  {@link resolvePath}. */
  readonly byOp: ReadonlyMap<string, string>;
}

const cmp = (a: string | undefined, b: string | undefined): number => {
  const x = a ?? "";
  const y = b ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Build the path alias map from a set of `rename_file` operations.
 *
 * `renames` should be the ops actually projected into the tree (accepted, or whatever
 * `materializeStatuses` admits). `isConcurrent(a, b)` answers whether two op oids are
 * causally unrelated.
 *
 * Two renames moving the SAME source to DIFFERENT destinations are only a genuine
 * contest when they are concurrent; when they are causally ordered they are a chain the
 * author walked deliberately, and the latest (canonical (lamport, oid)) hop wins. A
 * contested source is left where it is and reported, never moved somewhere arbitrary —
 * silent data loss is the one outcome worse than a conflict.
 *
 * Every iteration order here is sorted rather than insertion-derived, so the returned
 * maps are byte-identical no matter what order the caller enumerated the renames in.
 */
export function buildAliasMap(
  renames: Operation[],
  isConcurrent: (a: string, b: string) => boolean,
): AliasMap {
  type Hop = { to: string; oid: string; lamport: number };
  const direct = new Map<string, Hop[]>();
  const byOp = new Map<string, string>();
  // Canonical order first: the "latest hop wins" tie-break below must not depend on the
  // order the caller happened to enumerate.
  const ordered = [...renames].sort((a, b) => a.lamport - b.lamport || cmp(a.oid as string, b.oid as string));
  for (const r of ordered) {
    const from = r.body.fromPath;
    const to = r.body.path;
    if (!from || !to || from === to) continue;
    const oid = r.oid as string;
    byOp.set(oid, from);
    if (!direct.has(from)) direct.set(from, []);
    direct.get(from)!.push({ to, oid, lamport: r.lamport });
  }

  const contested = new Set<string>();
  const edge = new Map<string, string>(); // from → to, contest-free hops only
  for (const from of [...direct.keys()].sort(cmp)) {
    const hops = direct.get(from)!;
    const destinations = new Set(hops.map((h) => h.to));
    if (destinations.size > 1) {
      // More than one destination for one source. Concurrent ⇒ a real contest; causally
      // ordered ⇒ a chain, and the last hop is the answer.
      const contest = hops.some((a, i) =>
        hops.slice(i + 1).some((b) => a.to !== b.to && isConcurrent(a.oid, b.oid)),
      );
      if (contest) {
        contested.add(from);
        continue;
      }
    }
    edge.set(from, hops[hops.length - 1]!.to);
  }

  // Chain closure. A cycle (only reachable from concurrent renames, e.g. P→Q ∥ Q→P) has
  // no final path by construction — contest every path it touches.
  const final = new Map<string, string>();
  for (const start of [...edge.keys()].sort(cmp)) {
    const seen = new Set<string>([start]);
    let cur = start;
    let next = edge.get(cur);
    while (next !== undefined && !seen.has(next)) {
      seen.add(next);
      cur = next;
      next = edge.get(cur);
    }
    if (next !== undefined) {
      for (const p of seen) contested.add(p); // cycle
      continue;
    }
    final.set(start, cur);
  }
  for (const p of contested) final.delete(p);
  return { final, contested, byOp };
}

/**
 * Resolve the path an op should actually be applied at.
 *
 * The causal condition is what keeps this from misrouting NEW files: an op that causally
 * descends from the rename was written by an author who already saw the moved world, so
 * the path it names is the path it means. Only an op that is concurrent with (or precedes)
 * the rename is talking about the pre-move world and needs the alias.
 */
export function resolvePath(
  aliases: AliasMap,
  path: string,
  opOid: string,
  descendsFromRename: (opOid: string, renameOid: string) => boolean,
): string {
  const to = aliases.final.get(path);
  if (to === undefined) return path;
  for (const [renameOid, from] of aliases.byOp) {
    if (from === path && descendsFromRename(opOid, renameOid)) return path;
  }
  return to;
}
