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
import { buildAliasMap, resolvePath, type AliasMap } from "./aliases.ts";
import { merge3, diffHunks, type ConflictRegion } from "../merge/merge3.ts";
import { ownersFor } from "../policy/owners.ts";
import { isBinary } from "../core/bytes.ts";
import { Buffer } from "node:buffer";

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
   * Why a rejected op was blocked, op oid → reason (issue #66). The policy engine
   * already computes this; surfacing it means a file can never leave the
   * projection without an explanation the caller can print.
   */
  blockedReasons: Map<string, string>;
  /**
   * Count of evidence + decisions discarded by the signature trust gate. Non-zero
   * means trust — not content — removed support from some op.
   */
  untrustedEvidence: number;
  /**
   * Content for blob oids synthesized during reduction (a 3-way text merge produces file
   * content that is not any single stored blob). oid → content. The caller persists or
   * writes these directly. Synthetic oids are content-derived, so the treeHash that
   * references them stays deterministic.
   */
  synthBlobs: Map<string, Buffer>;
}

export interface ReduceInput {
  ops: Operation[];
  evidence: Evidence[];
  decisions: Decision[];
  intents: Map<string, Intent>;
  policy: Policy;
  /** Which statuses get projected into the tree. Default: accepted only. */
  materializeStatuses?: OperationStatus[];
  /** blob oid → content bytes, for ops that need file text (edit_file 3-way merge). */
  blobContent?: Map<string, Buffer>;
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
 *
 * "The same file" means the same ALIAS-RESOLVED path, not the same declared one (docs/19
 * §3.2). Two concurrent edits can reach one file by two names — one naming the path from
 * before a move, the other naming it after — and bucketing them by whichever name each op
 * happened to use would put them in separate buckets, never compare them, and let the
 * loser's overlapping change disappear without a word. With no renames in the op set,
 * resolution is the identity and the buckets are exactly the declared paths, as before.
 */
export function detectFileConflicts(
  ops: Operation[],
  result: ReductionResult,
  blobContent: Map<string, Buffer>,
): FileConflict[] {
  const anc = ancestry(ops);
  // Built from the same status filter the bucket loop below uses, so the aliases describe
  // exactly the ops being bucketed.
  const alias = aliasCtxFor(ops.filter((o) => result.statuses.get(o.oid as string) === "accepted"), anc);
  const resolve = (oid: string | undefined): Buffer => (oid ? blobContent.get(oid) ?? Buffer.alloc(0) : Buffer.alloc(0));
  const byFile = new Map<string, Operation[]>();
  for (const o of ops) {
    if (o.body.kind !== "edit_file") continue;
    if (result.statuses.get(o.oid as string) !== "accepted") continue;
    const f = resolvedPath(o, o.body.path ?? o.target.entityId, alias);
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
    const baseBuf = resolve(baseOid);
    const variantBufs = ordered.map((o) => resolve(o.body.blobOid));
    // Binary route: any variant/base with a NUL is not line-mergeable. Report the whole
    // file as one atomic conflict (matches merge3's binary fallback shape) instead of
    // running a bogus line merge.
    if (isBinary(baseBuf) || variantBufs.some(isBinary)) {
      const base = baseBuf.toString("utf8");
      const distinct = [...new Set(variantBufs.map((v) => v.toString("utf8")).filter((v) => v !== base))];
      if (distinct.length < 2) continue; // 0 or 1 distinct variant ⇒ atomic, but clean
      const regions: ConflictRegion[] = [
        {
          baseStart: 0,
          baseEnd: base.split("\n").length,
          base,
          mergedStart: 0,
          options: distinct.map((text, i) => ({ sides: [i], text })),
        },
      ];
      out.push({ file, ops: ordered.map((o) => o.oid as string), regions });
      continue;
    }
    const base = baseBuf.toString("utf8");
    const variants = variantBufs.map((v) => v.toString("utf8"));
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

/** Ops that carry the file's WHOLE content (or its absence) for one path. */
const CONTENT_KINDS = new Set<string>(["put_file", "edit_file", "delete_file"]);

/**
 * Everything the alias layer needs to route an op: the map, plus the causal test that
 * decides whether an op is speaking about the pre-move or the post-move world.
 */
interface AliasCtx {
  aliases: AliasMap;
  descendsFromRename: (opOid: string, renameOid: string) => boolean;
}

/** Build the alias context for a set of PROJECTED ops (docs/19 §3.2 Pass A). Only the
 *  renames that actually reach the tree may move anything, so the map is derived from
 *  the projected set — exactly the set `applyOp` will replay. */
function aliasCtxFor(projected: Operation[], anc: Map<string, Set<string>>): AliasCtx {
  const renames = projected.filter((o) => o.body.kind === "rename_file");
  const descendsFromRename = (opOid: string, renameOid: string): boolean => anc.get(opOid)?.has(renameOid) ?? false;
  const isConcurrent = (a: string, b: string): boolean => !descendsFromRename(a, b) && !descendsFromRename(b, a);
  return { aliases: buildAliasMap(renames, isConcurrent), descendsFromRename };
}

/** The path an op actually writes, after the rename closure. */
function resolvedPath(op: Operation, declared: string, alias: AliasCtx | undefined): string {
  if (!alias) return declared;
  return resolvePath(alias.aliases, declared, op.oid as string, alias.descendsFromRename);
}


/** Keep only the synth-blob entries the final tree actually references (drops the
 *  intermediate splices that get overwritten). Makes synthBlobs a pure function of the
 *  final tree — which is what lets the incremental path reuse base entries exactly. */
function pruneSynth(tree: Map<string, string>, synth: Map<string, Buffer>): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
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
  blobContent: Map<string, Buffer>,
  scoreOf?: OpScorer,
): { tree: Map<string, string>; treeHash: string; headOps: string[]; synthBlobs: Map<string, Buffer> } {
  const projected = ops.filter((o) => materializeStatuses.has(statuses.get(o.oid as string)!));
  const ordered = kahnOrder(projected, anc);
  const alias = aliasCtxFor(projected, anc);
  const tree = new Map<string, string>();
  const synthBlobs = new Map<string, Buffer>();
  const arb = scoreOf ? { scoreOf, prov: new Map<string, Operation[]>() } : undefined;
  for (const op of ordered) applyOp(tree, op, blobContent, synthBlobs, alias, arb);
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
  blobContent: Map<string, Buffer>,
  base: ReductionResult,
  dirtyPaths: Set<string>,
  scoreOf?: OpScorer,
): { tree: Map<string, string>; treeHash: string; headOps: string[]; synthBlobs: Map<string, Buffer> } {
  const projected = ops.filter((o) => materializeStatuses.has(statuses.get(o.oid as string)!));
  const ordered = kahnOrder(projected, anc);
  // The alias map is a function of the WHOLE projected rename set, never of the dirty
  // subset — otherwise the warm path would route ops differently from a cold reduce.
  const alias = aliasCtxFor(projected, anc);
  // Replay only dirty-touching ops, in the SAME global order, into a fresh tree. `pathsOf`
  // is the DECLARED path, while `applyOp` writes at the alias-RESOLVED one; the two agree
  // only because `dirtyPaths` marks both ends of every projected rename (see the caller's
  // cross-path rule). If that ever narrows, an op could be replayed while the path it
  // actually writes keeps a stale base entry, or be skipped while its resolved path was
  // dropped as dirty. `AVCS_VERIFY_INCREMENTAL=1` and the C22 cases gate it.
  const replayTree = new Map<string, string>();
  const replaySynth = new Map<string, Buffer>();
  const arb = scoreOf ? { scoreOf, prov: new Map<string, Operation[]>() } : undefined;
  for (const op of ordered) {
    if (pathsOf(op).some((p) => dirtyPaths.has(p))) applyOp(replayTree, op, blobContent, replaySynth, alias, arb);
  }
  // Final tree = clean base paths (not dirty) + replayed dirty paths.
  const tree = new Map<string, string>();
  for (const [p, oid] of base.tree) if (!dirtyPaths.has(p)) tree.set(p, oid);
  for (const [p, oid] of replayTree) tree.set(p, oid);
  // synthBlobs: union of base (clean paths' synths) + replay, pruned to the final tree.
  const synthCandidates = new Map<string, Buffer>([...base.synthBlobs, ...replaySynth]);
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
  const blockedReasons = new Map<string, string>();
  const autoDecisions: AutoDecision[] = [];
  const perKey = new Map<string, PerKeyDecision>();
  const groupOrder: string[] = [];
  const groupMembers = new Map<string, string[]>();
  for (const [key, groupOps] of groups) {
    groupOrder.push(key);
    groupMembers.set(key, groupOps.map((o) => o.oid as string));
    const kc: Conflict[] = [];
    const ka: AutoDecision[] = [];
    const local = decideGroup(key, groupOps, anc, verdicts, evalOf, policy, kc, ka, blockedReasons);
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
    input.blobContent ?? new Map<string, Buffer>(),
    scorerFrom(ops, evalOf),
  );

  const result: ReductionResult = { tree, treeHash, statuses, conflicts, autoDecisions, fileConflicts: [], headOps, synthBlobs, blockedReasons, untrustedEvidence: 0 };
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
  const blockedReasons = new Map<string, string>();
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
      const local = decideGroup(key, groupOps, anc, verdicts, evalOf, next.policy, kc, ka, blockedReasons);
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
    // Every projected rename dirties BOTH its ends, unconditionally — even when nothing
    // about the rename itself changed. This is what makes path aliases safe on the warm
    // path (docs/19 §3.2, §6 R2): the alias map is a function of the whole op set, so an
    // arriving rename changes where PRE-EXISTING content ops write, and it can invalidate
    // a cached entry at a path NOTHING in the delta mentions — e.g. a second move of an
    // already-moved source has to vacate the first destination. Since every aliased path
    // is by construction one end of some projected rename, dirtying both ends covers every
    // path whose value the alias closure can shift. Narrowing this rule breaks warm/cold
    // agreement; `AVCS_VERIFY_INCREMENTAL=1`, incremental-equivalence and the C22 cases in
    // test/rename-incremental.test.ts are what catch it.
    else if (projectedNow(oid) && isCrossPath(o)) for (const p of pathsOf(o)) dirtyPaths.add(p);
  }

  const { tree, treeHash, headOps, synthBlobs } = materializeIncremental(
    ops,
    statuses,
    anc,
    materializeStatuses,
    next.blobContent ?? new Map<string, Buffer>(),
    snap.result,
    dirtyPaths,
    scorerFrom(ops, evalOf),
  );

  const result: ReductionResult = { tree, treeHash, statuses, conflicts, autoDecisions, fileConflicts: [], headOps, synthBlobs, blockedReasons, untrustedEvidence: 0 };
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
    synthBlobs: entriesToMap(r.synthBlobs as Entries<Buffer>),
    blockedReasons: entriesToMap((r.blockedReasons ?? []) as Entries<string>),
    untrustedEvidence: (r.untrustedEvidence as number | undefined) ?? 0,
  };
  const perKey = new Map<string, PerKeyDecision>(
    (s.perKey as [string, any][]).map(([k, d]) => [k, { local: entriesToMap(d.local), conflicts: d.conflicts, autoDecisions: d.autoDecisions }]),
  );
  const stats: IncrementalStats = { groupsTotal: perKey.size, groupsRecomputed: 0, groupsReused: perKey.size, dirtyKeys: 0 };
  return { input, result, perKey, groupOrder: s.groupOrder as string[], groupMembers: entriesToMap(s.groupMembers as Entries<string[]>), stats };
}

/**
 * Is `o`'s tree effect fully carried by some later op in the same group, so that dropping
 * `o` from the projection loses nothing?
 *
 * A content op (`put_file`/`edit_file`/`delete_file`) states the file's whole content for
 * one path, so a causally later content op on the same key does subsume an earlier one.
 * Two things do NOT:
 *
 *   - A `rename_file` carries no content. It neither subsumes a content op nor is
 *     subsumed by one; a move followed by anything still has to be replayed or the file
 *     it moved never reaches the destination.
 *   - A content op on a path a rename VACATED in between. `put_file(P)` after
 *     `rename(P→Q)` is a different file that happens to reuse the name, so it cannot
 *     stand in for the `put_file(P)` whose content went to Q.
 *
 * Before path aliases existed this distinction was invisible, because a group's covered
 * ops were dropped wholesale and a rename found nothing to move — which is why a plain
 * create-then-move materialized an empty tree.
 */
function subsumedInGroup(o: Operation, groupOps: Operation[], anc: Map<string, Set<string>>): boolean {
  if (!CONTENT_KINDS.has(o.body.kind)) return false;
  const oid = o.oid as string;
  const descendsFrom = (x: Operation, id: string): boolean => anc.get(x.oid as string)?.has(id) ?? false;
  for (const later of groupOps) {
    if (later === o || !descendsFrom(later, oid)) continue;
    if (!CONTENT_KINDS.has(later.body.kind)) continue;
    const separated = groupOps.some(
      (z) => z.body.kind === "rename_file" && descendsFrom(z, oid) && descendsFrom(later, z.oid as string),
    );
    if (!separated) return true;
  }
  return false;
}

/**
 * Does this contended group's frontier consist of a move plus concurrent edits of the
 * file being moved — the combination Pass B composes rather than contests?
 *
 * Requires the group key to be the rename's SOURCE. When the key is the DESTINATION the
 * ops are genuinely fighting over who occupies that path (`rename(A→C)` ∥ `edit(C)`),
 * which the alias map cannot compose and a human must settle. Renames present must all
 * agree on the destination, so concurrent multi-destination moves (docs/19 C13) stay a
 * conflict. And only `edit_file` composes: a concurrent `put_file` has no merge base
 * (docs/15 §3), while `delete_file` ∥ rename keeps whatever it meant before (docs/19 R5).
 */
function composesWithRename(key: string, viable: Operation[]): boolean {
  const path = key.startsWith("file:") ? key.slice("file:".length) : undefined;
  if (path === undefined) return false;
  const renames = viable.filter((o) => o.body.kind === "rename_file");
  if (renames.length === 0) return false;
  if (!renames.every((r) => (r.body.fromPath ?? r.target.entityId) === path)) return false;
  if (new Set(renames.map((r) => r.body.path)).size !== 1) return false;
  return viable.every(
    (o) => o.body.kind === "rename_file" || (o.body.kind === "edit_file" && (o.body.path ?? o.target.entityId) === path),
  );
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
  blockedReasons: Map<string, string>,
): Map<string, OperationStatus> {
  const out = new Map<string, OperationStatus>();
  // Frontier of this group: ops not an ancestor of another group member. Only the frontier
  // can contend — an op some later op was built on top of is history, not a competitor.
  const heads = groupOps.filter((o) => {
    for (const other of groupOps) if (other !== o && anc.get(other.oid as string)?.has(o.oid as string)) return false;
    return true;
  });
  // Being off the frontier is not the same as being redundant. A covered op is dropped
  // from the projection ("superseded") only when a later op actually SUBSUMES its effect;
  // otherwise it still has to be replayed or its contribution to the tree is destroyed.
  for (const o of groupOps)
    if (!heads.includes(o)) out.set(o.oid as string, subsumedInGroup(o, groupOps, anc) ? "superseded" : "accepted");

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
    if (ev.blocked) {
      out.set(op.oid as string, "rejected");
      if (ev.blockedReason) blockedReasons.set(op.oid as string, ev.blockedReason);
    }
    else if (ev.requiresHuman) {
      out.set(op.oid as string, "needs_decision");
      conflicts.push(makeConflict(key, "needs_human", [op], (o) => evalOf(o, false), null, ev.notes.join("; ")));
    } else out.set(op.oid as string, "accepted");
    return out;
  }

  // 3) Contended: policy reduction.
  const blocked = remaining.filter((o) => evalOf(o, inConflict).blocked);
  for (const o of blocked) {
    out.set(o.oid as string, "rejected");
    const why = evalOf(o, inConflict).blockedReason;
    if (why) blockedReasons.set(o.oid as string, why);
  }
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

  // A move and a concurrent edit of the file being moved also compose (docs/19 §3.2):
  // Pass B routes the edit to the rename's destination, so there is nothing to choose
  // between — the two changes are independent and both survive. See `composesWithRename`
  // for which combinations this deliberately does NOT cover.
  if (viable.length > 1 && !needsHuman && composesWithRename(key, viable)) {
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

// ── region arbitration (docs/22): policy, not order, decides a contended region ──

/** One op's policy verdict, as region arbitration needs it (docs/22 §3.2). */
export interface OpScore {
  score: number;
  /** Out of candidacy: a failed evidence gate, or a rule that reserves the call for a
   *  human. An excluded op's content must never take a region — that exclusion is the
   *  real effect of this whole track (docs/22 §3.2-3). */
  excluded: boolean;
}

/** opOid → verdict. `undefined` for an op the scorer does not know, which makes
 *  arbitration abstain rather than guess. */
export type OpScorer = (opOid: string) => OpScore | undefined;

/** What arbitration decided for one region, with the audit trail docs/22 §3.3 records. */
interface RegionVerdict {
  /** index into `region.options` */
  option: number;
  /** representative op of the winning option */
  chosen: string;
  /** representative op of each losing option */
  rejected: string[];
  /** per-option breakdown, in option order — which score decided it */
  optionScores: { opOid: string; score: number; excluded: boolean }[];
}

/**
 * The arbitration rule (docs/22 §3.2) — the one place it is written down.
 *
 * `opsForSide` maps a variant index back to the op(s) that produced it. The caller owns
 * that mapping because it differs between the pairwise merge inside `applyOp` and the
 * authoritative N-way merge in `detectFileConflicts`.
 *
 *   - An option several ops agree on is represented by its HIGHEST-scoring op. An average
 *     would let a low-trust actor dilute an option merely by co-signing it.
 *   - Any excluded op excludes its whole option: conservative on blocking, generous on
 *     score. An option that cannot be auto-accepted cannot win a region either.
 *   - A tie is never broken by recency. It returns `null`, the region stays a conflict and
 *     a human decides. docs/00 principle 6 allows recency as a last tie-break for op
 *     PROMOTION; region content is where meaning diverges, so deciding it quietly is worse
 *     than raising it.
 */
function judgeRegion(
  region: ConflictRegion,
  opsForSide: (side: number) => string[],
  scoreOf: OpScorer,
): RegionVerdict | null {
  const cands: { i: number; excluded: boolean; opOid: string; score: number }[] = [];
  for (const [i, opt] of region.options.entries()) {
    const oids = [...new Set(opt.sides.flatMap(opsForSide))];
    if (oids.length === 0) return null; // no op behind an option ⇒ nothing to weigh
    let excluded = false;
    let rep: { opOid: string; score: number } | undefined;
    for (const oid of oids) {
      const v = scoreOf(oid);
      if (!v) return null; // an op the policy cannot speak about ⇒ abstain, never guess
      if (v.excluded) excluded = true;
      if (!rep || v.score > rep.score || (v.score === rep.score && oid < rep.opOid)) rep = { opOid: oid, score: v.score };
    }
    cands.push({ i, excluded, opOid: rep!.opOid, score: rep!.score });
  }
  const live = cands.filter((c) => !c.excluded);
  if (live.length === 0) return null; // every option blocked ⇒ a human, and no unverified
  const topScore = Math.max(...live.map((c) => c.score)); //     content takes the region
  const top = live.filter((c) => c.score === topScore);
  if (top.length !== 1) return null; // tie ⇒ a human
  const win = top[0]!;
  return {
    option: win.i,
    chosen: win.opOid,
    rejected: cands.filter((c) => c.i !== win.i).map((c) => c.opOid),
    optionScores: cands.map((c) => ({ opOid: c.opOid, score: c.score, excluded: c.excluded })),
  };
}

/** Materialization-scoped state the arbiter needs. Absent ⇒ no arbitration at all, and
 *  `applyOp` behaves exactly as it did before this track (docs/22 R8). */
interface ArbCtx {
  scoreOf: OpScorer;
  /** path → the content ops whose text composed the current tree entry, in application
   *  order. Side 0 of the pairwise merge below is their composition. */
  prov: Map<string, Operation[]>;
}

/**
 * side → op for `applyOp`'s PAIRWISE merge, which is not the clean mapping docs/22 §3.2
 * assumed. Side 1 is the op being applied, but side 0 is the ACCUMULATED tree content —
 * the composition of every content op already applied at that path.
 *
 * So the incumbent side is attributed per REGION: only the contributors whose own change
 * (measured against this merge's base, so the coordinates match the region's) touches the
 * contested span may speak for it, and among those the strongest represents the option —
 * the same rule agreement uses. Without the span filter, a high-trust edit to an unrelated
 * part of the file would defend a low-trust edit's region, and the tree would disagree with
 * the authoritative N-way pass, which sees every op separately.
 *
 * The per-contributor diff is lazy and memoized: a file with no contended region pays
 * nothing, and a contended one pays once per contributor (docs/22 R-c).
 */
function pairwiseArbiter(
  baseText: string,
  incumbents: Operation[],
  self: Operation,
  contentOf: (op: Operation) => string,
  scoreOf: OpScorer,
): (region: ConflictRegion) => number | null {
  const baseLines = baseText.split("\n");
  const spans = new Map<string, { start: number; end: number }[]>();
  const spansOf = (op: Operation): { start: number; end: number }[] => {
    const oid = op.oid as string;
    let s = spans.get(oid);
    if (!s) {
      s = diffHunks(baseLines, contentOf(op).split("\n"));
      spans.set(oid, s);
    }
    return s;
  };
  const touches = (op: Operation, start: number, end: number): boolean =>
    spansOf(op).some((h) => (h.start === h.end ? h.start >= start && h.start <= end : h.start < end && h.end > start));
  const selfOid = self.oid as string;
  return (region) => {
    const opsForSide = (side: number): string[] => {
      if (side !== 0) return [selfOid];
      const hit = incumbents.filter((o) => touches(o, region.baseStart, region.baseEnd));
      // No contributor claims the span (a composition whose hunks shifted): fall back to
      // the whole trail rather than inventing an attribution.
      return (hit.length ? hit : incumbents).map((o) => o.oid as string);
    };
    return judgeRegion(region, opsForSide, scoreOf)?.option ?? null;
  };
}

/** Wrap a reduce's memoized `evalOf` as an {@link OpScorer}. Arbitration REUSES the scores
 *  the group decision already computed — never a recomputation per region (docs/22 R-c). A
 *  contended region IS a conflict, so ops are evaluated with `inConflict = true`, the same
 *  flag their contended group used. */
function scorerFrom(
  ops: Operation[],
  evalOf: (op: Operation, inConflict: boolean) => OpEvaluation,
): OpScorer {
  const byId = new Map(ops.map((o) => [o.oid as string, o]));
  return (oid) => {
    const op = byId.get(oid);
    if (!op) return undefined;
    const ev = evalOf(op, true);
    return { score: ev.score, excluded: ev.blocked || ev.requiresHuman };
  };
}

/**
 * Build an {@link OpScorer} from a bare `ReduceInput`, for a caller outside `reduce` — the
 * authoritative post-reduce pass (`detectFileConflicts` → {@link arbitrateFileConflicts}).
 * Evaluation is lazy and memoized per op, so only the ops of a file that actually contended
 * are ever scored.
 */
export function buildOpScorer(input: ReduceInput): OpScorer {
  const evidence = [...input.evidence].sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.oid, b.oid));
  const evalOf = makeEvalOf(input.policy, input.intents, buildEvByOp(evidence), input.reliability ?? new Map<string, number>());
  return scorerFrom(input.ops, evalOf);
}

/**
 * Apply one projected op to the tree.
 *
 * Every content op is applied at its ALIAS-RESOLVED path, not at the path its body names
 * (docs/19 §3.2 Pass B). That is what makes `rename_file` and `edit_file` commute: the
 * edit lands where the file actually lives regardless of which of the two the canonical
 * order put first. With no renames in the op set the alias map is empty, resolution is
 * the identity, and this function behaves exactly as it did before.
 */
function applyOp(
  tree: Map<string, string>,
  op: Operation,
  blobContent: Map<string, Buffer>,
  synthBlobs: Map<string, Buffer>,
  alias?: AliasCtx,
  arb?: ArbCtx,
): void {
  const b = op.body;
  const resolve = (oid: string): Buffer => synthBlobs.get(oid) ?? blobContent.get(oid) ?? Buffer.alloc(0);
  const at = (declared: string): string => resolvedPath(op, declared, alias);
  switch (b.kind) {
    case "put_file":
      if (b.path && b.blobOid) {
        tree.set(at(b.path), b.blobOid);
        arb?.prov.set(at(b.path), [op]); // a whole-content write restarts the trail
      }
      break;
    case "edit_file": {
      if (!b.path || !b.blobOid) break;
      const path = at(b.path);
      const opNew = resolve(b.blobOid);
      const opBase = b.baseBlobOid ? resolve(b.baseBlobOid) : Buffer.alloc(0);
      const currentOid = tree.get(path);
      const current = currentOid !== undefined ? resolve(currentOid) : opBase;
      // Binary route: a NUL byte means line-merge is meaningless. Skip merge3 and keep a
      // deterministic incumbent — leave the existing tree entry (currentOid) untouched if
      // one is present; otherwise register opNew as a new blob so the file still lands.
      if (isBinary(opNew) || isBinary(opBase) || isBinary(current)) {
        if (currentOid !== undefined) break; // incumbent stays; tree unchanged
        const synthOid = `blob_${sha256hex(opNew).slice(0, 32)}`;
        synthBlobs.set(synthOid, opNew);
        tree.set(path, synthOid);
        arb?.prov.set(path, [op]);
        break;
      }
      // Apply this op's patch (opBase→opNew) onto the accumulated content. Disjoint
      // line changes compose (order-independent); an overlap with a prior concurrent op
      // keeps `current` (deterministic incumbent) — the overlap is reported separately
      // by detectFileConflicts over the full op set. Language-neutral: pure text.
      // An overlap is no longer settled by which op got here first: the injected arbiter
      // asks the policy which option wins the region (docs/22 §3.2). It abstains — leaving
      // the incumbent and the conflict — whenever policy cannot separate the options.
      const incumbents = arb?.prov.get(path) ?? [];
      const arbitrate =
        arb && incumbents.length
          ? pairwiseArbiter(
              opBase.toString("utf8"),
              incumbents,
              op,
              (o) => resolve(o.body.blobOid ?? "").toString("utf8"),
              arb.scoreOf,
            )
          : undefined;
      const m = merge3(opBase.toString("utf8"), [current.toString("utf8"), opNew.toString("utf8")], { onConflict: "first", arbitrate });
      const mergedBuf = Buffer.from(m.merged, "utf8");
      const synthOid = `blob_${sha256hex(mergedBuf).slice(0, 32)}`;
      synthBlobs.set(synthOid, mergedBuf);
      tree.set(path, synthOid);
      if (arb) arb.prov.set(path, [...incumbents, op]);
      break;
    }
    case "delete_file":
      tree.delete(at(b.path ?? op.target.entityId));
      arb?.prov.delete(at(b.path ?? op.target.entityId));
      break;
    case "rename_file": {
      if (!b.fromPath || !b.path) break;
      // A rename the alias map resolved has nothing left to move: every content op that
      // predates or is concurrent with it was already routed to the destination, so the
      // source path was never written. This replaces the old "move whatever happens to be
      // at fromPath right now", which is precisely where the order dependence lived — the
      // answer depended on how many content ops the canonical order had applied by then.
      //
      // A rename the map could NOT resolve (a contested source: concurrent moves to
      // different destinations, or a cycle) keeps the original behaviour, so a contest
      // that a human resolves down to one rename still moves the file.
      if (alias?.aliases.final.has(b.fromPath)) break;
      const blob = tree.get(b.fromPath);
      if (blob !== undefined) {
        tree.delete(b.fromPath);
        tree.set(b.path, blob);
        if (arb) {
          const trail = arb.prov.get(b.fromPath);
          arb.prov.delete(b.fromPath);
          if (trail) arb.prov.set(b.path, trail); // the content moved, and so does its trail
        }
      }
      break;
    }
    case "note":
      break;
  }
}

function cmp(a: string | undefined, b: string | undefined): number {
  const x = a ?? "";
  const y = b ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
}
