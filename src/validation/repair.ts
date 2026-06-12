// Phase 3: RepairContext — when validation fails, hand the agent the *minimum* it
// needs to fix the problem, not the whole repo. Re-reading everything is how agents
// burn context and lose the plot; a focused repair packet keeps the loop tight.

import type { Decision, Evidence, Operation } from "../objects/types.ts";

export interface RepairContext {
  /** The operations that failed and must be repaired. */
  failedOps: { oid: string; purpose: string; target: string; path?: string }[];
  /** The failing evidence, with its (truncated) output. */
  failures: { kind: string; result: string; command?: string; detail?: string }[];
  /** Decisions that touch these ops — prior rulings the repair must respect. */
  relatedDecisions: { oid: string; reason: string; futurePolicy?: string }[];
  /** A short, imperative instruction for the agent. */
  suggestion: string;
}

/**
 * Build a repair packet from a set of ops and the evidence/decisions about them.
 * Pure; the caller supplies the already-loaded objects.
 */
export function buildRepairContext(
  ops: Operation[],
  evidence: Evidence[],
  decisions: Decision[],
): RepairContext {
  const opIds = new Set(ops.map((o) => o.oid as string));
  const failures = evidence
    .filter((e) => e.result === "fail" && e.forOps.some((o) => opIds.has(o)))
    .map((e) => ({ kind: e.kind, result: e.result, command: e.command, detail: truncate(e.detail, 1500) }));
  const relatedDecisions = decisions
    .filter((d) => [...d.chosenOps, ...d.rejectedOps].some((o) => opIds.has(o)))
    .map((d) => ({ oid: d.oid as string, reason: d.reason, futurePolicy: d.futurePolicy }));

  const kinds = [...new Set(failures.map((f) => f.kind))];
  const suggestion = failures.length
    ? `Fix the ${kinds.join(", ")} failure(s) by appending a new operation; do not hide or rewrite the failing op. Re-run the same checks. ${
        relatedDecisions.length ? "Respect the related prior decision(s)." : ""
      }`.trim()
    : "No failing evidence found for these ops.";

  return {
    failedOps: ops.map((o) => ({
      oid: o.oid as string,
      purpose: o.declaredPurpose,
      target: `${o.target.entityKind}:${o.target.entityId}`,
      path: o.body.path,
    })),
    failures,
    relatedDecisions,
    suggestion,
  };
}

function truncate(s: string | undefined, n: number): string | undefined {
  if (s === undefined) return undefined;
  return s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s;
}
