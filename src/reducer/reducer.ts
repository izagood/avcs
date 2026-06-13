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
import { spliceSymbol, renameSymbol, extractSymbol } from "../semantic/symbols.ts";
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

/**
 * A merge that is text-clean but meaning-broken: one op changed a public contract
 * while another depends on the old one. Detected (and escalated) by the repo's
 * semantic pass, not the core grouping.
 */
export interface SemanticConflict {
  kind: "contract_break";
  symbol: string; // "<file>#<name>"
  breakingOp: string;
  dependentOps: string[];
  reason: string;
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
  /** Text-clean but meaning-broken merges, escalated by the repo's semantic pass. */
  semanticConflicts: SemanticConflict[];
  /** Frontier op ids: accepted ops that no other accepted op descends from. */
  headOps: string[];
  /**
   * Content for blob oids synthesized during reduction (symbol-level merges produce
   * file content that is not any single stored blob). oid → content. The caller
   * persists or writes these directly. Synthetic oids are content-derived, so the
   * treeHash that references them stays deterministic.
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
  /** blob oid → content, for ops that need file text (set_symbol). */
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
      return [`file:${b.path ?? op.target.entityId}`];
    case "delete_file":
      return [`file:${b.path ?? op.target.entityId}`];
    case "rename_file":
      return [`file:${b.fromPath ?? op.target.entityId}`, `file:${b.path ?? op.target.entityId}`];
    case "set_symbol":
      // Symbol-granular: two edits to different symbols of the same file auto-merge.
      return [`symbol:${b.path}#${b.symbolName}`];
    case "rename_symbol":
      // Contends on both the old and new symbol names within the file.
      return [`symbol:${b.path}#${b.symbolName}`, `symbol:${b.path}#${b.newName}`];
    case "move_symbol":
      // Contends on the symbol at its source and its destination.
      return [`symbol:${b.fromPath}#${b.symbolName}`, `symbol:${b.path}#${b.symbolName}`];
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

export interface CrossConflict {
  file: string;
  ops: string[]; // the concurrent whole-file + symbol ops on that file
}

/**
 * A whole-file op (put_file/delete/rename) and a set_symbol on the SAME file are keyed
 * differently (file:… vs symbol:…#…), so the reducer's grouping never makes them
 * contend. When they are CONCURRENT (neither a causal ancestor of the other), letting
 * both apply makes the result depend on kahnOrder's lamport (authoring-order) tie-break
 * — non-deterministic. This finds those pairs among ACCEPTED ops so the repo can hold
 * them back (re-reduce) and surface a conflict. Ancestor relations (scaffold→edit) are
 * intentionally not flagged.
 */
export function detectCrossGranularity(ops: Operation[], result: ReductionResult): CrossConflict[] {
  const anc = ancestry(ops);
  const fileOf = (o: Operation): string | null => {
    const b = o.body;
    if (b.kind === "put_file" || b.kind === "delete_file") return b.path ?? o.target.entityId;
    if (b.kind === "rename_file") return b.fromPath ?? o.target.entityId;
    if (b.kind === "set_symbol") return b.path ?? null;
    return null;
  };
  const isWhole = (o: Operation) =>
    o.body.kind === "put_file" || o.body.kind === "delete_file" || o.body.kind === "rename_file";
  const byFile = new Map<string, Operation[]>();
  for (const o of ops) {
    if (result.statuses.get(o.oid as string) !== "accepted") continue;
    const f = fileOf(o);
    if (f) (byFile.get(f) ?? byFile.set(f, []).get(f)!).push(o);
  }
  const out: CrossConflict[] = [];
  for (const [file, fops] of byFile) {
    const whole = fops.filter(isWhole);
    const syms = fops.filter((o) => o.body.kind === "set_symbol");
    if (!whole.length || !syms.length) continue;
    const involved = new Set<string>();
    for (const w of whole)
      for (const s of syms) {
        const wId = w.oid as string;
        const sId = s.oid as string;
        if (!anc.get(wId)?.has(sId) && !anc.get(sId)?.has(wId)) {
          involved.add(wId);
          involved.add(sId);
        }
      }
    if (involved.size) out.push({ file, ops: [...involved].sort() });
  }
  return out;
}

/** A single group's locally-decided statuses + the conflicts/autoDecisions it emitted. */
export interface PerKeyDecision {
  local: Map<string, OperationStatus>;
  conflicts: Conflict[];
  autoDecisions: AutoDecision[];
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
  const treeHash = sha256hex(canonicalize(Object.fromEntries([...tree].sort())));

  // Frontier: accepted ops not an ancestor of another accepted op.
  const acceptedIds = new Set(ops.filter((o) => statuses.get(o.oid as string) === "accepted").map((o) => o.oid as string));
  const headOps = [...acceptedIds].filter((id) => {
    for (const other of acceptedIds) if (other !== id && anc.get(other)?.has(id)) return false;
    return true;
  });
  return { tree, treeHash, headOps, synthBlobs };
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

  const result: ReductionResult = { tree, treeHash, statuses, conflicts, autoDecisions, semanticConflicts: [], headOps, synthBlobs };
  return { input, result, perKey, groupOrder, groupMembers };
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
  for (const [key, groupOps] of groups) {
    groupOrder.push(key);
    groupMembers.set(key, groupOps.map((o) => o.oid as string));
    let dec: PerKeyDecision;
    if (dirty.has(key)) {
      const kc: Conflict[] = [];
      const ka: AutoDecision[] = [];
      const local = decideGroup(key, groupOps, anc, verdicts, evalOf, next.policy, kc, ka);
      dec = { local, conflicts: kc, autoDecisions: ka };
    } else {
      dec = snap.perKey.get(key)!; // clean group: inputs unchanged ⇒ decision unchanged
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

  const { tree, treeHash, headOps, synthBlobs } = materializeProjection(
    ops,
    statuses,
    anc,
    materializeStatuses,
    next.blobContent ?? new Map<string, string>(),
  );

  const result: ReductionResult = { tree, treeHash, statuses, conflicts, autoDecisions, semanticConflicts: [], headOps, synthBlobs };
  return { input: next, result, perKey, groupOrder, groupMembers };
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
    case "set_symbol": {
      if (!b.path || !b.symbolName || !b.blobOid) break;
      const currentOid = tree.get(b.path);
      const current = currentOid !== undefined ? resolve(currentOid) : "";
      const merged = spliceSymbol(current, b.symbolName, resolve(b.blobOid));
      const synthOid = `blob_${sha256hex(merged).slice(0, 32)}`;
      synthBlobs.set(synthOid, merged);
      tree.set(b.path, synthOid);
      break;
    }
    case "rename_symbol": {
      if (!b.path || !b.symbolName || !b.newName) break;
      const currentOid = tree.get(b.path);
      if (currentOid === undefined) break;
      const renamed = renameSymbol(resolve(currentOid), b.symbolName, b.newName);
      const synthOid = `blob_${sha256hex(renamed).slice(0, 32)}`;
      synthBlobs.set(synthOid, renamed);
      tree.set(b.path, synthOid);
      break;
    }
    case "move_symbol": {
      if (!b.fromPath || !b.path || !b.symbolName) break;
      const fromOid = tree.get(b.fromPath);
      if (fromOid === undefined) break;
      const extracted = extractSymbol(resolve(fromOid), b.symbolName);
      if (!extracted) break;
      const toContent = tree.get(b.path) !== undefined ? resolve(tree.get(b.path)!) : "";
      const newTo = spliceSymbol(toContent, b.symbolName, extracted.text);
      const fromSynth = `blob_${sha256hex(extracted.rest).slice(0, 32)}`;
      const toSynth = `blob_${sha256hex(newTo).slice(0, 32)}`;
      synthBlobs.set(fromSynth, extracted.rest);
      synthBlobs.set(toSynth, newTo);
      tree.set(b.fromPath, fromSynth);
      tree.set(b.path, toSynth);
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
