// Phase 16 M1.3 (docs/18 §1.3) — avcs.guide: on-demand self-onboarding.
//
// The economics this exists for: a tool's `description` is paid on EVERY session, by every
// agent, whether or not it needs teaching. A guide is paid only when called. So the
// teaching moves here and descriptions shrink to identification — which nets out smaller
// even after adding tools (§1.2's description-slimming pass is the other half of the deal).
//
// The hazard with any hand-written guide is drift: it describes a server that no longer
// exists. Everything derivable is therefore GENERATED from the live tables — the tool index
// from TOOLS, the error map from RECOVERY — so the guide cannot disagree with the server.

import { RECOVERY } from "./respond.ts";
import type { ToolDef } from "./server.ts";

export type GuideTopic = "workflow" | "tools" | "sync" | "rules" | "errors";

/**
 * The canonical loop an agent runs. Every `tool` here must be REGISTERED — a loop naming a
 * tool that does not exist teaches the agent to fail, and unlike prose an agent would skim,
 * a step it is told to run fails for certain. A test pins this against the live table.
 *
 */
const LOOP: { step: number; tool: string; why: string }[] = [
  { step: 1, tool: "avcs.intent.read", why: "learn the declared goal and the scopes you may touch" },
  { step: 2, tool: "avcs.session.start", why: "bind your work to that intent under your actor identity" },
  { step: 3, tool: "avcs.context.build", why: "get provenance, prior decisions and live risks for your scope in one bounded call" },
  { step: 4, tool: "avcs.lease.request", why: "claim the scopes you are about to write" },
  { step: 5, tool: "avcs.operation.propose", why: "submit the change as an operation; never write final files yourself" },
  { step: 6, tool: "avcs.validate.run", why: "produce evidence; a behaviour change is not acceptable without it" },
  { step: 7, tool: "avcs.evidence.attach", why: "bind that evidence to the ops it justifies" },
  { step: 8, tool: "avcs.view.materialize", why: "check the work actually merges, and read any open conflicts" },
  { step: 9, tool: "avcs.sync.land", why: "land it in one call — push, checkpoint and integrate are inside; you get landed or a conflict to decide" },
];

/** The agent obligations from docs/06, in a form a machine can carry in a system prompt. */
const RULES: string[] = [
  "Never write final files directly — submit avcs.operation.propose.",
  "Declare effects (changesBehavior / breaksPublicApi) honestly.",
  "A behaviour change cannot be accepted without passing-test evidence.",
  "On a conflict, produce options for a human; do not silently overwrite.",
  "Stay inside the intent's allowed scopes; widen the intent instead of exceeding it.",
  "Read a failure's nextActions and follow them; do not improvise recovery from the message text.",
];

const SYNC: string[] = [
  "avcs.sync.land is the way to land work: push, merge-check, checkpoint and integrate in one call.",
  "land returns landed:true, or landed:false with a reason and nextActions. It never tells you to pull and redo.",
  "A conflict is never retried through — it needs a human: avcs.conflict.list then avcs.decision.record, then land again.",
  "avcs.sync.pull is safe any time (conflict-free gossip); dryRun reports what would arrive.",
  "avcs.integration.status re-reads a ticket directly; verdicts are advanced | conflict | needs_evidence | queued.",
];

/** Build the guide. `tools` is the live table so the index is generated, never restated. */
export function buildGuide(tools: ToolDef[], topic?: string): Record<string, unknown> {
  const base = { v: 1 as const };
  switch (topic) {
    case "tools":
      // One line per tool, straight off the server's own table.
      return { ...base, tools: tools.map((t) => ({ name: t.name, description: t.description })) };
    case "rules":
      return { ...base, rules: RULES };
    case "sync":
      return { ...base, sync: SYNC };
    case "errors":
      return {
        ...base,
        errors: RECOVERY.map((r) => ({ when: r.re.source, hint: r.hint, nextActions: r.nextActions })),
      };
    case "workflow":
    default:
      // No topic (or an unknown one) answers with the canonical loop rather than erroring:
      // an agent guessing a topic name should still get the thing it most likely wanted.
      return { ...base, loop: LOOP, rules: RULES, topics: ["workflow", "tools", "sync", "rules", "errors"] };
  }
}
