// Phase 16 M4.2 (docs/18 §4.2) — MCP prompts.
//
// A prompt is a client-invocable template that arrives with its facts already inlined. The
// point is round trips: `avcs.propose-change` carries the intent's own constraints in the
// text, so the agent does not have to fetch them and then remember to honour them. The
// constraint an agent never read is a constraint it will break.

import { buildGuide } from "./guide.ts";
import type { Repo } from "../api/repo.ts";
import type { ToolDef } from "./server.ts";

export interface PromptDef {
  name: string;
  description: string;
  arguments: { name: string; description: string; required?: boolean }[];
}

export const PROMPTS: PromptDef[] = [
  {
    name: "avcs.onboard",
    description: "Teach the AVCS loop, rules and error recovery — the guide, inlined.",
    arguments: [],
  },
  {
    name: "avcs.propose-change",
    description: "Draft a change under an intent, with that intent's constraints and scopes inlined.",
    arguments: [
      { name: "intentOid", description: "the intent to work under", required: true },
      { name: "paths", description: "comma-separated paths you expect to touch" },
    ],
  },
  {
    name: "avcs.resolve-repair",
    description: "Repair operations whose validation failed, with the repair packet inlined.",
    arguments: [{ name: "ops", description: "comma-separated operation oids", required: true }],
  },
  {
    name: "avcs.review-change",
    description: "Review a checkpoint: changed paths, evidence and the view's protection, inlined.",
    arguments: [
      { name: "view", description: "view name; default main" },
      { name: "checkpointOid", description: "the checkpoint under review" },
    ],
  },
];

/** Render a prompt with its facts already resolved. Throws on an unknown name. */
export async function buildPrompt(
  repo: Repo,
  name: string,
  args: Record<string, unknown>,
  tools: ToolDef[] = [],
): Promise<string> {
  switch (name) {
    case "avcs.onboard":
      return [
        "You are working in an AVCS repository. Follow this loop and these rules.",
        JSON.stringify(buildGuide(tools), null, 2),
      ].join("\n\n");

    case "avcs.propose-change": {
      const intent = await repo.readIntent(String(args.intentOid));
      const lines = [
        `Intent: ${intent.title}`,
        intent.constraints?.length ? `Constraints (do not violate):\n${intent.constraints.map((c) => `  - ${c}`).join("\n")}` : "",
        intent.successCriteria?.length ? `Success criteria:\n${intent.successCriteria.map((c) => `  - ${c}`).join("\n")}` : "",
        intent.allowedScopes?.length ? `Allowed scopes:\n${intent.allowedScopes.map((s) => `  - ${s}`).join("\n")}` : "",
        typeof args.paths === "string" && args.paths ? `Paths you expect to touch: ${args.paths}` : "",
        "",
        "Start with avcs.context.build on this intent. Author changes with avcs.operation.propose —",
        "never write final files yourself. Declare effects honestly. Land with avcs.sync.land.",
      ];
      return lines.filter(Boolean).join("\n");
    }

    case "avcs.resolve-repair": {
      const ops = String(args.ops ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const packet = await repo.repairContext(ops);
      return [
        "These operations failed validation. Repair them, then re-run avcs.validate.run.",
        JSON.stringify(packet, null, 2),
      ].join("\n\n");
    }

    case "avcs.review-change": {
      const view = typeof args.view === "string" ? args.view : "main";
      const [protection, head, res] = await Promise.all([
        repo.getProtection(view),
        repo.protectedHead(view),
        repo.materialize(view),
      ]);
      const cp = typeof args.checkpointOid === "string" ? args.checkpointOid : head;
      const approvals = cp ? await repo.approvalsFor(cp) : [];
      return [
        `Review of view "${view}" (head ${head ?? "none"}, tree ${res.treeHash}).`,
        `Protection: ${JSON.stringify(protection)}`,
        `Approvals so far: ${JSON.stringify(approvals)}`,
        `Open conflicts: ${res.conflicts.length}`,
        "",
        "Read the diff with avcs.diff format:patch, check evidence, then record a verdict",
        "with avcs.approval.record.",
      ].join("\n");
    }

    default:
      throw new Error(`unknown prompt: ${name}`);
  }
}
