// Phase 5: actor trust learning.
//
// A fixed actorTrust ladder treats every AI agent the same forever. In practice an
// agent earns or loses standing: ops it produced that humans rejected, or that
// failed checks, should weigh less next time; ops with passing trusted evidence
// should weigh slightly more. This computes a bounded per-actor reliability signal
// from history (decisions + evidence) — acyclic, so it never feeds back into itself.

import type { Decision, Evidence, Operation } from "../objects/types.ts";

/** Bounded so it nudges ties without overpowering the policy ladder (cf. the C1 bug). */
const CAP = 3;

/**
 * actorId → reliability in [-CAP, CAP]. +1 per op with trusted passing evidence,
 * −1 per op a human explicitly rejected. Trust-filter the evidence before passing.
 */
export function computeReliability(
  ops: Operation[],
  evidence: Evidence[],
  decisions: Decision[],
): Map<string, number> {
  const opActor = new Map(ops.map((o) => [o.oid as string, o.actor.id]));
  const raw = new Map<string, number>();
  const bump = (actor: string, d: number) => raw.set(actor, (raw.get(actor) ?? 0) + d);

  for (const e of evidence) {
    if (e.result !== "pass") continue;
    if (e.producedBy.kind === "ai_agent") continue; // self-reports don't build trust
    for (const op of e.forOps) {
      const a = opActor.get(op);
      if (a) bump(a, 1);
    }
  }
  for (const d of decisions) {
    for (const op of d.rejectedOps) {
      const a = opActor.get(op);
      if (a) bump(a, -1);
    }
  }

  const clamped = new Map<string, number>();
  for (const [actor, v] of raw) clamped.set(actor, Math.max(-CAP, Math.min(CAP, v)));
  return clamped;
}
