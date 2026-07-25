// Phase 16 M2.2 (docs/18 §2.2) — the land loop behind `avcs.sync.land`.
//
// This is where principle 3 lives: "an agent does not know git's pain". Landing work is one
// call, and the agent sees exactly two outcomes — it landed, or a conflict a human must
// decide. The string "head moved" never reaches it.
//
// Two paths reach that contract (docs/18 §5, the recorded max-risk decision):
//   - the hub's integration queue re-reduces the frontier union for us (Phase 14), and
//   - a bounded local loop for a repo with no hub, or a hub too old to have the queue.
// `repo.integrateHub` already picks between them, so this module stays a loop over a
// verdict rather than a second implementation of the choice.
//
// Kept out of server.ts so it is unit-testable without the SDK (docs/18 §3).

import type { Repo } from "../api/repo.ts";

export interface LandArgs {
  view?: string;
  summary?: string;
  by: string;
  hub?: string;
  maxAttempts?: number;
  workspace?: string;
}

export type LandResult =
  | { landed: true; head: string; treeHash: string; attempts: number; via: "hub" | "local" }
  | {
      landed: false;
      reason: "conflict" | "needs_evidence" | "rejected" | "exhausted";
      attempts: number;
      detail?: string;
      conflicts?: unknown[];
      packet?: unknown;
      nextActions: string[];
    };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Push → materialize → checkpoint → integrate, retried a bounded number of times.
 *
 * The retry exists for contention (someone else's landing raced ours), NOT for conflicts:
 * an open conflict means a human has to choose, and spinning the loop through it would
 * burn attempts, pile up checkpoint objects, and still need the human at the end. So a
 * conflict returns on the FIRST attempt with the packet needed to decide.
 */
export async function land(repo: Repo, args: LandArgs): Promise<LandResult> {
  const view = args.view ?? "main";
  const maxAttempts = Math.max(1, Math.floor(args.maxAttempts ?? 5));
  const summary = args.summary ?? `land ${view}`;

  // A workspace is local and idempotent — do it once, before the loop it does not affect.
  if (args.workspace) await repo.landWorkspace(args.workspace);

  const remote = args.hub ?? "origin";
  let hasRemote = true;
  try {
    await repo.remoteUrl(remote);
  } catch {
    hasRemote = false; // purely local repo: finalize locally, no gossip involved
  }

  let attempts = 0;
  let lastDetail: string | undefined;
  while (attempts < maxAttempts) {
    attempts++;
    // (a) The hub gates on what it can see, so our ops/evidence go first.
    if (hasRemote) await repo.sync(remote, { as: args.by });

    // (b) Check the work actually merges BEFORE minting a checkpoint for it.
    const res = await repo.materialize(view);
    if (res.conflicts.length > 0) {
      return {
        landed: false,
        reason: "conflict",
        attempts,
        conflicts: res.conflicts,
        // The repair packet is built from the ops actually in contention — each conflict's
        // options ARE the candidate ops, so the human sees what they are choosing between.
        packet: await repo
          .repairContext(res.conflicts.flatMap((c) => c.options.map((o) => o.opOid)))
          .catch(() => undefined),
        nextActions: [
          "avcs.conflict.list",
          "present the options to a human, then avcs.decision.record",
          "avcs.sync.land (again, once the decision is recorded)",
        ],
      };
    }

    // (c) Package the state we just proved merges.
    const checkpoint = await repo.createCheckpoint(view, summary);

    // (d) Land it. With no remote this is a local finalize; with one, the queue decides.
    if (!hasRemote) {
      const parentHead = await repo.protectedHead(view);
      const r = await repo.finalize({ view, newCheckpoint: checkpoint, parentHead, by: args.by });
      if (r.finalized) {
        return { landed: true, head: r.head ?? checkpoint, treeHash: res.treeHash, attempts, via: "local" };
      }
      // A local CAS loss means another process moved the head — exactly what the retry is
      // for. Anything else is terminal.
      lastDetail = r.reason;
      if (!/head moved/.test(r.reason ?? "")) {
        return { landed: false, reason: "rejected", attempts, detail: r.reason, nextActions: recoveryFor(r.reason) };
      }
      await sleep(jitter(attempts));
      continue;
    }

    const verdict = await repo.integrateHub(remote, { view, checkpoint, by: args.by });
    if (verdict.verdict === "advanced") {
      return {
        landed: true,
        head: (verdict.head as string) ?? checkpoint,
        treeHash: res.treeHash,
        attempts,
        via: verdict.legacy ? "local" : "hub",
      };
    }
    if (verdict.verdict === "conflict") {
      return {
        landed: false,
        reason: "conflict",
        attempts,
        conflicts: (verdict.conflicts as unknown[]) ?? [],
        packet: verdict.packet,
        nextActions: [
          "avcs.conflict.list",
          "present the options to a human, then avcs.decision.record",
          "avcs.sync.land (again, once the decision is recorded)",
        ],
      };
    }
    if (verdict.verdict === "needs_evidence") {
      // The queue reserved a tree for us; it wants validation run against exactly that tree
      // ONCE, then the same ticket advances. Retrying blindly would just re-reserve.
      return {
        landed: false,
        reason: "needs_evidence",
        attempts,
        detail: String(verdict.reason ?? "the integration queue requires fresh evidence for the reserved tree"),
        nextActions: ["avcs.validate.run", "avcs.evidence.attach", "avcs.sync.land (again, to advance the same ticket)"],
      };
    }
    if (verdict.verdict === "queued") {
      // Someone else is being judged; back off and take our turn.
      lastDetail = "queued behind another submission";
      await sleep(jitter(attempts));
      continue;
    }
    return {
      landed: false,
      reason: "rejected",
      attempts,
      detail: String(verdict.reason ?? verdict.verdict),
      nextActions: recoveryFor(String(verdict.reason ?? "")),
    };
  }

  return {
    landed: false,
    reason: "exhausted",
    attempts,
    detail: lastDetail,
    nextActions: ["avcs.sync.land (retry — contention, not a defect)", "avcs.integration.status"],
  };
}

/** Jittered backoff: contention resolves faster when retries do not align. */
function jitter(attempt: number): number {
  const base = Math.min(50 * 2 ** (attempt - 1), 800);
  // Deterministic-enough spread without Math.random: attempt count shapes the offset.
  return base + (attempt % 3) * 17;
}

function recoveryFor(reason: string | undefined): string[] {
  if (reason && /evidence|check/i.test(reason)) return ["avcs.validate.run", "avcs.evidence.attach"];
  if (reason && /role|approval|permission/i.test(reason)) return ["avcs.metrics", "ask a maintainer to approve the checkpoint"];
  return ["avcs.view.materialize", "avcs.conflict.list"];
}
