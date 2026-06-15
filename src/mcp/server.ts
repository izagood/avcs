// AVCS MCP server — the primary, agent-facing interface.
//
// Agents do not run a CLI and they do not edit files directly into history. They
// call these tools: read the intent, build context, propose operations, attach
// evidence, ask whether things merge, and surface decisions to humans. The exact
// same Repo facade backs the CLI and the demo, so behavior is identical.
//
// Run:  AVCS_REPO=/path/to/repo node --experimental-strip-types src/mcp/server.ts
// Requires the optional dependency `@modelcontextprotocol/sdk` (npm i).
//
// Skill/system-prompt rules to inject into agents (see docs/06-mcp-interface.md):
//   • Never write final files directly — submit avcs.operation.propose.
//   • Declare effects (changesBehavior / breaksPublicApi) honestly.
//   • A behavior change cannot be accepted without passing-test evidence.
//   • On a conflict, produce options for a human; do not silently overwrite.

import { pathToFileURL } from "node:url";
import { Repo } from "../api/repo.ts";
import type { Actor } from "../objects/types.ts";

const REPO_DIR = process.env.AVCS_REPO ?? process.cwd();

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (repo: Repo, input: Record<string, unknown>) => Promise<unknown>;
}

export function actorOf(input: Record<string, unknown>): Actor {
  const a = (input.actor ?? {}) as Partial<Actor>;
  return { kind: a.kind ?? "ai_agent", id: a.id ?? "ai:unknown", ...(a.model ? { model: a.model } : {}) };
}

const actorSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["human", "ai_agent", "ci_bot"] },
    id: { type: "string" },
    model: { type: "string" },
  },
  required: ["id"],
};

export const TOOLS: ToolDef[] = [
  {
    name: "avcs.intent.create",
    description: "Open an intent: the goal + constraints + allowed scopes for a unit of work. Agents must work within an intent.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        owner: { type: "string", description: "actor id, usually a human" },
        kind: { type: "string", enum: ["feature", "bugfix", "refactor", "formatting", "generated"] },
        priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
        constraints: { type: "array", items: { type: "string" } },
        successCriteria: { type: "array", items: { type: "string" } },
        allowedScopes: { type: "array", items: { type: "string" } },
      },
      required: ["title", "owner"],
    },
    handler: (repo, i) => repo.createIntent(i as never),
  },
  {
    name: "avcs.intent.read",
    description: "Read an intent (goal, constraints, allowed scopes). An agent should read this BEFORE proposing operations so it works within the constraints.",
    inputSchema: { type: "object", properties: { intentOid: { type: "string" } }, required: ["intentOid"] },
    handler: (repo, i) => repo.readIntent(String(i.intentOid)),
  },
  {
    name: "avcs.intent.list",
    description: "List all intents in the repo.",
    inputSchema: { type: "object", properties: {} },
    handler: (repo) => repo.listIntents(),
  },
  {
    name: "avcs.session.start",
    description: "Begin a work session for an agent/human against an intent. Returns a session id used on every operation.",
    inputSchema: {
      type: "object",
      properties: {
        intentOid: { type: "string" },
        actor: actorSchema,
        summary: { type: "string" },
        openedEntities: { type: "array", items: { type: "string" } },
      },
      required: ["intentOid", "actor"],
    },
    handler: (repo, i) =>
      repo.startSession({ intentOid: String(i.intentOid), actor: actorOf(i), summary: i.summary as string }),
  },
  {
    name: "avcs.operation.propose",
    description: "Propose a semantic change. MVP supports file writes. DECLARE EFFECTS honestly (changesBehavior, breaksPublicApi) — policy gates on them.",
    inputSchema: {
      type: "object",
      properties: {
        sessionOid: { type: "string" },
        intentOid: { type: "string" },
        actor: actorSchema,
        path: { type: "string" },
        content: { type: "string" },
        declaredPurpose: { type: "string" },
        causalDeps: { type: "array", items: { type: "string" } },
        line: { type: "string", description: "lineage to author on; default 'main' (Phase 8)" },
        effects: {
          type: "object",
          properties: {
            changesBehavior: { type: "boolean" },
            breaksPublicApi: { type: "boolean" },
            reads: { type: "array", items: { type: "string" } },
          },
        },
      },
      required: ["sessionOid", "intentOid", "actor", "path", "content", "declaredPurpose"],
    },
    handler: (repo, i) =>
      repo.proposeFileWrite({
        sessionOid: String(i.sessionOid),
        intentOid: String(i.intentOid),
        actor: actorOf(i),
        path: String(i.path),
        content: String(i.content),
        declaredPurpose: String(i.declaredPurpose),
        causalDeps: i.causalDeps as string[] | undefined,
        effects: i.effects as never,
        line: i.line as string | undefined,
      }),
  },
  {
    name: "avcs.line.create",
    description: "Fork a long-lived line (e.g. 'v1.x') from another line at its current state. The new line inherits history up to the fork and then diverges — same entity can hold different content per line with no conflict (Phase 8).",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, fromLine: { type: "string" }, atCheckpointOid: { type: "string" } },
      required: ["name"],
    },
    handler: (repo, i) => repo.createLine(String(i.name), (i.fromLine as string) ?? "main", i.atCheckpointOid as string | undefined),
  },
  {
    name: "avcs.line.list",
    description: "List the lineage lines in the repo (besides the implicit 'main').",
    inputSchema: { type: "object", properties: {} },
    handler: (repo) => repo.listLines(),
  },
  {
    name: "avcs.operation.backport",
    description: "Port (cherry-pick / backport) an operation onto another line: mints a new op on the target line carrying the source's change, with derivedFrom provenance. Does not affect the source line.",
    inputSchema: {
      type: "object",
      properties: { sourceOpOid: { type: "string" }, targetLine: { type: "string" }, actor: actorSchema },
      required: ["sourceOpOid", "targetLine"],
    },
    handler: (repo, i) => repo.portOp(String(i.sourceOpOid), String(i.targetLine), i.actor ? actorOf(i) : undefined),
  },
  {
    name: "avcs.evidence.attach",
    description: "Attach machine-checkable evidence (test/typecheck/lint/...) to operations. Behavior changes need a passing test to be accepted.",
    inputSchema: {
      type: "object",
      properties: {
        forOps: { type: "array", items: { type: "string" } },
        kind: {
          type: "string",
          enum: ["parse", "typecheck", "lint", "unit_test", "integration_test", "benchmark", "security_scan", "api_compat"],
        },
        result: { type: "string", enum: ["pass", "fail", "partial", "not_run"] },
        actor: actorSchema,
        command: { type: "string" },
        detail: { type: "string" },
      },
      required: ["forOps", "kind", "result"],
    },
    handler: (repo, i) =>
      repo.attachEvidence({
        forOps: i.forOps as string[],
        kind: i.kind as never,
        result: i.result as never,
        producedBy: actorOf(i),
        command: i.command as string | undefined,
        detail: i.detail as string | undefined,
      }),
  },
  {
    name: "avcs.view.materialize",
    description: "Reduce the operation graph for a view into a code tree + per-op status + open conflicts. This is how an agent checks whether its work merges.",
    inputSchema: { type: "object", properties: { view: { type: "string" } } },
    handler: async (repo, i) => {
      const res = await repo.materialize((i.view as string) ?? "main");
      const status: Record<string, string> = {};
      for (const [oid, s] of res.statuses) status[oid] = s;
      return {
        treeHash: res.treeHash,
        files: [...res.tree.keys()].sort(),
        status,
        conflicts: res.conflicts,
      };
    },
  },
  {
    name: "avcs.conflict.list",
    description: "List the conflicts that require a human/owner decision in a view.",
    inputSchema: { type: "object", properties: { view: { type: "string" } } },
    handler: async (repo, i) => (await repo.materialize((i.view as string) ?? "main")).conflicts,
  },
  {
    name: "avcs.decision.record",
    description: "Record a HUMAN/owner resolution of a conflict. Chosen ops are accepted, rejected ops dropped — and the rationale becomes reusable history. Rejected unless actor.kind is 'human' (an agent may not decide its own conflicts; cryptographic enforcement lands in Phase 3).",
    inputSchema: {
      type: "object",
      properties: {
        conflictId: { type: "string" },
        chosenOps: { type: "array", items: { type: "string" } },
        rejectedOps: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
        actor: actorSchema,
        futurePolicy: { type: "string" },
      },
      required: ["conflictId", "reason"],
    },
    handler: (repo, i) => {
      const actor = actorOf(i);
      if (actor.kind !== "human") {
        throw new Error("avcs.decision.record requires a human actor; agents may not resolve their own conflicts");
      }
      return repo.recordDecision({
        conflictId: String(i.conflictId),
        chosenOps: (i.chosenOps as string[]) ?? [],
        rejectedOps: (i.rejectedOps as string[]) ?? [],
        reason: String(i.reason),
        decidedBy: actor,
        futurePolicy: i.futurePolicy as string | undefined,
      });
    },
  },
  {
    name: "avcs.checkpoint.create",
    description: "Freeze a verified (ops + policy + materializer + evidence) state vector for a view.",
    inputSchema: {
      type: "object",
      properties: { view: { type: "string" }, summary: { type: "string" } },
    },
    handler: (repo, i) => repo.createCheckpoint((i.view as string) ?? "main", (i.summary as string) ?? "checkpoint"),
  },
  {
    name: "avcs.lease.request",
    description: "Request a soft write-lease over entity scopes BEFORE editing, to avoid duplicating another agent's in-flight work. Returns the lease oid, or the conflicting holders.",
    inputSchema: {
      type: "object",
      properties: {
        intentOid: { type: "string" },
        sessionOid: { type: "string" },
        actor: actorSchema,
        writeScopes: { type: "array", items: { type: "string" }, description: "e.g. ['symbol:mod.ts#alpha','file:a.ts']" },
        mode: { type: "string", enum: ["exclusive", "shared"] },
        ttlMs: { type: "number" },
      },
      required: ["intentOid", "sessionOid", "actor", "writeScopes"],
    },
    handler: (repo, i) =>
      repo.requestLease({
        intentOid: String(i.intentOid),
        sessionOid: String(i.sessionOid),
        actor: actorOf(i),
        writeScopes: i.writeScopes as string[],
        mode: i.mode as "exclusive" | "shared" | undefined,
        ttlMs: i.ttlMs as number | undefined,
      }),
  },
  {
    name: "avcs.validate.run",
    description: "Run validation commands (test/lint/typecheck) against a materialized view and attach the results as signed-able Evidence. Behavior changes need passing evidence to be accepted.",
    inputSchema: {
      type: "object",
      properties: {
        ops: { type: "array", items: { type: "string" } },
        view: { type: "string" },
        ciActor: actorSchema,
        checks: {
          type: "array",
          items: {
            type: "object",
            properties: { kind: { type: "string" }, command: { type: "string" } },
            required: ["kind", "command"],
          },
        },
      },
      required: ["ops", "ciActor", "checks"],
    },
    handler: async (repo, i) => {
      const { runChecks } = await import("../validation/runner.ts");
      const { mkdtemp } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const workspaceDir = await mkdtemp(join(tmpdir(), "avcs-validate-"));
      return runChecks(repo, {
        ops: i.ops as string[],
        view: i.view as string | undefined,
        workspaceDir,
        ciActor: actorOf(i),
        checks: i.checks as { kind: never; command: string }[],
      });
    },
  },
  {
    name: "avcs.repair.context",
    description: "Get a MINIMAL repair packet for ops whose validation failed (the failing output + related prior decisions + a fix instruction). Use instead of re-reading the whole repo.",
    inputSchema: { type: "object", properties: { ops: { type: "array", items: { type: "string" } } }, required: ["ops"] },
    handler: (repo, i) => repo.repairContext(i.ops as string[]),
  },
  {
    name: "avcs.metrics",
    description: "In-process metrics snapshot for this server (reduce cache hit/miss, reduce.ms timing, materialize.calls).",
    inputSchema: { type: "object", properties: {} },
    handler: async (repo) => repo.metrics.snapshot(),
  },
  {
    name: "avcs.blame",
    description: "Who currently owns an entity (file:<path> or symbol:<path>#<name>) and WHY — the accepted head op with actor, intent title, and purpose. Stronger than git blame.",
    inputSchema: { type: "object", properties: { entityKey: { type: "string" }, line: { type: "string" } }, required: ["entityKey"] },
    handler: (repo, i) => repo.blame(String(i.entityKey), (i.line as string) ?? "main"),
  },
  {
    name: "avcs.history",
    description: "History of one entity in causal order (the ops that touched a file/symbol, each with actor/intent/purpose). O(ops-on-entity) via the entity index.",
    inputSchema: { type: "object", properties: { entityKey: { type: "string" } }, required: ["entityKey"] },
    handler: async (repo, i) =>
      (await repo.historyOf(String(i.entityKey))).map((o) => ({ op: o.oid, actor: o.actor.id, purpose: o.declaredPurpose, at: o.createdAt, line: o.line ?? "main" })),
  },
  {
    name: "avcs.diff",
    description: "Diff two views/lines: added/removed/modified paths.",
    inputSchema: { type: "object", properties: { viewA: { type: "string" }, viewB: { type: "string" } }, required: ["viewA", "viewB"] },
    handler: (repo, i) => repo.diff(String(i.viewA), String(i.viewB)),
  },
  {
    name: "avcs.release.cut",
    description: "Cut a Release: a verified (conflict-free) checkpoint + its evidence + an SBOM of what shipped + artifact references. Refuses if the view has open or semantic conflicts.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string" },
        summary: { type: "string" },
        signedBy: { type: "array", items: { type: "string" }, description: "actor ids signing off" },
        artifacts: {
          type: "array",
          items: {
            type: "object",
            properties: { type: { type: "string" }, ref: { type: "string" }, digest: { type: "string" } },
            required: ["type", "ref"],
          },
        },
      },
    },
    handler: (repo, i) =>
      repo.cutRelease((i.view as string) ?? "main", {
        summary: i.summary as string | undefined,
        signedBy: i.signedBy as string[] | undefined,
        artifacts: i.artifacts as never,
      }),
  },
];

async function main(): Promise<void> {
  let sdk: typeof import("@modelcontextprotocol/sdk/server/index.js");
  let stdio: typeof import("@modelcontextprotocol/sdk/server/stdio.js");
  let typesMod: typeof import("@modelcontextprotocol/sdk/types.js");
  try {
    sdk = await import("@modelcontextprotocol/sdk/server/index.js");
    stdio = await import("@modelcontextprotocol/sdk/server/stdio.js");
    typesMod = await import("@modelcontextprotocol/sdk/types.js");
  } catch {
    console.error(
      "[avcs-mcp] @modelcontextprotocol/sdk is not installed.\n" +
        "          Run `npm install` (it is an optionalDependency), then start again.\n" +
        "          Tool surface is defined in src/mcp/server.ts regardless.",
    );
    process.exit(1);
  }

  const server = new sdk.Server({ name: "avcs", version: "0.0.1" }, { capabilities: { tools: {} } });

  server.setRequestHandler(typesMod.ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  // Reuse one Repo instance across tool calls so the reduce cache and metrics persist
  // for the life of the server (the long-lived agent-facing process M1's cache targets).
  let repo: Repo | null = null;
  server.setRequestHandler(typesMod.CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) throw new Error(`unknown tool: ${req.params.name}`);
    if (!repo) repo = await Repo.open(REPO_DIR);
    const result = await tool.handler(repo, (req.params.arguments ?? {}) as Record<string, unknown>);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  await server.connect(new stdio.StdioServerTransport());
  console.error(`[avcs-mcp] serving repo ${REPO_DIR} over stdio (${TOOLS.length} tools)`);
}

// Only start the stdio server when run as the entry point — importing this module
// (e.g. from tests, to exercise the tool handlers) must not boot the server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
