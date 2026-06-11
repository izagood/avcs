// The reducer: operation graph → materialized state.
//
// AVCS has no "merge". The current code is defined as
//
//   state = reduce(base, operationDAG, decisions, policy, materializer)
//
// a pure, deterministic function. Same objects + same policy + same materializer
// on any replica ⇒ identical tree. This file implements the MVP (file-granular)
// reducer; the algorithm is structured so the Phase-2 AST upgrade only swaps the
// `conflictKey` derivation and the `applyOp` tree mutation.

import { sha256hex, canonicalize } from "../core/canonical.ts";
import type {
  Decision,
  Evidence,
  Intent,
  Operation,
  OperationStatus,
  Policy,
} from "../objects/types.ts";
import { evaluateOp } from "./policy.ts";

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
  id: string; // deterministic
  key: string; // contended entity, e.g. "file:src/a.ts"
  kind: "concurrent_write" | "needs_human";
  options: ConflictOption[];
  /** Policy's provisional recommendation (never applied if requiresHuman). */
  recommendedOp: string | null;
  reason: string;
}

export interface ReductionResult {
  /** path → blobOid */
  tree: Map<string, string>;
  treeHash: string;
  statuses: Map<string, OperationStatus>;
  conflicts: Conflict[];
  /** Frontier op ids (latest accepted op per key). */
  headOps: string[];
}

export interface ReduceInput {
  ops: Operation[];
  evidence: Evidence[];
  decisions: Decision[];
  intents: Map<string, Intent>;
  policy: Policy;
}

function conflictKey(op: Operation): string {
  // MVP: the file path is the unit of contention. The destination path for writes,
  // the source path for deletes/renames so a delete contends with a concurrent edit.
  const p = op.body.path ?? op.body.fromPath ?? op.target.entityId;
  return `${op.target.entityKind}:${p}`;
}

/** Transitive causal-ancestor set for every op (over causalDeps restricted to the candidate set). */
function ancestry(ops: Operation[]): Map<string, Set<string>> {
  const byId = new Map(ops.map((o) => [o.oid as string, o]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const set = new Set<string>();
    memo.set(id, set); // guard against cycles (shouldn't happen in an append-only DAG)
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

/** Does the op's declared effect respect its intent's constraints? MVP heuristic. */
function intentSatisfied(op: Operation, intents: Map<string, Intent>): boolean {
  const intent = intents.get(op.intentOid);
  if (!intent) return true;
  const constraints = intent.constraints.join(" ").toLowerCase();
  const forbidsApiBreak =
    constraints.includes("api") &&
    (constraints.includes("금지") ||
      constraints.includes("유지") ||
      constraints.includes("no break") ||
      constraints.includes("unchanged"));
  if (forbidsApiBreak && op.effects?.breaksPublicApi) return false;
  return true;
}

export function reduce(input: ReduceInput): ReductionResult {
  const { ops, evidence, decisions, intents, policy } = input;
  const statuses = new Map<string, OperationStatus>();
  for (const o of ops) statuses.set(o.oid as string, "proposed");

  const anc = ancestry(ops);
  const evByOp = new Map<string, Evidence[]>();
  for (const e of evidence)
    for (const opId of e.forOps) {
      const arr = evByOp.get(opId) ?? [];
      arr.push(e);
      evByOp.set(opId, arr);
    }

  // Group by contended key.
  const groups = new Map<string, Operation[]>();
  for (const o of ops) {
    const k = conflictKey(o);
    const arr = groups.get(k) ?? [];
    arr.push(o);
    groups.set(k, arr);
  }

  const accepted: Operation[] = [];
  const conflicts: Conflict[] = [];

  for (const [key, groupOps] of groups) {
    // Frontier: ops in this group that are not an ancestor of any other group op.
    const inGroup = new Set(groupOps.map((o) => o.oid as string));
    const heads = groupOps.filter((o) => {
      for (const other of groupOps) {
        if (other === o) continue;
        if (anc.get(other.oid as string)?.has(o.oid as string)) return false;
      }
      return true;
    });
    // Non-head ops in this key are superseded by their descendants.
    for (const o of groupOps)
      if (!heads.includes(o)) statuses.set(o.oid as string, "superseded");
    void inGroup;

    const inConflict = heads.length > 1;
    const evals = new Map(
      heads.map((o) => [
        o.oid as string,
        evaluateOp(
          policy,
          o,
          evByOp.get(o.oid as string) ?? [],
          inConflict,
          intentSatisfied(o, intents),
        ),
      ]),
    );

    if (!inConflict) {
      const [op] = heads as [Operation];
      const ev = evals.get(op.oid as string)!;
      if (ev.blocked) {
        statuses.set(op.oid as string, "rejected");
      } else if (ev.requiresHuman && !resolvedByDecision(op, decisions)) {
        statuses.set(op.oid as string, "needs_decision");
        conflicts.push(makeConflict(key, "needs_human", [op], evals, op, ev.notes.join("; ")));
      } else {
        statuses.set(op.oid as string, "accepted");
        accepted.push(op);
      }
      continue;
    }

    // Contended key — try an explicit decision first.
    const decision = decisions.find((d) => d.conflictId === conflictIdFor(key, heads));
    if (decision) {
      for (const o of heads) {
        if (decision.chosenOps.includes(o.oid as string)) {
          statuses.set(o.oid as string, "accepted");
          accepted.push(o);
        } else {
          statuses.set(o.oid as string, "rejected");
        }
      }
      continue;
    }

    // No decision: policy reduction.
    const viable = heads.filter((o) => !evals.get(o.oid as string)!.blocked);
    for (const o of heads)
      if (!viable.includes(o)) statuses.set(o.oid as string, "rejected");

    const needsHuman = viable.some((o) => evals.get(o.oid as string)!.requiresHuman);
    const ranked = [...viable].sort(
      (a, b) =>
        evals.get(b.oid as string)!.score - evals.get(a.oid as string)!.score ||
        (a.oid! < b.oid! ? -1 : 1),
    );
    const top = ranked[0];
    const topScore = top ? evals.get(top.oid as string)!.score : -Infinity;
    const tie = ranked.filter((o) => evals.get(o.oid as string)!.score === topScore).length > 1;

    if (!top || needsHuman || tie) {
      // Cannot auto-resolve: surface to the human queue, materialize nothing for the key.
      for (const o of viable) statuses.set(o.oid as string, "needs_decision");
      conflicts.push(
        makeConflict(
          key,
          needsHuman ? "needs_human" : "concurrent_write",
          viable,
          evals,
          top ?? null,
          needsHuman ? "requires human decision per policy" : tie ? "score tie" : "no viable op",
        ),
      );
      continue;
    }

    // Policy auto-decision.
    statuses.set(top.oid as string, "accepted");
    accepted.push(top);
    for (const o of viable) if (o !== top) statuses.set(o.oid as string, "rejected");
  }

  // Materialize: apply accepted ops in causal then Lamport then oid order.
  const ordered = topoOrder(accepted, anc);
  const tree = new Map<string, string>();
  for (const op of ordered) applyOp(tree, op);

  const treeHash = sha256hex(canonicalize(Object.fromEntries([...tree].sort())));
  return {
    tree,
    treeHash,
    statuses,
    conflicts,
    headOps: accepted.map((o) => o.oid as string),
  };
}

function resolvedByDecision(op: Operation, decisions: Decision[]): boolean {
  return decisions.some(
    (d) => d.chosenOps.includes(op.oid as string) || d.rejectedOps.includes(op.oid as string),
  );
}

export function conflictIdFor(key: string, ops: Operation[]): string {
  const ids = ops.map((o) => o.oid as string).sort();
  return `conflict_${sha256hex(`${key} ${ids.join(",")}`).slice(0, 24)}`;
}

function makeConflict(
  key: string,
  kind: Conflict["kind"],
  ops: Operation[],
  evals: Map<string, ReturnType<typeof evaluateOp>>,
  recommended: Operation | null,
  reason: string,
): Conflict {
  return {
    id: conflictIdFor(key, ops),
    key,
    kind,
    reason,
    recommendedOp: recommended && !evals.get(recommended.oid as string)!.requiresHuman
      ? (recommended.oid as string)
      : null,
    options: ops.map((o) => {
      const ev = evals.get(o.oid as string)!;
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

function topoOrder(ops: Operation[], anc: Map<string, Set<string>>): Operation[] {
  return [...ops].sort((a, b) => {
    const aId = a.oid as string;
    const bId = b.oid as string;
    if (anc.get(bId)?.has(aId)) return -1; // a is ancestor of b
    if (anc.get(aId)?.has(bId)) return 1;
    return a.lamport - b.lamport || (aId < bId ? -1 : 1);
  });
}

function applyOp(tree: Map<string, string>, op: Operation): void {
  const b = op.body;
  switch (b.kind) {
    case "put_file":
      if (b.path && b.blobOid) tree.set(b.path, b.blobOid);
      break;
    case "delete_file":
      if (b.path) tree.delete(b.path);
      else if (op.target.entityId) tree.delete(op.target.entityId);
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
