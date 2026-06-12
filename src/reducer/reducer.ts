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
import { spliceSymbol } from "../semantic/symbols.ts";

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
function keysOf(op: Operation): string[] {
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

/** opOid → human verdict, with later (canonical) decisions superseding earlier ones. */
function verdictMap(decisions: Decision[]): Map<string, "accept" | "reject"> {
  const m = new Map<string, "accept" | "reject">();
  for (const d of decisions) {
    for (const oid of d.rejectedOps) m.set(oid, "reject");
    for (const oid of d.chosenOps) m.set(oid, "accept");
  }
  return m;
}

export function conflictIdFor(key: string): string {
  // Stable under head-set churn: keyed only on the contended entity.
  return `conflict_${sha256hex(key).slice(0, 24)}`;
}

export function reduce(input: ReduceInput): ReductionResult {
  const { intents, policy } = input;
  const materializeStatuses = new Set(input.materializeStatuses ?? ["accepted"]);

  // ── Canonical input ordering (determinism independent of caller order). ──
  const ops = [...input.ops].sort((a, b) => a.lamport - b.lamport || cmp(a.oid, b.oid));
  const decisions = [...input.decisions].sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.oid, b.oid));
  const evidence = [...input.evidence].sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.oid, b.oid));

  const statuses = new Map<string, OperationStatus>();
  for (const o of ops) statuses.set(o.oid as string, "proposed");

  const anc = ancestry(ops);
  const verdicts = verdictMap(decisions);
  const evByOp = new Map<string, Evidence[]>();
  for (const e of evidence)
    for (const opId of e.forOps) (evByOp.get(opId) ?? evByOp.set(opId, []).get(opId)!).push(e);

  // Group ops by every key they contend on (note ops get a private singleton group).
  const groups = new Map<string, Operation[]>();
  for (const o of ops) {
    const keys = keysOf(o);
    const ks = keys.length ? keys : [`op:${o.oid}`];
    for (const k of ks) (groups.get(k) ?? groups.set(k, []).get(k)!).push(o);
  }

  const conflicts: Conflict[] = [];
  const autoDecisions: AutoDecision[] = [];
  const evalCache = new Map<string, OpEvaluation>();
  const evalOf = (op: Operation, inConflict: boolean): OpEvaluation => {
    const cacheKey = `${op.oid}|${inConflict}`;
    let e = evalCache.get(cacheKey);
    if (!e) {
      e = evaluateOp(policy, op, evByOp.get(op.oid as string) ?? [], inConflict, intentSatisfied(op, intents));
      evalCache.set(cacheKey, e);
    }
    return e;
  };

  // Decide each group locally; aggregate the strictest verdict per op.
  for (const [key, groupOps] of groups) {
    const local = decideGroup(key, groupOps, anc, verdicts, evalOf, policy, conflicts, autoDecisions);
    for (const [oid, st] of local) statuses.set(oid, stricter(statuses.get(oid) ?? "proposed", st));
  }

  // A note op is never grouped on an entity; promote any that stayed "proposed".
  for (const o of ops)
    if (keysOf(o).length === 0 && statuses.get(o.oid as string) === "proposed")
      statuses.set(o.oid as string, "accepted");

  // ── Materialize. ──
  const projected = ops.filter((o) => materializeStatuses.has(statuses.get(o.oid as string)!));
  const ordered = kahnOrder(projected, anc);
  const tree = new Map<string, string>();
  const synthBlobs = new Map<string, string>();
  const blobContent = input.blobContent ?? new Map<string, string>();
  for (const op of ordered) applyOp(tree, op, blobContent, synthBlobs);
  const treeHash = sha256hex(canonicalize(Object.fromEntries([...tree].sort())));

  // Frontier: accepted ops not an ancestor of another accepted op.
  const acceptedIds = new Set(ops.filter((o) => statuses.get(o.oid as string) === "accepted").map((o) => o.oid as string));
  const headOps = [...acceptedIds].filter((id) => {
    for (const other of acceptedIds) if (other !== id && anc.get(other)?.has(id)) return false;
    return true;
  });

  return { tree, treeHash, statuses, conflicts, autoDecisions, semanticConflicts: [], headOps, synthBlobs };
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
    case "note":
      break;
  }
}

function cmp(a: string | undefined, b: string | undefined): number {
  const x = a ?? "";
  const y = b ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
}
