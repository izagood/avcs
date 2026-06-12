// Policy engine.
//
// AVCS never defaults to last-write-wins for code. When concurrent operations
// contend for the same entity, a *policy* decides — deterministically and with a
// recorded rationale — using this ladder (highest first):
//
//   1. safety/security              (rule-driven)
//   2. explicit human decision      (a Decision object; handled in the reducer)
//   3. code-owner / human actor      (actorTrust + prefer_actor)
//   4. intent constraints satisfied  (declared effects vs intent constraints)
//   5. verified by evidence          (require_evidence gating + bonus)
//   6. actor trust level             (actorTrust ladder)
//   7. smaller blast radius          (advisory)
//   8. recency (Lamport)             (final tie-break — applied in the reducer's
//                                     ranking comparator, NOT added to the score;
//                                     adding it lets time overwhelm the ladder)
//
// Evidence trust: an operation's own author cannot vouch for it. require_evidence
// gates and the passing-test bonus only count evidence produced by a non-authoring
// trusted actor (ci_bot / human). Self-reported ai_agent evidence is ignored until
// signing lands (Phase 3). See docs/04-policy.md.

import type {
  Actor,
  Evidence,
  Operation,
  Policy,
  PolicyRule,
} from "../objects/types.ts";

export const MATERIALIZER_VERSION = "avcs-text-mvp/0.0.1";

/** A sane built-in policy used when a repo has not authored its own. */
export function defaultPolicy(): Policy {
  return {
    type: "policy",
    version: "default/2026.06",
    actorTrust: ["ai_agent", "ci_bot", "human"], // human most trusted
    rules: [
      // A change that alters runtime behavior must carry a passing test.
      {
        name: "behavior_change_requires_test",
        when: { changesBehavior: true },
        effect: { type: "require_evidence", evidence: "unit_test", result: "pass" },
      },
      // Breaking the public API is never auto-merged — a human must decide.
      {
        name: "public_api_break_requires_human",
        when: { breaksPublicApi: true },
        effect: { type: "require_human" },
      },
      // Pure formatting loses every contest.
      {
        name: "formatting_low_priority",
        when: { opKind: "note" },
        effect: { type: "priority", weight: -50 },
      },
      // On any conflict, prefer the human's operation.
      {
        name: "human_wins_conflicts",
        when: { onConflict: true },
        effect: { type: "prefer_actor", kind: "human" },
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

export interface OpEvaluation {
  blocked: boolean; // failed a require_evidence gate → cannot be accepted
  blockedReason?: string;
  requiresHuman: boolean; // matched a require_human rule → no auto-accept
  score: number; // priority score; higher wins
  notes: string[];
}

function actorTrustScore(policy: Policy, actor: Actor): number {
  const idx = policy.actorTrust.indexOf(actor.kind);
  return (idx < 0 ? 0 : idx + 1) * 100;
}

function ruleMatches(rule: PolicyRule, op: Operation, inConflict: boolean): boolean {
  const w = rule.when;
  if (w.opKind !== undefined && op.body.kind !== w.opKind) return false;
  if (w.breaksPublicApi !== undefined && !!op.effects?.breaksPublicApi !== w.breaksPublicApi)
    return false;
  if (w.changesBehavior !== undefined && !!op.effects?.changesBehavior !== w.changesBehavior)
    return false;
  if (w.onConflict !== undefined && w.onConflict !== inConflict) return false;
  return true;
}

/**
 * Evaluate one operation under a policy, given the evidence attached to it and
 * whether it is currently contended.
 */
export function evaluateOp(
  policy: Policy,
  op: Operation,
  evidenceForOp: Evidence[],
  inConflict: boolean,
  intentConstraintsSatisfied: boolean,
): OpEvaluation {
  const ev: OpEvaluation = {
    blocked: false,
    requiresHuman: false,
    score: actorTrustScore(policy, op.actor),
    notes: [],
  };

  // Only evidence the operation's own author did NOT produce can vouch for it.
  const trusted = evidenceForOp.filter(
    (e) => e.producedBy.kind !== "ai_agent" || e.producedBy.id !== op.actor.id,
  );
  const ignored = evidenceForOp.length - trusted.length;
  if (ignored > 0) ev.notes.push(`${ignored} self-reported evidence ignored`);

  // Base signals.
  if (intentConstraintsSatisfied) {
    ev.score += 200;
  } else {
    ev.score -= 200;
    ev.notes.push("violates intent constraints");
  }
  // A passing test is worth more than self-reported confidence.
  if (trusted.some((e) => e.result === "pass" && e.kind.endsWith("test"))) {
    ev.score += 150;
    ev.notes.push("has passing tests");
  }

  for (const rule of policy.rules) {
    if (!ruleMatches(rule, op, inConflict)) continue;
    const e = rule.effect;
    switch (e.type) {
      case "require_human":
        ev.requiresHuman = true;
        ev.notes.push(`rule ${rule.name}: requires human decision`);
        break;
      case "require_evidence": {
        const ok = trusted.some((x) => x.kind === e.evidence && x.result === e.result);
        if (!ok) {
          ev.blocked = true;
          ev.blockedReason = `rule ${rule.name}: missing trusted ${e.evidence}=${e.result}`;
          ev.notes.push(ev.blockedReason);
        }
        break;
      }
      case "priority":
        ev.score += e.weight;
        break;
      case "prefer_actor":
        if (op.actor.kind === e.kind) {
          ev.score += 500;
          ev.notes.push(`rule ${rule.name}: preferred actor ${e.kind}`);
        }
        break;
    }
  }

  // NOTE: lamport is deliberately NOT added here. Recency is a tie-break only,
  // applied by the reducer when scores are equal.
  return ev;
}
