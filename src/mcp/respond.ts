// Phase 16 M1.1 (docs/18 §1.1) — the MCP response layer.
//
// Tokens are a budget (docs/18 §2 principle 2). Two consequences live here:
//
//  - Serialization is COMPACT by default. Pretty-printing costs indentation tokens on
//    every call an agent ever makes, for a reader that is not human. `verbose` restores
//    it for the times a person is actually looking.
//  - Every failure becomes a machine-readable envelope carrying `nextActions`, so an
//    agent recovers by following a list instead of parsing prose and flailing (§1 gap 6).
//
// What this layer deliberately does NOT do: wrap success shapes. Existing consumers and
// tests parse the raw shape, so compatibility is absolute — additive fields only
// (§2 principle 1, and the second recorded risk in §5).

/** The serialized form of a failed tool call. `nextActions` are tool calls or commands, in
 *  the order worth trying; absent when the failure class is unrecognized (never invented). */
export interface ErrorEnvelope {
  error: string;
  hint?: string;
  nextActions?: string[];
}

/** A known failure class and the way out of it. */
export interface RecoveryRule {
  re: RegExp;
  hint?: string;
  nextActions: string[];
}

/**
 * Known failure classes → what to do about them. Every dotted `avcs.*` name here must be a
 * REGISTERED tool — a hint pointing at a tool that does not exist is worse than prose,
 * because the agent follows it and fails. A test pins this against the live tool list.
 */
export const RECOVERY: RecoveryRule[] = [
  {
    // The one error an agent used to flail on becomes a single call: land re-pushes,
    // re-checks the merge, re-checkpoints and re-integrates, and the queue behind it
    // re-reduces the frontier union rather than bouncing the submission back.
    re: /head moved|not up to date|stale (parent|head)/i,
    hint: "the view's head advanced while you worked; landing absorbs that for you",
    nextActions: ["avcs.sync.land", "avcs.integration.status"],
  },
  {
    re: /no local signing key|signing key|keystore/i,
    hint: "this action must be signed by an actor key held locally",
    nextActions: ["avcs key provision <actor-id>", "avcs key ls"],
  },
  {
    re: /not an AVCS repo|no \.avcs/i,
    hint: "the resolved directory has no .avcs/ at or above it",
    nextActions: ["pass cwd: <repo dir> with the call", "avcs init <dir>"],
  },
  {
    re: /open conflict|conflicts? remain|unresolved conflict/i,
    hint: "a human decision is required; do not retry through it",
    nextActions: ["avcs.conflict.list", "avcs.decision.record"],
  },
  {
    re: /lease|held by/i,
    hint: "another actor holds a write lease overlapping your scope",
    nextActions: ["avcs.contention.check", "avcs.lease.request"],
  },
  {
    re: /validation failed|checks? failed|evidence/i,
    hint: "the gate wants passing evidence bound to this tree",
    nextActions: ["avcs.validate.run", "avcs.evidence.attach", "avcs.repair.context"],
  },
];

/**
 * Normalize a caller-supplied limit against a default (Phase 16 M1.2). A missing, negative,
 * zero, or non-finite value falls back to the default rather than returning nothing or
 * everything — an unbounded read is the failure mode this layer exists to prevent.
 */
export function boundedLimit(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Serialize a successful tool result. Compact unless a human asked for readability. */
export function serializeResult(result: unknown, opts?: { verbose?: boolean }): string {
  return opts?.verbose ? JSON.stringify(result, null, 2) : JSON.stringify(result);
}

/** Translate a thrown value into the failure envelope the transport sends. */
export function errorEnvelope(e: unknown): ErrorEnvelope {
  const error = e instanceof Error ? e.message : String(e);
  const rule = RECOVERY.find((r) => r.re.test(error));
  if (!rule) return { error };
  return { error, hint: rule.hint, nextActions: rule.nextActions };
}
