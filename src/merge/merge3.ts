// Language-neutral N-way 3-way text merge — the ONLY merge primitive in the core.
//
// avcs has no code-structure awareness. This module merges *text*: a base and N
// concurrent variants (each the full content one operation produced from that base).
// It diffs each variant against the base at the LINE level, then composes the changes:
// disjoint hunks all apply (auto-merge); overlapping hunks from different variants
// become a ConflictRegion the reducer's policy resolves. No symbols, no language — the
// same path runs for python, rust, json, markdown, anything.
//
// Determinism: same (base, variants in canonical order) ⇒ identical output on every
// replica. The algorithm version is pinned into MATERIALIZER_VERSION so a different
// merge implementation cannot silently diverge a replica's tree.

export const MERGE3_VERSION = "text3/0.1.0";

/** A maximal changed segment: base lines [start,end) are replaced by `lines`. */
interface Hunk {
  start: number; // base line index (inclusive)
  end: number; // base line index (exclusive); start==end ⇒ pure insertion
  lines: string[]; // replacement lines
  side: number; // which variant produced it (canonical index)
}

/** One side's rendering of a contended base span (for policy/human to choose among). */
export interface ConflictOption {
  /** Variant indices that produced this exact text (agreement collapses duplicates). */
  sides: number[];
  text: string;
}

/** A base span multiple variants changed incompatibly. Positions are in MERGED lines. */
export interface ConflictRegion {
  baseStart: number; // base line index (inclusive)
  baseEnd: number; // base line index (exclusive)
  base: string; // original base text of the span
  options: ConflictOption[]; // distinct variant renderings, ordered by lowest side index
  /** Line offset of this region within `merged` (where `base` text was emitted). */
  mergedStart: number;
}

export interface Merge3Result {
  /** True iff every change composed without an unresolved overlap. */
  clean: boolean;
  /**
   * The merged text. Non-conflicting changes are applied. For each ConflictRegion the
   * BASE text is emitted (so `merged` is always a valid, replayable file); the reducer
   * substitutes the policy/human-chosen option per region to form the final blob.
   */
  merged: string;
  conflicts: ConflictRegion[];
  /** Set when line-merge was unsafe (binary / oversized): result is atomic, not merged. */
  atomic?: boolean;
}

const MAX_LINES = 50_000; // beyond this, line-DP cost isn't worth it → atomic compare.
const isBinary = (s: string): boolean => s.includes("\u0000");

const splitLines = (s: string): string[] => s.split("\n");
const joinLines = (a: string[]): string => a.join("\n");

export interface Merge3Opts {
  /**
   * What `merged` emits for an unresolved conflict region:
   *   "base"  (default) — original base text, so a caller can substitute a chosen option
   *                       later (used when surfacing a Conflict object).
   *   "first" — the lowest-side-index option (e.g. the accumulated "ours" content when
   *             applying one op's patch onto current). `clean` is still false.
   */
  onConflict?: "base" | "first";
}

/**
 * Merge `variants` (each a full file content) over `base`. `variants` MUST already be
 * in the caller's canonical order (e.g. lamport, oid) — the merge is deterministic in
 * that order. Variants identical to base contribute nothing.
 */
export function merge3(base: string, variants: string[], opts: Merge3Opts = {}): Merge3Result {
  const onConflict = opts.onConflict ?? "base";
  // ── Safety fallback: binary or oversized → atomic, never a bogus line merge. ──
  const distinct = [...new Set(variants.filter((v) => v !== base))];
  if (distinct.length === 0) return { clean: true, merged: base, conflicts: [] };
  const unsafe =
    isBinary(base) ||
    distinct.some(isBinary) ||
    splitLines(base).length > MAX_LINES ||
    distinct.some((v) => splitLines(v).length > MAX_LINES);
  if (unsafe) {
    if (distinct.length === 1) return { clean: true, merged: distinct[0]!, conflicts: [], atomic: true };
    return {
      clean: false,
      merged: base,
      atomic: true,
      conflicts: [
        {
          baseStart: 0,
          // Atomic: the whole content is one opaque conflict — line counts are
          // meaningless here (may be binary), so don't pay/trust splitLines.
          baseEnd: 1,
          base,
          mergedStart: 0,
          options: distinct.map((text, i) => ({ sides: [i], text })),
        },
      ],
    };
  }

  const baseLines = splitLines(base);

  // ── Each variant → hunks vs base. Variants equal to base yield none. ──
  const allHunks: Hunk[] = [];
  variants.forEach((v, side) => {
    if (v === base) return;
    for (const h of diffHunks(baseLines, splitLines(v))) allHunks.push({ ...h, side });
  });
  if (allHunks.length === 0) return { clean: true, merged: base, conflicts: [] };

  // Collapse byte-identical hunks (same span + replacement) from different variants:
  // that is agreement, not contention.
  const keyOf = (h: Hunk) => `${h.start}:${h.end}:${joinLines(h.lines)}`;
  const byKey = new Map<string, Hunk & { sides: number[] }>();
  for (const h of allHunks) {
    const k = keyOf(h);
    const cur = byKey.get(k);
    if (cur) cur.sides.push(h.side);
    else byKey.set(k, { ...h, sides: [h.side] });
  }
  const hunks = [...byKey.values()].sort(
    (a, b) => a.start - b.start || a.end - b.end || Math.min(...a.sides) - Math.min(...b.sides),
  );

  // ── Cluster overlapping hunks. Disjoint clusters compose; multi-variant clusters
  //    with >1 distinct replacement are conflicts. ──
  type Cluster = { start: number; end: number; members: (Hunk & { sides: number[] })[] };
  const clusters: Cluster[] = [];
  for (const h of hunks) {
    const last = clusters[clusters.length - 1];
    // Overlap: intervals [s,e) intersect, OR both are insertions at the same position.
    const overlaps =
      last &&
      (h.start < last.end || (h.start === last.end && (h.start === h.end || last.end === last.start)));
    if (overlaps) {
      last!.end = Math.max(last!.end, h.end);
      last!.members.push(h);
    } else {
      clusters.push({ start: h.start, end: h.end, members: [h] });
    }
  }

  // ── Emit merged text, walking base; record conflicts. ──
  const out: string[] = [];
  const conflicts: ConflictRegion[] = [];
  let cursor = 0; // next base line to copy
  for (const cl of clusters) {
    // copy untouched base lines before the cluster
    for (let i = cursor; i < cl.start; i++) out.push(baseLines[i]!);
    cursor = cl.start;

    const sidesInCluster = [...new Set(cl.members.flatMap((m) => m.sides))].sort((a, b) => a - b);
    // Each side's rendering of the cluster's base span [cl.start, cl.end).
    const renders = new Map<string, number[]>(); // text → contributing sides
    for (const side of sidesInCluster) {
      const txt = renderSpan(baseLines, cl.start, cl.end, cl.members.filter((m) => m.sides.includes(side)));
      const e = renders.get(txt);
      if (e) e.push(side);
      else renders.set(txt, [side]);
    }
    const distinctRenders = [...renders.entries()];

    if (distinctRenders.length === 1) {
      // Agreement (or a single contributing variant): apply the change.
      out.push(...splitLines(distinctRenders[0]![0]));
    } else {
      // Genuine conflict: record options; emit either base or the first option.
      const mergedStart = out.length;
      const options = distinctRenders
        .map(([text, sides]) => ({ sides: sides.sort((a, b) => a - b), text }))
        .sort((a, b) => Math.min(...a.sides) - Math.min(...b.sides));
      const emit = onConflict === "first" ? options[0]!.text : joinLines(baseLines.slice(cl.start, cl.end));
      out.push(...splitLines(emit));
      conflicts.push({
        baseStart: cl.start,
        baseEnd: cl.end,
        base: joinLines(baseLines.slice(cl.start, cl.end)),
        mergedStart,
        options,
      });
    }
    cursor = cl.end;
  }
  for (let i = cursor; i < baseLines.length; i++) out.push(baseLines[i]!);

  return { clean: conflicts.length === 0, merged: joinLines(out), conflicts };
}

/**
 * Render one variant's version of base span [start,end): apply that variant's hunks
 * (already restricted to this cluster) onto base[start:end). Hunks are non-overlapping
 * within a single variant, so a left-to-right splice is exact.
 */
function renderSpan(baseLines: string[], start: number, end: number, members: Hunk[]): string {
  const sorted = [...members].sort((a, b) => a.start - b.start);
  const out: string[] = [];
  let cur = start;
  for (const h of sorted) {
    const hs = Math.max(h.start, start);
    for (let i = cur; i < hs; i++) out.push(baseLines[i]!);
    out.push(...h.lines);
    cur = Math.max(cur, Math.min(h.end, end));
  }
  for (let i = cur; i < end; i++) out.push(baseLines[i]!);
  return joinLines(out);
}

/**
 * Line-level diff (LCS) → maximal changed segments. Each Hunk replaces base[start:end)
 * with `lines`. Unchanged lines produce no hunk. Deterministic.
 */
function diffHunks(a: string[], b: string[]): Omit<Hunk, "side">[] {
  const n = a.length;
  const m = b.length;
  // LCS DP table (lengths). O(n*m) — fine for source files.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);

  // Backtrack to an edit script; coalesce consecutive non-matches into hunks.
  const hunks: Omit<Hunk, "side">[] = [];
  let i = 0;
  let j = 0;
  let segStart = -1;
  let repl: string[] = [];
  const flush = (atBase: number) => {
    if (segStart !== -1) {
      hunks.push({ start: segStart, end: atBase, lines: repl });
      segStart = -1;
      repl = [];
    }
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush(i);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      // delete a[i]
      if (segStart === -1) segStart = i;
      i++;
    } else {
      // insert b[j]
      if (segStart === -1) segStart = i;
      repl.push(b[j]!);
      j++;
    }
  }
  // tail: remaining deletions / insertions
  if (i < n || j < m) {
    if (segStart === -1) segStart = i;
    while (j < m) repl.push(b[j++]!);
    flush(n);
  } else {
    flush(i);
  }
  return hunks;
}
