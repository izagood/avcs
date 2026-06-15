// The reducer: operation graph → materialized state.
//
// AVCS has no "merge". The current code is defined as
//
//   state = reduce(base, operationDAG, decisions, policy, materializer)
//
// a pure, deterministic function. Same objects + same policy + same materializer
// on any replica ⇒ identical tree. Determinism does NOT depend on the order the
// caller passes objects in: reduce canonically sorts its inputs first (this is the
// fix for the filesystem-readdir-order bug). The algorithm is structured so the
// Phase-2 AST upgrade only swaps `keysOf` (the unit of contention) and `applyOp`.

import { sha256hex, canonicalize } from "../core/canonical.ts";
import type {
  Decision,
  Evidence,
  Intent,
  Operation,
  OperationStatus,
  Policy,
} from "../objects/types.ts";
import { evaluateOp, type OpEvaluation } from "./policy.ts";
import { merge3, type ConflictRegion } from "../merge/merge3.ts";
import { ownersFor } from "../policy/owners.ts";

export interface ConflictOption {
  opOid: string;
  actor: string;
  purpose: string;
  evidence: string[];
  score: number;
  blocked: boolean;
  requiresHuman: boolean;
}

export interface Conflict {
  id: string; // deterministic, stable under head-set changes (keyed on contended entity)
  key: string; // contended entity, e.g. "file:src/a.ts"
  kind: "concurrent_write" | "needs_human";
  options: ConflictOption[];
  /** Policy's provisional recommendation (never set when a human is required). */
  recommendedOp: string | null;
  reason: string;
  /** Actor ids that own this scope and should make the call (Phase 5). */
  requiredOwners?: string[];
}

/** A contest the policy resolved by itself — recorded so auto-merges are auditable. */
export interface AutoDecision {
  key: string;
  conflictId: string;
  chosenOp: string;
  rejectedOps: string[];
  reason: string;
  policyVersion: string;
}

export interface ReductionResult {
  /** path → blobOid */
  tree: Map<string, string>;
  treeHash: string;
  statuses: Map<string, OperationStatus>;
  conflicts: Conflict[];
  autoDecisions: AutoDecision[];
  /** Line-level text merge conflicts among concurrent edit_file ops, filled by the repo's
   *  post-reduce pass (detectFileConflicts). reduce() itself leaves this empty. */
  fileConflicts: FileConflict[];
  /** Frontier op ids: accepted ops that no other accepted op descends from. */
  headOps: string[];
  /**
   * Content for blob oids synthesized during reduction (a 3-way text merge produces file
   * content that is not any single stored blob). oid → content. The caller persists or
   * writes these directly. Synthetic oids are content-derived, so the treeHash that
   * references them stays deterministic.
   */
  synthBlobs: Map<string, string>;
}

export interface ReduceInput {
  ops: Operation[];
  evidence: Evidence[];
  decisions: Decision[];
  intents: Map<string, Intent>;
  policy: Policy;
  /** Which statuses get projected into the tree. Default: accepted only. */
  materializeStatuses?: OperationStatus[];
  /** blob oid → content, for ops that need file text (edit_file 3-way merge). */
  blobContent?: Map<string, string>;
  /** actorId → bounded reliability nudge (Phase 5 trust learning). */
  reliability?: Map<string, number>;
  /** deciderId → role weight; resolves contradictory decisions by authority (docs/08 §4). */
  authority?: Map<string, number>;
}

// Status precedence when an op belongs to several contended keys (rename touches
// two). The strictest verdict across its groups wins.
const PRECEDENCE: Record<string, number> = {
  proposed: 0,
  accepted: 1,
  superseded: 2,
  needs_decision: 3,
  rejected: 4,
  validating: 0,
  quarantined: 4,
};
function stricter(a: OperationStatus, b: OperationStatus): OperationStatus {
  return (PRECEDENCE[a] ?? 0) >= (PRECEDENCE[b] ?? 0) ? a : b;
}

/**
 * The contended keys an op occupies. A rename reads its source and writes its
 * destination, so it contends on BOTH — otherwise a concurrent write to either
 * path would slip through unmerged. note ops contend on nothing.
 */
export function keysOf(op: Operation): string[] {
  const b = op.body;
  switch (b.kind) {
    case "put_file":
    case "edit_file":
    case "delete_file":
      // Every file op contends on the file. Concurrent edit_file ops on the same file
      // are 3-way text-merged at materialization; only overlapping line ranges conflict.
      return [`file:${b.path ?? op.target.entityId}`];
    case "rename_file":
      return [`file:${b.fromPath ?? op.target.entityId}`, `file:${b.path ?? op.target.entityId}`];
    case "note":
      return [];
  }
}

/** Transitive causal-ancestor set for every op (over causalDeps within the set). */
function ancestry(ops: Operation[]): Map<string, Set<string>> {
  const byId = new Map(ops.map((o) => [o.oid as string, o]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const set = new Set<string>();
    memo.set(id, set); // cycle guard (shouldn't happen in an append-only DAG)
    const op = byId.get(id);
    if (op) {
      for (const dep of op.causalDeps) {
        if (!byId.has(dep)) continue;
        set.add(dep);
        for (const a of visit(dep)) set.add(a);
      }
    }
    return set;
  };
  for (const o of ops) visit(o.oid as string);
  return memo;
}

/** Does the op's declared effect respect its intent's constraints? */
function intentSatisfied(op: Operation, intents: Map<string, Intent>): boolean {
  const intent = intents.get(op.intentOid);
  if (!intent) return true;
  // Structured constraints take precedence; NL constraints are a fallback heuristic.
  if (intent.constraintKinds?.includes("forbid_public_api_break") && op.effects?.breaksPublicApi)
    return false;
  const nl = intent.constraints.join(" ").toLowerCase();
  const forbidsApiBreak =
    nl.includes("api") &&
    (nl.includes("금지") || nl.includes("유지") || nl.includes("no break") || nl.includes("unchanged"));
  if (forbidsApiBreak && op.effects?.breaksPublicApi) return false;
  return true;
}

/**
 * opOid → human verdict. Contradictory decisions are resolved by AUTHORITY first
 * (docs/08 §4: a higher-authority decider wins), then canonical recency, then accept
 * over reject within the same decision. `authority` maps decider id → role weight;
 * absent ⇒ all weight 0, i.e. pure canonical-recency (the prior behavior).
 */
function verdictMap(
  decisions: Decision[],
  authority?: Map<string, number>,
): Map<string, "accept" | "reject"> {
  type Key = [number, string, number]; // [authorityWeight, createdAt, acceptBit]
  const cmpKey = (a: Key, b: Key) => a[0] - b[0] || cmp(a[1], b[1]) || a[2] - b[2];
  const best = new Map<string, { v: "accept" | "reject"; key: Key }>();
  const consider = (oid: string, v: "accept" | "reject", key: Key) => {
    const cur = best.get(oid);
    if (!cur || cmpKey(key, cur.key) > 0) best.set(oid, { v, key });
  };
  for (const d of decisions) {
    const w = authority?.get(d.decidedBy.id) ?? 0;
    for (const oid of d.rejectedOps) consider(oid, "reject", [w, d.createdAt, 0]);
    for (const oid of d.chosenOps) consider(oid, "accept", [w, d.createdAt, 1]);
  }
  return new Map([...best].map(([oid, x]) => [oid, x.v]));
}

export function conflictIdFor(key: string): string {
  // Stable under head-set churn: keyed only on the contended entity.
  return `conflict_${sha256hex(key).slice(0, 24)}`;
}

/** A file whose concurrent edits overlapped at the line level — a genuine text merge
 *  conflict. Language-neutral: detected purely by merge3 over the file's content. */
export interface FileConflict {
  file: string;
  ops: string[]; // the concurrent edit_file ops whose hunks overlapped
  regions: ConflictRegion[]; // the contested base line ranges + per-op options
}

/**
 * Detect line-level merge conflicts among CONCURRENT accepted edit_file ops on the same
 * file. The reducer's grouping accepts all such ops (their disjoint hunks compose); this
 * pass runs the authoritative N-way `merge3` over the file's concurrent frontier to find
 * the ones whose hunks actually OVERLAP, so the repo can surface a Conflict / hold back.
 *
 * No language knowledge — merge3 compares lines. Ancestor relations (an edit built on a
 * prior edit) are not concurrent and never flagged. Deterministic over canonical order.
 */
export function detectFileConflicts(
  ops: Operation[],
  result: ReductionResult,
  blobContent: Map<string, string>,
): FileConflict[] {
  const anc = ancestry(ops);
  const resolve = (oid: string | undefined): string => (oid ? blobContent.get(oid) ?? "" : "");
  const byFile = new Map<string, Operation[]>();
  for (const o of ops) {
    if (o.body.kind !== "edit_file") continue;
    if (result.statuses.get(o.oid as string) !== "accepted") continue;
    const f = o.body.path ?? o.target.entityId;
    (byFile.get(f) ?? byFile.set(f, []).get(f)!).push(o);
  }
  const out: FileConflict[] = [];
  for (const [file, fops] of byFile) {
    // Concurrent frontier: ops not a causal ancestor of another edit on this file.
    const frontier = fops.filter(
      (o) => !fops.some((p) => p !== o && anc.get(p.oid as string)?.has(o.oid as string)),
    );
    if (frontier.length < 2) continue; // linear chain ⇒ no concurrency ⇒ no conflict
    const ordered = [...frontier].sort((a, b) => a.lamport - b.lamport || cmp(a.oid, b.oid));
    // Common 3-way base: the content all variants were derived from. Use the shared
    // baseBlobOid when they agree (the normal case); else the lexically-first for a
    // deterministic, conservative comparison.
    const baseOid = [...new Set(ordered.map((o) => o.body.baseBlobOid ?? ""))].sort()[0] ?? "";
    const base = resolve(baseOid);
    const variants = ordered.map((o) => resolve(o.body.blobOid));
    const m = merge3(base, variants);
    if (!m.clean) out.push({ file, ops: ordered.map((o) => o.oid as string), regions: m.conflicts });
  }
  return out;
}

/** A single group's locally-decided statuses + the conflicts/autoDecisions it emitted. */
export interface PerKeyDecision {
  local: Map<string, OperationStatus>;
  conflicts: Conflict[];
  autoDecisions: AutoDecision[];
}

/** Observability for an incremental re-reduce: how much work the dirty-set skipped.
 *  Does not affect the result; purely for benchmarks/metrics (docs/11 A1). */
export interface IncrementalStats {
  groupsTotal: number;
  groupsRecomputed: number;
  groupsReused: number;
  dirtyKeys: number;
}

/**
 * A full reduce plus the per-group bookkeeping an incremental re-reduce needs to reuse
 * clean groups (see incremental.ts / docs/11). The `result` is exactly `reduce(input)`.
 */
export interface ReduceSnapshot {
  input: ReduceInput;
  result: ReductionResult;
  perKey: Map<string, PerKeyDecision>;
  groupOrder: string[]; // group-map insertion order (= conflict emission order)
  groupMembers: Map<string, string[]>; // key → member op oids
  /** Set by `reduceIncremental` (a full `snapshotReduce` recomputes every group). */
  stats: IncrementalStats;
}

export function reduce(input: ReduceInput): ReductionResult {
  return snapshotReduce(input).result;
}

/** Build the per-op evidence index used by `evaluateOp`. */
function buildEvByOp(evidence: Evidence[]): Map<string, Evidence[]> {
  const evByOp = new Map<string, Evidence[]>();
  for (const e of evidence)
    for (const opId of e.forOps) (evByOp.get(opId) ?? evByOp.set(opId, []).get(opId)!).push(e);
  return evByOp;
}

/** A memoizing `evaluateOp` closure (pure given its captured inputs). */
function makeEvalOf(
  policy: Policy,
  intents: Map<string, Intent>,
  evByOp: Map<string, Evidence[]>,
  reliability: Map<string, number>,
): (op: Operation, inConflict: boolean) => OpEvaluation {
  const evalCache = new Map<string, OpEvaluation>();
  return (op, inConflict) => {
    const cacheKey = `${op.oid}|${inConflict}`;
    let e = evalCache.get(cacheKey);
    if (!e) {
      e = evaluateOp(policy, op, evByOp.get(op.oid as string) ?? [], inConflict, intentSatisfied(op, intents), reliability.get(op.actor.id) ?? 0);
      evalCache.set(cacheKey, e);
    }
    return e;
  };
}

/** Project decided statuses into a tree (+ treeHash, frontier headOps, synth blobs). */
/** The tree paths an op reads or writes — the unit of incremental-tree dirtying. */
function pathsOf(op: Operation): string[] {
  const b = op.body;
  switch (b.kind) {
    case "put_file":
    case "edit_file":
    case "delete_file":
      return [b.path ?? op.target.entityId];
    case "rename_file":
      return [b.fromPath ?? op.target.entityId, b.path ?? op.target.entityId];
    case "note":
      return [];
  }
}
/** rename_file reads a SOURCE path's live content, coupling two paths. */
function isCrossPath(op: Operation): boolean {
  return op.body.kind === "rename_file";
}

/** Keep only the synth-blob entries the final tree actually references (drops the
 *  intermediate splices that get overwritten). Makes synthBlobs a pure function of the
 *  final tree — which is what lets the incremental path reuse base entries exactly. */
function pruneSynth(tree: Map<string, string>, synth: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const oid of tree.values()) {
    const c = synth.get(oid);
    if (c !== undefined) out.set(oid, c);
  }
  return out;
}

const treeHashOf = (tree: Map<string, string>): string => sha256hex(canonicalize(Object.fromEntries([...tree].sort())));

/** Frontier: accepted ops not an ancestor of another accepted op. An op is "covered"
 *  (non-head) iff it is in some accepted op's ancestor set — so collect the covered set
 *  in O(Σ ancestors) instead of the O(accepted²) all-pairs scan. Identical output. */
function frontier(ops: Operation[], statuses: Map<string, OperationStatus>, anc: Map<string, Set<string>>): string[] {
  const acceptedIds = new Set(ops.filter((o) => statuses.get(o.oid as string) === "accepted").map((o) => o.oid as string));
  const covered = new Set<string>();
  for (const id of acceptedIds) for (const a of anc.get(id) ?? []) if (acceptedIds.has(a)) covered.add(a);
  return [...acceptedIds].filter((id) => !covered.has(id));
}

function materializeProjection(
  ops: Operation[],
  statuses: Map<string, OperationStatus>,
  anc: Map<string, Set<string>>,
  materializeStatuses: Set<OperationStatus>,
  blobContent: Map<string, string>,
): { tree: Map<string, string>; treeHash: string; headOps: string[]; synthBlobs: Map<string, string> } {
  const projected = ops.filter((o) => materializeStatuses.has(statuses.get(o.oid as string)!));
  const ordered = kahnOrder(projected, anc);
  const tree = new Map<string, string>();
  const synthBlobs = new Map<string, string>();
  for (const op of ordered) applyOp(tree, op, blobContent, synthBlobs);
  return { tree, treeHash: treeHashOf(tree), headOps: frontier(ops, statuses, anc), synthBlobs: pruneSynth(tree, synthBlobs) };
}

/**
 * Incremental tree materialization (docs/11 A3). Reuse the base tree for every path
 * whose contributing accepted-op subsequence is unchanged, and replay ONLY the ops that
 * touch a dirty path — skipping the expensive symbol splices on untouched files (A1
 * showed these dominate). `dirtyPaths` must over-approximate every path whose value can
 * differ from base: paths of ops whose projected-membership changed (incl. new ops), and
 * both paths of every projected cross-path op (rename/move read a source's live content).
 * Replayed ops only ever read/write dirty paths, so a fresh replay tree + clean base
 * entries reconstructs the full tree exactly. Equivalence is enforced by the A0 harness.
 */
function materializeIncremental(
  ops: Operation[],
  statuses: Map<string, OperationStatus>,
  anc: Map<string, Set<string>>,
  materializeStatuses: Set<OperationStatus>,
  blobContent: Map<string, string>,
  base: ReductionResult,
  dirtyPaths: Set<string>,
): { tree: Map<string, string>; treeHash: string; headOps: string[]; synthBlobs: Map<string, string> } {
  const projected = ops.filter((o) => materializeStatuses.has(statuses.get(o.oid as string)!));
  const ordered = kahnOrder(projected, anc);
  // Replay only dirty-touching ops, in the SAME global order, into a fresh tree.
  const replayTree = new Map<string, string>();
  const replaySynth = new Map<string, string>();
  for (const op of ordered) {
    if (pathsOf(op).some((p) => dirtyPaths.has(p))) applyOp(replayTree, op, blobContent, replaySynth);
  }
  // Final tree = clean base paths (not dirty) + replayed dirty paths.
  const tree = new Map<string, string>();
  for (const [p, oid] of base.tree) if (!dirtyPaths.has(p)) tree.set(p, oid);
  for (const [p, oid] of replayTree) tree.set(p, oid);
  // synthBlobs: union of base (clean paths' synths) + replay, pruned to the final tree.
  const synthCandidates = new Map<string, string>([...base.synthBlobs, ...replaySynth]);
  return { tree, treeHash: treeHashOf(tree), headOps: frontier(ops, statuses, anc), synthBlobs: pruneSynth(tree, synthCandidates) };
}

export function snapshotReduce(input: ReduceInput): ReduceSnapshot {
  const { intents, policy } = input;
  const materializeStatuses = new Set<OperationStatus>(input.materializeStatuses ?? ["accepted"]);

  // ── Canonical input ordering (determinism independent of caller order). ──
  const ops = [...input.ops].sort((a, b) => a.lamport - b.lamport || cmp(a.oid, b.oid));
  const decisions = [...input.decisions].sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.oid, b.oid));
  const evidence = [...input.evidence].sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.oid, b.oid));

  const statuses = new Map<string, OperationStatus>();
  for (const o of ops) statuses.set(o.oid as string, "proposed");

  const anc = ancestry(ops);
  const verdicts = verdictMap(decisions, input.authority);
  const evByOp = buildEvByOp(evidence);

  // Group ops by every key they contend on (note ops get a private singleton group).
  const groups = new Map<string, Operation[]>();
  for (const o of ops) {
    const keys = keysOf(o);
    const ks = keys.length ? keys : [`op:${o.oid}`];
    for (const k of ks) (groups.get(k) ?? groups.set(k, []).get(k)!).push(o);
  }

  const reliability = input.reliability ?? new Map<string, number>();
  const evalOf = makeEvalOf(policy, intents, evByOp, reliability);

  // Decide each group locally; aggregate the strictest verdict per op. Capture each
  // group's emitted conflicts/autoDecisions separately so an incremental re-reduce can
  // reuse a clean group verbatim (incremental.ts), while the final arrays preserve the
  // exact group-iteration order.
  const conflicts: Conflict[] = [];
  const autoDecisions: AutoDecision[] = [];
  const perKey = new Map<string, PerKeyDecision>();
  const groupOrder: string[] = [];
  const groupMembers = new Map<string, string[]>();
  for (const [key, groupOps] of groups) {
    groupOrder.push(key);
    groupMembers.set(key, groupOps.map((o) => o.oid as string));
    const kc: Conflict[] = [];
    const ka: AutoDecision[] = [];
    const local = decideGroup(key, groupOps, anc, verdicts, evalOf, policy, kc, ka);
    perKey.set(key, { local, conflicts: kc, autoDecisions: ka });
    for (const [oid, st] of local) statuses.set(oid, stricter(statuses.get(oid) ?? "proposed", st));
    conflicts.push(...kc);
    autoDecisions.push(...ka);
  }
  // Phase 5: annotate needs_human conflicts with the scope owners who should decide.
  // Mutates the same Conflict objects held in `perKey`, so the cache stays consistent.
  for (const c of conflicts) {
    const o = ownersFor(c.key, policy.owners ?? []);
    if (o.length) c.requiredOwners = o;
  }

  // A note op is never grouped on an entity; promote any that stayed "proposed".
  for (const o of ops)
    if (keysOf(o).length === 0 && statuses.get(o.oid as string) === "proposed")
      statuses.set(o.oid as string, "accepted");

  const { tree, treeHash, headOps, synthBlobs } = materializeProjection(
    ops,
    statuses,
    anc,
    materializeStatuses,
    input.blobContent ?? new Map<string, string>(),
  );

  const result: ReductionResult = { tree, treeHash, statuses, conflicts, autoDecisions, fileConflicts: [], headOps, synthBlobs };
  const stats: IncrementalStats = { groupsTotal: groups.size, groupsRecomputed: groups.size, groupsReused: 0, dirtyKeys: groups.size };
  return { input, result, perKey, groupOrder, groupMembers, stats };
}

/** Thrown when an incremental re-reduce's preconditions don't hold; the caller must
 *  fall back to a full `reduce`. Never indicates a correctness failure — only that the
 *  fast path doesn't apply (policy/authority/materializeStatuses changed, or `next` is
 *  not an append-superset of the snapshot's input). */
export class NonIncrementalError extends Error {
  constructor(reason: string) {
    super(`non-incremental: ${reason}`);
    this.name = "NonIncrementalError";
  }
}

function sameStatusSet(a: OperationStatus[] | undefined, b: OperationStatus[] | undefined): boolean {
  const sa = new Set(a ?? ["accepted"]);
  const sb = new Set(b ?? ["accepted"]);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

function sameNumberMap(a: Map<string, number> | undefined, b: Map<string, number> | undefined): boolean {
  const ma = a ?? new Map();
  const mb = b ?? new Map();
  const keys = new Set([...ma.keys(), ...mb.keys()]);
  for (const k of keys) if ((ma.get(k) ?? 0) !== (mb.get(k) ?? 0)) return false;
  return true;
}

/**
 * Incremental re-reduce (docs/11 Track A). Given a prior `snapshotReduce` and a `next`
 * input that is an APPEND-SUPERSET of the snapshot's input (same policy/authority/
 * materializeStatuses; ops/decisions/evidence only added), recompute only the groups
 * whose decision could have changed (the "dirty set") and reuse every clean group's
 * cached decision verbatim. The returned result is structurally identical to
 * `reduce(next)` — this is the invariant the differential harness enforces.
 *
 * Dirty keys (see docs/11): keys of new ops; keys of ops targeted by new decisions or
 * new evidence (these can flip blocked/accept regardless of contention); keys whose
 * group membership changed or are brand new; and the keys of any op whose actor's
 * reliability changed (a needs_human conflict embeds the op's reliability-derived score,
 * so reliability changes are not gated by contention here — A1 may tighten this).
 *
 * Throws {@link NonIncrementalError} when the preconditions don't hold; the caller then
 * falls back to a full reduce. tree/headOps are rebuilt fully (cheap, in-memory) in A0;
 * A3 will make the tree update incremental too.
 */
export function reduceIncremental(snap: ReduceSnapshot, next: ReduceInput): ReduceSnapshot {
  const prev = snap.input;
  // ── Preconditions: invariants that the clean-group reuse assumes. ──
  if (!sameStatusSet(prev.materializeStatuses, next.materializeStatuses)) throw new NonIncrementalError("materializeStatuses changed");
  if (!sameNumberMap(prev.authority, next.authority)) throw new NonIncrementalError("authority changed");
  if (prev.policy !== next.policy && canonicalize(prev.policy as unknown) !== canonicalize(next.policy as unknown)) {
    throw new NonIncrementalError("policy changed");
  }

  const materializeStatuses = new Set<OperationStatus>(next.materializeStatuses ?? ["accepted"]);
  const ops = [...next.ops].sort((a, b) => a.lamport - b.lamport || cmp(a.oid, b.oid));
  const decisions = [...next.decisions].sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.oid, b.oid));
  const evidence = [...next.evidence].sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.oid, b.oid));

  // ── Require next ⊇ prev (append-only); else the fast path can't apply. ──
  const nextOpIds = new Set(ops.map((o) => o.oid as string));
  for (const o of prev.ops) if (!nextOpIds.has(o.oid as string)) throw new NonIncrementalError("an op was removed");
  const nextDecIds = new Set(decisions.map((d) => d.oid as string));
  for (const d of prev.decisions) if (!nextDecIds.has(d.oid as string)) throw new NonIncrementalError("a decision was removed");
  const nextEvIds = new Set(evidence.map((e) => e.oid as string));
  for (const e of prev.evidence) if (!nextEvIds.has(e.oid as string)) throw new NonIncrementalError("an evidence was removed");

  const statuses = new Map<string, OperationStatus>();
  for (const o of ops) statuses.set(o.oid as string, "proposed");

  const anc = ancestry(ops);
  const verdicts = verdictMap(decisions, next.authority);
  const evByOp = buildEvByOp(evidence);
  const reliability = next.reliability ?? new Map<string, number>();
  const evalOf = makeEvalOf(next.policy, next.intents, evByOp, reliability);
  const opById = new Map(ops.map((o) => [o.oid as string, o]));

  // ── Groups for `next` (insertion order = canonical sorted-op order). ──
  const groups = new Map<string, Operation[]>();
  for (const o of ops) {
    const keys = keysOf(o);
    const ks = keys.length ? keys : [`op:${o.oid}`];
    for (const k of ks) (groups.get(k) ?? groups.set(k, []).get(k)!).push(o);
  }

  // ── Dirty-key set. ──
  const prevOpIds = new Set(prev.ops.map((o) => o.oid as string));
  const prevDecIds = new Set(prev.decisions.map((d) => d.oid as string));
  const prevEvIds = new Set(prev.evidence.map((e) => e.oid as string));
  const prevRel = prev.reliability ?? new Map<string, number>();
  const changedActors = new Set<string>();
  for (const a of new Set([...prevRel.keys(), ...reliability.keys()]))
    if ((prevRel.get(a) ?? 0) !== (reliability.get(a) ?? 0)) changedActors.add(a);

  const dirty = new Set<string>();
  const dirtyKeysOfOp = (oid: string): void => {
    const o = opById.get(oid);
    if (!o) return;
    const ks = keysOf(o);
    if (ks.length) for (const k of ks) dirty.add(k);
    else dirty.add(`op:${oid}`);
  };
  const deltaOpIds = new Set(ops.filter((o) => !prevOpIds.has(o.oid as string)).map((o) => o.oid as string));
  for (const oid of deltaOpIds) dirtyKeysOfOp(oid); // new ops
  // Ancestry extension: a delta op can be a (transitive) causal ancestor of a PRE-EXISTING
  // op — sync delivers ops out of causal order (base={X} with X→Y missing, next adds Y).
  // That changes the ancestor relations inside any group whose member is downstream of a
  // delta op, so those groups must be recomputed even though their membership is unchanged.
  if (deltaOpIds.size)
    for (const m of ops) {
      const a = anc.get(m.oid as string);
      if (!a) continue;
      for (const d of deltaOpIds)
        if (a.has(d)) { dirtyKeysOfOp(m.oid as string); break; }
    }
  for (const d of decisions)
    if (!prevDecIds.has(d.oid as string)) for (const oid of [...d.chosenOps, ...d.rejectedOps]) dirtyKeysOfOp(oid); // new decisions
  for (const e of evidence)
    if (!prevEvIds.has(e.oid as string)) for (const oid of e.forOps) dirtyKeysOfOp(oid); // new evidence
  // membership change / brand-new key, and reliability-changed actors.
  for (const [k, members] of groups) {
    const prevMembers = snap.groupMembers.get(k);
    if (!prevMembers) { dirty.add(k); continue; }
    if (prevMembers.length !== members.length) { dirty.add(k); continue; }
    const cur = new Set(members.map((o) => o.oid as string));
    if (prevMembers.some((id) => !cur.has(id))) { dirty.add(k); continue; }
    if (changedActors.size && members.some((o) => changedActors.has(o.actor.id))) dirty.add(k);
  }

  // ── Decide each group: recompute the dirty ones, reuse the clean ones. ──
  const conflicts: Conflict[] = [];
  const autoDecisions: AutoDecision[] = [];
  const perKey = new Map<string, PerKeyDecision>();
  const groupOrder: string[] = [];
  const groupMembers = new Map<string, string[]>();
  let recomputed = 0;
  let reused = 0;
  for (const [key, groupOps] of groups) {
    groupOrder.push(key);
    groupMembers.set(key, groupOps.map((o) => o.oid as string));
    let dec: PerKeyDecision;
    if (dirty.has(key)) {
      const kc: Conflict[] = [];
      const ka: AutoDecision[] = [];
      const local = decideGroup(key, groupOps, anc, verdicts, evalOf, next.policy, kc, ka);
      dec = { local, conflicts: kc, autoDecisions: ka };
      recomputed++;
    } else {
      dec = snap.perKey.get(key)!; // clean group: inputs unchanged ⇒ decision unchanged
      reused++;
    }
    perKey.set(key, dec);
    for (const [oid, st] of dec.local) statuses.set(oid, stricter(statuses.get(oid) ?? "proposed", st));
    conflicts.push(...dec.conflicts);
    autoDecisions.push(...dec.autoDecisions);
  }
  for (const c of conflicts) {
    const o = ownersFor(c.key, next.policy.owners ?? []);
    if (o.length) c.requiredOwners = o;
  }

  for (const o of ops)
    if (keysOf(o).length === 0 && statuses.get(o.oid as string) === "proposed")
      statuses.set(o.oid as string, "accepted");

  // ── Dirty PATHS for the incremental tree (A3). A path may differ from base if an op
  // touching it changed projected-membership (incl. new ops), or it is read/written by a
  // projected cross-path op (rename/move carry a source's live content to a dest). ──
  const projectedNow = (oid: string): boolean => materializeStatuses.has(statuses.get(oid)!);
  const projectedBase = (oid: string): boolean => {
    const s = snap.result.statuses.get(oid);
    return s !== undefined && materializeStatuses.has(s);
  };
  const ancestryExtended = (oid: string): boolean => {
    const a = anc.get(oid);
    if (!a) return false;
    for (const d of deltaOpIds) if (a.has(d)) return true; // a delta op became this op's ancestor
    return false;
  };
  const dirtyPaths = new Set<string>();
  for (const o of ops) {
    const oid = o.oid as string;
    // Membership change (incl. new ops) or ancestry extension can change a path's value
    // or the order its ops apply in (ancestry extension guards against lamport that is
    // not consistent with causality — real repo ops always are, but reduce() is pure).
    if (projectedNow(oid) !== projectedBase(oid) || ancestryExtended(oid)) for (const p of pathsOf(o)) dirtyPaths.add(p);
    else if (projectedNow(oid) && isCrossPath(o)) for (const p of pathsOf(o)) dirtyPaths.add(p);
  }

  const { tree, treeHash, headOps, synthBlobs } = materializeIncremental(
    ops,
    statuses,
    anc,
    materializeStatuses,
    next.blobContent ?? new Map<string, string>(),
    snap.result,
    dirtyPaths,
  );

  const result: ReductionResult = { tree, treeHash, statuses, conflicts, autoDecisions, fileConflicts: [], headOps, synthBlobs };
  const stats: IncrementalStats = { groupsTotal: groups.size, groupsRecomputed: recomputed, groupsReused: reused, dirtyKeys: dirty.size };
  return { input: next, result, perKey, groupOrder, groupMembers, stats };
}

// ── snapshot persistence (docs/11 B3 compaction) ──────────────────────────────
// A ReduceSnapshot can be persisted as a durable "compacted base": a later cold
// materialize loads it and `reduceIncremental`s only the ops added since, instead of
// reducing the whole history from scratch. reduceIncremental reads ONLY `.oid` from
// `prev.ops`/`decisions`/`evidence`, so the persisted input keeps just oids (stubs on
// reload) — the heavy op/blob content is not duplicated. Maps are stored as entry arrays.
type Entries<V> = [string, V][];
const mapToEntries = <V>(m: Map<string, V>): Entries<V> => [...m];
const entriesToMap = <V>(e: Entries<V>): Map<string, V> => new Map(e);

export function serializeSnapshot(snap: ReduceSnapshot): unknown {
  const inp = snap.input;
  const r = snap.result;
  return {
    v: 1,
    input: {
      ops: inp.ops.map((o) => o.oid as string),
      decisions: inp.decisions.map((d) => d.oid as string),
      evidence: inp.evidence.map((e) => e.oid as string),
      reliability: mapToEntries(inp.reliability ?? new Map()),
      authority: mapToEntries(inp.authority ?? new Map()),
      policy: inp.policy,
      materializeStatuses: inp.materializeStatuses ?? null,
    },
    result: {
      tree: mapToEntries(r.tree),
      treeHash: r.treeHash,
      statuses: mapToEntries(r.statuses),
      conflicts: r.conflicts,
      autoDecisions: r.autoDecisions,
      fileConflicts: r.fileConflicts,
      headOps: r.headOps,
      synthBlobs: mapToEntries(r.synthBlobs),
    },
    perKey: [...snap.perKey].map(([k, d]) => [k, { local: mapToEntries(d.local), conflicts: d.conflicts, autoDecisions: d.autoDecisions }]),
    groupOrder: snap.groupOrder,
    groupMembers: mapToEntries(snap.groupMembers),
  };
}

export function deserializeSnapshot(raw: unknown): ReduceSnapshot {
  const s = raw as ReturnType<typeof serializeSnapshot> & Record<string, any>;
  const inp = s.input;
  // Stub ops/decisions/evidence: reduceIncremental only reads their `.oid`.
  const stub = (oid: string) => ({ oid }) as unknown as Operation;
  const input: ReduceInput = {
    ops: (inp.ops as string[]).map(stub),
    decisions: (inp.decisions as string[]).map((oid) => ({ oid }) as unknown as Decision),
    evidence: (inp.evidence as string[]).map((oid) => ({ oid }) as unknown as Evidence),
    intents: new Map(),
    policy: inp.policy as Policy,
    materializeStatuses: (inp.materializeStatuses as OperationStatus[] | null) ?? undefined,
    reliability: entriesToMap(inp.reliability as Entries<number>),
    authority: entriesToMap(inp.authority as Entries<number>),
  };
  const r = s.result;
  const result: ReductionResult = {
    tree: entriesToMap(r.tree as Entries<string>),
    treeHash: r.treeHash as string,
    statuses: entriesToMap(r.statuses as Entries<OperationStatus>),
    conflicts: r.conflicts as Conflict[],
    autoDecisions: r.autoDecisions as AutoDecision[],
    fileConflicts: r.fileConflicts as ReductionResult["fileConflicts"],
    headOps: r.headOps as string[],
    synthBlobs: entriesToMap(r.synthBlobs as Entries<string>),
  };
  const perKey = new Map<string, PerKeyDecision>(
    (s.perKey as [string, any][]).map(([k, d]) => [k, { local: entriesToMap(d.local), conflicts: d.conflicts, autoDecisions: d.autoDecisions }]),
  );
  const stats: IncrementalStats = { groupsTotal: perKey.size, groupsRecomputed: 0, groupsReused: perKey.size, dirtyKeys: 0 };
  return { input, result, perKey, groupOrder: s.groupOrder as string[], groupMembers: entriesToMap(s.groupMembers as Entries<string[]>), stats };
}

function decideGroup(
  key: string,
  groupOps: Operation[],
  anc: Map<string, Set<string>>,
  verdicts: Map<string, "accept" | "reject">,
  evalOf: (op: Operation, inConflict: boolean) => OpEvaluation,
  policy: Policy,
  conflicts: Conflict[],
  autoDecisions: AutoDecision[],
): Map<string, OperationStatus> {
  const out = new Map<string, OperationStatus>();
  // Frontier of this group: ops not an ancestor of another group member.
  const heads = groupOps.filter((o) => {
    for (const other of groupOps) if (other !== o && anc.get(other.oid as string)?.has(o.oid as string)) return false;
    return true;
  });
  for (const o of groupOps) if (!heads.includes(o)) out.set(o.oid as string, "superseded");

  // 1) Honor explicit human decisions first (H1) — globally, regardless of grouping.
  const forcedAccept = heads.filter((o) => verdicts.get(o.oid as string) === "accept");
  const forcedReject = heads.filter((o) => verdicts.get(o.oid as string) === "reject");
  for (const o of forcedReject) out.set(o.oid as string, "rejected");
  if (forcedAccept.length) {
    for (const o of forcedAccept) out.set(o.oid as string, "accepted");
    for (const o of heads) if (!forcedAccept.includes(o)) out.set(o.oid as string, "rejected");
    return out;
  }

  const remaining = heads.filter((o) => !forcedReject.includes(o));
  if (remaining.length === 0) return out;

  const inConflict = remaining.length > 1;

  // 2) Single uncontended head.
  if (remaining.length === 1) {
    const op = remaining[0]!;
    const ev = evalOf(op, false);
    if (ev.blocked) out.set(op.oid as string, "rejected");
    else if (ev.requiresHuman) {
      out.set(op.oid as string, "needs_decision");
      conflicts.push(makeConflict(key, "needs_human", [op], (o) => evalOf(o, false), null, ev.notes.join("; ")));
    } else out.set(op.oid as string, "accepted");
    return out;
  }

  // 3) Contended: policy reduction.
  const blocked = remaining.filter((o) => evalOf(o, inConflict).blocked);
  for (const o of blocked) out.set(o.oid as string, "rejected");
  const viable = remaining.filter((o) => !blocked.includes(o));

  const needsHuman = viable.some((o) => evalOf(o, inConflict).requiresHuman);

  // Concurrent TEXT edits (all edit_file) auto-merge: accept all. Their disjoint line
  // hunks compose deterministically (merge3); an actual line overlap is surfaced by
  // detectFileConflicts over the full op set, NOT resolved by dropping a sibling here.
  // (A winner-pick would silently lose the loser's non-overlapping changes.) When a
  // human is required (e.g. declared API break) we still fall through to escalation.
  if (viable.length > 1 && !needsHuman && viable.every((o) => o.body.kind === "edit_file")) {
    for (const o of viable) out.set(o.oid as string, "accepted");
    return out;
  }

  const ranked = [...viable].sort((a, b) => {
    const d = evalOf(b, inConflict).score - evalOf(a, inConflict).score;
    if (d !== 0) return d;
    return a.lamport - b.lamport || cmp(a.oid, b.oid); // lamport is a tie-break only
  });
  const top = ranked[0];
  const topScore = top ? evalOf(top, inConflict).score : -Infinity;
  const tie = ranked.filter((o) => evalOf(o, inConflict).score === topScore).length > 1;

  if (!top || needsHuman || tie) {
    for (const o of viable) out.set(o.oid as string, "needs_decision");
    conflicts.push(
      makeConflict(
        key,
        needsHuman ? "needs_human" : "concurrent_write",
        viable,
        (o) => evalOf(o, inConflict),
        needsHuman ? null : top ?? null,
        needsHuman ? "requires human decision per policy" : tie ? "score tie — needs a human" : "no viable op",
      ),
    );
    return out;
  }

  // Policy auto-decision — recorded so the merge is auditable (H4).
  out.set(top.oid as string, "accepted");
  const losers = viable.filter((o) => o !== top).map((o) => o.oid as string);
  for (const id of losers) out.set(id, "rejected");
  autoDecisions.push({
    key,
    conflictId: conflictIdFor(key),
    chosenOp: top.oid as string,
    rejectedOps: losers,
    reason: evalOf(top, inConflict).notes.join("; ") || "highest policy score",
    policyVersion: policy.version,
  });
  return out;
}

function makeConflict(
  key: string,
  kind: Conflict["kind"],
  ops: Operation[],
  evalOf: (op: Operation) => OpEvaluation,
  recommended: Operation | null,
  reason: string,
): Conflict {
  return {
    id: conflictIdFor(key),
    key,
    kind,
    reason,
    recommendedOp: recommended ? (recommended.oid as string) : null,
    options: ops.map((o) => {
      const ev = evalOf(o);
      return {
        opOid: o.oid as string,
        actor: o.actor.id,
        purpose: o.declaredPurpose,
        evidence: ev.notes,
        score: ev.score,
        blocked: ev.blocked,
        requiresHuman: ev.requiresHuman,
      };
    }),
  };
}

/** Deterministic topological sort (Kahn): ready set ordered by (lamport, oid). */
function kahnOrder(ops: Operation[], anc: Map<string, Set<string>>): Operation[] {
  const ids = new Set(ops.map((o) => o.oid as string));
  const byId = new Map(ops.map((o) => [o.oid as string, o]));
  const indeg = new Map<string, number>();
  const edges = new Map<string, string[]>(); // dep → dependents
  for (const o of ops) {
    const deps = o.causalDeps.filter((d) => ids.has(d));
    indeg.set(o.oid as string, deps.length);
    for (const d of deps) (edges.get(d) ?? edges.set(d, []).get(d)!).push(o.oid as string);
  }
  const ready = ops
    .filter((o) => (indeg.get(o.oid as string) ?? 0) === 0)
    .sort((a, b) => a.lamport - b.lamport || cmp(a.oid, b.oid));
  const order: Operation[] = [];
  while (ready.length) {
    const op = ready.shift()!;
    order.push(op);
    for (const dep of edges.get(op.oid as string) ?? []) {
      const n = (indeg.get(dep) ?? 0) - 1;
      indeg.set(dep, n);
      if (n === 0) {
        const o = byId.get(dep)!;
        // insert keeping (lamport, oid) order
        let i = ready.length;
        while (i > 0 && (ready[i - 1]!.lamport > o.lamport || (ready[i - 1]!.lamport === o.lamport && cmp(ready[i - 1]!.oid, o.oid) > 0))) i--;
        ready.splice(i, 0, o);
      }
    }
  }
  // Any leftover (cycle — shouldn't happen) appended deterministically.
  if (order.length < ops.length) {
    const seen = new Set(order.map((o) => o.oid));
    for (const o of [...ops].sort((a, b) => a.lamport - b.lamport || cmp(a.oid, b.oid)))
      if (!seen.has(o.oid)) order.push(o);
  }
  return order;
}

function applyOp(
  tree: Map<string, string>,
  op: Operation,
  blobContent: Map<string, string>,
  synthBlobs: Map<string, string>,
): void {
  const b = op.body;
  const resolve = (oid: string): string => synthBlobs.get(oid) ?? blobContent.get(oid) ?? "";
  switch (b.kind) {
    case "put_file":
      if (b.path && b.blobOid) tree.set(b.path, b.blobOid);
      break;
    case "edit_file": {
      if (!b.path || !b.blobOid) break;
      const opNew = resolve(b.blobOid);
      const opBase = b.baseBlobOid ? resolve(b.baseBlobOid) : "";
      const currentOid = tree.get(b.path);
      const current = currentOid !== undefined ? resolve(currentOid) : opBase;
      // Apply this op's patch (opBase→opNew) onto the accumulated content. Disjoint
      // line changes compose (order-independent); an overlap with a prior concurrent op
      // keeps `current` (deterministic incumbent) — the overlap is reported separately
      // by detectFileConflicts over the full op set. Language-neutral: pure text.
      const m = merge3(opBase, [current, opNew], { onConflict: "first" });
      const synthOid = `blob_${sha256hex(m.merged).slice(0, 32)}`;
      synthBlobs.set(synthOid, m.merged);
      tree.set(b.path, synthOid);
      break;
    }
    case "delete_file":
      tree.delete(b.path ?? op.target.entityId);
      break;
    case "rename_file":
      if (b.fromPath && b.path) {
        const blob = tree.get(b.fromPath);
        if (blob !== undefined) {
          tree.delete(b.fromPath);
          tree.set(b.path, blob);
        }
      }
      break;
    case "note":
      break;
  }
}

function cmp(a: string | undefined, b: string | undefined): number {
  const x = a ?? "";
  const y = b ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
}
