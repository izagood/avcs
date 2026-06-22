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

import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Repo } from "../api/repo.ts";
import { isBinary } from "../core/bytes.ts";
import { ObjectStore } from "../store/objectStore.ts";
import type { Actor, OperationStatus } from "../objects/types.ts";

/**
 * Read the installed package version off disk. Works for both the type-stripped
 * source layout (src/mcp/server.ts) and the built layout (dist/mcp/server.js):
 * in both, the package root is two directories up. Returns null if the file is
 * missing or unparseable — callers treat that as "no drift signal", never a crash.
 */
function readPackageVersion(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

// An explicit pin. When set, the server serves exactly this repo (resolved upward to its
// `.avcs` root, so a subdirectory works too) and does NOT auto-discover — `AVCS_REPO` means
// "fixed to this repo". When unset, the server discovers the target repo per call.
const ENV_REPO = process.env.AVCS_REPO;

/** Result of an MCP elicitation prompt (subset of the SDK's ElicitResult). */
export interface ElicitOutcome {
  action: string; // "accept" | "decline" | "cancel"
  content?: Record<string, unknown>;
}

/** Per-call context handed to a handler: the channel to ask the human (elicitation). */
export interface ToolCtx {
  /** Ask the human to confirm/provide input via MCP elicitation. */
  elicit?: (message: string, requestedSchema: Record<string, unknown>) => Promise<ElicitOutcome>;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (repo: Repo, input: Record<string, unknown>, ctx?: ToolCtx) => Promise<unknown>;
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

/** Optional per-call repo target. A single long-lived MCP server can serve many repos: a
 *  tool call may carry `cwd` to say "operate on the repo owning this directory". Injected
 *  into every advertised tool schema so it's discoverable without bloating each ToolDef. */
const cwdSchema = {
  type: "string",
  description:
    "Absolute path of the working directory to act on; the server resolves it upward to the " +
    "owning AVCS repo (.avcs). Optional — defaults to the client's workspace root, then the " +
    "server's own cwd. Ignored when the server is pinned via AVCS_REPO.",
};

/**
 * Resolve which AVCS repo a tool call targets, returning its `.avcs` root dir.
 *
 * Precedence (each candidate is resolved upward via {@link ObjectStore.findRepoRoot}, so a
 * subdirectory of a repo resolves to the repo):
 *   1. `AVCS_REPO` — an explicit pin; if set, ONLY this is tried (a pin means a pin).
 *   2. `callCwd` — the per-call `cwd` argument (one server, many repos).
 *   3. client workspace roots — what the MCP client advertises via `roots` (the
 *      protocol-blessed way to learn the agent's working dirs; absent for clients that
 *      don't support it).
 *   4. the server's own `process.cwd()` — last resort.
 *
 * Throws with the list of places searched when nothing resolves, so the failure is
 * actionable rather than a bare "not an AVCS repo". `listRoots` is a callback (not the SDK
 * server) so this is unit-testable and only invoked when earlier candidates miss.
 */
export async function resolveRepoDir(
  callCwd: string | undefined,
  listRoots: () => Promise<string[]>,
): Promise<string> {
  if (ENV_REPO) {
    const root = ObjectStore.findRepoRoot(ENV_REPO);
    if (root) return root;
    throw new Error(
      `AVCS_REPO=${ENV_REPO} is not an AVCS repo (no .avcs/ at or above it). ` +
        "Run `avcs init` there, fix the path, or unset AVCS_REPO to auto-discover.",
    );
  }
  const tried: string[] = [];
  const tryDir = (d: string | undefined): string | null => {
    if (!d) return null;
    tried.push(d);
    return ObjectStore.findRepoRoot(d);
  };
  let root = tryDir(callCwd);
  if (root) return root;
  for (const r of await listRoots()) {
    root = tryDir(r);
    if (root) return root;
  }
  root = tryDir(process.cwd());
  if (root) return root;
  throw new Error(
    `could not locate an AVCS repo. Searched at and above: ${tried.join(", ") || "(nowhere)"}. ` +
      "Pass `cwd` to the tool, register the server with AVCS_REPO (`avcs mcp install --repo <dir>`), " +
      "or run `avcs init`.",
  );
}

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
    description: "Propose a semantic change. MVP supports file writes. DECLARE EFFECTS honestly (changesBehavior, breaksPublicApi) — policy gates on them. Pass baseText or baseBlobOid to author a base-relative edit_file (3-way-mergeable with concurrent edits); omit both for a whole-file put_file.",
    inputSchema: {
      type: "object",
      properties: {
        sessionOid: { type: "string" },
        intentOid: { type: "string" },
        actor: actorSchema,
        path: { type: "string" },
        content: { type: "string", description: "the FULL new file content (used for both put_file and edit_file)" },
        declaredPurpose: { type: "string" },
        causalDeps: { type: "array", items: { type: "string" } },
        line: { type: "string", description: "lineage to author on; default 'main' (Phase 8)" },
        workspace: { type: "string", description: "isolate this op to a build/verify workspace (docs/16); a base view excludes it until the workspace is landed via avcs.workspace.land" },
        baseText: { type: "string", description: "the base content this edit was derived from; its presence routes to a 3-way-mergeable edit_file" },
        baseBlobOid: { type: "string", description: "oid of the base blob (alternative to baseText); fetch it via avcs.object.show" },
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
    handler: (repo, i) => {
      const common = {
        sessionOid: String(i.sessionOid),
        intentOid: String(i.intentOid),
        actor: actorOf(i),
        path: String(i.path),
        declaredPurpose: String(i.declaredPurpose),
        causalDeps: i.causalDeps as string[] | undefined,
        effects: i.effects as never,
        line: i.line as string | undefined,
        workspace: i.workspace as string | undefined,
      };
      // A declared base (baseText or baseBlobOid) authors a base-relative edit_file, which
      // 3-way line-merges with concurrent edits; otherwise a whole-file put_file (issue #20).
      if (i.baseText !== undefined || i.baseBlobOid !== undefined) {
        return repo.proposeEdit({
          ...common,
          newText: String(i.content),
          baseText: i.baseText as string | undefined,
          baseBlobOid: i.baseBlobOid as string | undefined,
        });
      }
      return repo.proposeFileWrite({ ...common, content: String(i.content) });
    },
  },
  {
    name: "avcs.workspace.land",
    description: "Land a workspace onto its base line (docs/16): its isolated ops join the base view and merge there via the normal 3-way reduce — disjoint edits auto-merge, overlaps surface as conflicts. Idempotent. Returns the current landed set.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    handler: async (repo, i) => {
      await repo.landWorkspace(String(i.name));
      return { landed: await repo.landedWorkspaces() };
    },
  },
  {
    name: "avcs.workspace.list",
    description: "List the workspaces that have landed onto their base line (docs/16). Un-landed workspaces stay isolated and are not reported here.",
    inputSchema: { type: "object", properties: {} },
    handler: async (repo) => ({ landed: await repo.landedWorkspaces() }),
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
        treeHash: { type: "string", description: "the materialized treeHash this evidence was produced against (docs/16); binds the result to a specific tree" },
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
        treeHash: i.treeHash as string | undefined,
      }),
  },
  {
    name: "avcs.view.materialize",
    description: "Reduce the operation graph for a view into a code tree + per-op status + open conflicts. This is how an agent checks whether its work merges. Pass includeStatuses (e.g. ['accepted','needs_decision']) to ALSO project gated/pending ops so their computed 3-way merge can be inspected before acceptance; `dropped` lists ops NOT in the tree (status outside includeStatuses) so omissions are never silent (issue #13).",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string" },
        includeStatuses: {
          type: "array",
          items: { type: "string", enum: ["proposed", "validating", "accepted", "rejected", "superseded", "needs_decision", "quarantined"] },
          description: "op statuses to project into the tree; default ['accepted']",
        },
      },
    },
    handler: async (repo, i) => {
      const include = i.includeStatuses as OperationStatus[] | undefined;
      const res = await repo.materialize((i.view as string) ?? "main", include ? { includeStatuses: include } : undefined);
      const status: Record<string, string> = {};
      for (const [oid, s] of res.statuses) status[oid] = s;
      // Surface what was NOT projected (status outside the include set) so a gated op is
      // never silently missing from the materialized tree (issue #13).
      const projected = new Set<string>(include ?? ["accepted"]);
      const dropped = Object.entries(status)
        .filter(([, s]) => !projected.has(s))
        .map(([oid, s]) => ({ oid, status: s }));
      return {
        treeHash: res.treeHash,
        files: [...res.tree.keys()].sort(),
        status,
        conflicts: res.conflicts,
        dropped,
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
    description: "Record a HUMAN/owner resolution of a conflict. Chosen ops are accepted, rejected ops dropped — and the rationale becomes reusable history. The agent CANNOT forge this: the owner is asked to confirm via MCP elicitation, and the decision is then signed with the owner's LOCAL private key (which the agent never holds). Unsigned/forged decisions are dropped by the reducer's trust gate (issue #15). Requires actor.kind 'human', an elicitation-capable client, and a provisioned local owner key.",
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
    handler: async (repo, i, ctx) => {
      const actor = actorOf(i);
      if (actor.kind !== "human") {
        throw new Error("avcs.decision.record requires a human actor; agents may not resolve their own conflicts");
      }
      // (issue #15) The decision must be cryptographically signed by the owner to be
      // trusted by the reducer. The agent never holds the key: (a) the owner's LOCAL
      // private key signs it, and (b) the owner explicitly confirms via elicitation —
      // so neither an agent nor a malicious client can fabricate an owner sign-off.
      const priv = await repo.loadLocalKey(actor.id);
      if (!priv) {
        throw new Error(`no local signing key for ${actor.id}; provision one (repo.provisionOwnerKey) so decisions can be signed and trusted (issue #15). Without it the trust gate drops the decision.`);
      }
      const elicit = ctx?.elicit;
      if (!elicit) {
        throw new Error("owner confirmation is required but this client does not support MCP elicitation; sign decisions via the avcs CLI, or use an elicitation-capable client");
      }
      const res = await elicit(
        `owner 승인 필요: 충돌 ${String(i.conflictId)} 을(를) chosenOps=${JSON.stringify((i.chosenOps as string[]) ?? [])}, rejectedOps=${JSON.stringify((i.rejectedOps as string[]) ?? [])} 로 기록하려 합니다. 본인(${actor.id})이 이 결정을 승인합니까?`,
        { type: "object", properties: { approve: { type: "boolean", description: "true to record this decision under your key" } }, required: ["approve"] },
      );
      if (res.action !== "accept" || res.content?.approve !== true) {
        throw new Error("owner declined the decision (elicitation not accepted); nothing recorded");
      }
      return repo.recordDecision({
        conflictId: String(i.conflictId),
        chosenOps: (i.chosenOps as string[]) ?? [],
        rejectedOps: (i.rejectedOps as string[]) ?? [],
        reason: String(i.reason),
        decidedBy: actor,
        futurePolicy: i.futurePolicy as string | undefined,
        signWith: { keyId: actor.id, privateKey: priv },
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
    description: "Run validation commands against a view and attach treeHash-bound Evidence (docs/16 §8). By default materializes into a fresh temp dir. Pass `dir` (e.g. your working tree, which already has the build env like node_modules) to run there without avcs owning install — the fix for Node/pnpm (issue #11); with `dir` it runs in place unless `project:true`. Use `workspace` to validate a workspace view. Evidence trusts author≠signer, so pass a ciActor distinct from the op authors.",
    inputSchema: {
      type: "object",
      properties: {
        ops: { type: "array", items: { type: "string" } },
        view: { type: "string" },
        workspace: { type: "string", description: "validate a workspace view (docs/16): base + that workspace's isolated ops" },
        dir: { type: "string", description: "directory to run checks in; defaults to a fresh isolated temp dir. Pass a dir that already holds the build env (e.g. the working tree) to avoid reinstalling (issue #11)" },
        project: { type: "boolean", description: "materialize the view into `dir` before running; defaults true for a temp dir, false when `dir` is given (run in place)" },
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
      const dir = i.dir as string | undefined;
      let workspaceDir = dir;
      if (!workspaceDir) {
        const { mkdtemp } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        workspaceDir = await mkdtemp(join(tmpdir(), "avcs-validate-"));
      }
      // A fresh temp dir is materialized into (project=true); a caller-supplied `dir` runs in
      // place by default (it already holds the tree + build env), unless project is forced.
      const project = i.project !== undefined ? (i.project as boolean) : !dir;
      return runChecks(repo, {
        ops: i.ops as string[],
        view: i.view as string | undefined,
        workspace: i.workspace as string | undefined,
        workspaceDir,
        project,
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
  {
    name: "avcs.object.show",
    description: "Read an object by oid — the MCP equivalent of CLI `show`. For a blob, returns the decoded content (utf8 `text`, or `base64` if binary); for an operation/intent/etc., the structured object. Lets a pure-MCP agent inspect another agent's authored content, or fetch a base blob to declare as baseBlobOid on an edit_file propose (issue #12).",
    inputSchema: { type: "object", properties: { oid: { type: "string" } }, required: ["oid"] },
    handler: async (repo, i) => {
      const oid = String(i.oid);
      const obj = await repo.store.get(oid);
      if ((obj as { type?: string }).type === "blob") {
        const buf = await repo.readBlob(oid);
        return isBinary(buf)
          ? { oid, kind: "blob", encoding: "base64", binary: true, bytes: buf.length, data: buf.toString("base64") }
          : { oid, kind: "blob", encoding: "utf8", binary: false, bytes: buf.length, text: buf.toString("utf8") };
      }
      return { oid, kind: (obj as { type?: string }).type ?? "object", object: obj };
    },
  },
];

/**
 * Boot the AVCS MCP server on stdio. This is the function the CLI's `avcs mcp`
 * subcommand and the direct entrypoint below both call. It loads the optional
 * `@modelcontextprotocol/sdk` lazily so importing this module (e.g. from tests, to
 * exercise the tool handlers) — and the rest of the CLI — never depends on the SDK.
 */
export async function startMcpServer(): Promise<void> {
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
        "          It ships as an optionalDependency; reinstall avcs (e.g. `npm i -g @izagood/avcs`)\n" +
        "          or run `npm i @modelcontextprotocol/sdk` in this package, then start again.\n" +
        "          Tool surface is defined in src/mcp/server.ts regardless.",
    );
    process.exit(1);
  }

  const bootVersion = readPackageVersion();
  const server = new sdk.Server({ name: "avcs", version: bootVersion ?? "0.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(typesMod.ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      // Advertise the universal optional `cwd` so per-call repo targeting is discoverable.
      inputSchema: {
        ...t.inputSchema,
        properties: { ...((t.inputSchema.properties as Record<string, unknown>) ?? {}), cwd: cwdSchema },
      },
    })),
  }));

  // Ask the MCP client for its workspace roots (the protocol-blessed way to learn where the
  // agent is working). Returns filesystem paths; empty when the client lacks the capability
  // or advertises none — callers fall back to cwd. Never throws.
  const clientRoots = async (): Promise<string[]> => {
    try {
      const res = (await server.listRoots()) as { roots?: Array<{ uri?: string }> };
      const out: string[] = [];
      for (const r of res.roots ?? []) {
        if (typeof r.uri !== "string") continue;
        try {
          out.push(r.uri.startsWith("file://") ? fileURLToPath(r.uri) : r.uri);
        } catch {
          /* skip non-file roots */
        }
      }
      return out;
    } catch {
      return []; // client did not declare the `roots` capability
    }
  };

  // One Repo instance per resolved repo dir, reused across tool calls so each repo's reduce
  // cache and metrics persist for the life of the server. A single server can serve several
  // repos (different workspaces) without rebuilding state on every call.
  const repos = new Map<string, Repo>();
  const openRepo = async (callCwd: string | undefined): Promise<Repo> => {
    const dir = await resolveRepoDir(callCwd, clientRoots);
    let repo = repos.get(dir);
    if (!repo) {
      repo = await Repo.open(dir);
      repos.set(dir, repo);
    }
    return repo;
  };
  // Count of tool calls currently executing. The reload watcher only exits when this
  // is zero, so an update never interrupts in-progress work — including a call parked
  // on a human elicitation prompt (the await keeps it counted as in-flight).
  let inFlight = 0;
  server.setRequestHandler(typesMod.CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) throw new Error(`unknown tool: ${req.params.name}`);
    const argsIn = (req.params.arguments ?? {}) as Record<string, unknown>;
    const callCwd = typeof argsIn.cwd === "string" ? argsIn.cwd : undefined;
    const repo = await openRepo(callCwd);
    inFlight++;
    const ctx: ToolCtx = {
      // Bridge to MCP elicitation; surface a friendly error if the client lacks support.
      elicit: async (message, requestedSchema) => {
        const elicitInput = (server as unknown as {
          elicitInput: (p: { message: string; requestedSchema: Record<string, unknown> }) => Promise<ElicitOutcome>;
        }).elicitInput;
        try {
          return await elicitInput({ message, requestedSchema });
        } catch (e) {
          throw new Error(`owner confirmation via MCP elicitation failed or is unsupported by this client (${(e as Error).message}); sign decisions via the avcs CLI, or use an elicitation-capable client`);
        }
      },
    };
    try {
      const result = await tool.handler(repo, argsIn, ctx);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } finally {
      inFlight--;
    }
  });

  // Reload-on-update: a long-lived stdio server holds the code it was spawned with, so
  // an `npm i -g @izagood/avcs@latest` (or any update) does not reach a running process.
  // We can't hot-swap the loaded module, so instead we watch the installed package
  // version and, once it differs from what we booted with AND no tool call is in flight,
  // exit cleanly so the MCP client respawns us on the new code. Set the interval to 0 to
  // disable. `unref()` keeps the timer from holding the process alive on its own.
  const reloadCheckMs = Number(process.env.AVCS_MCP_RELOAD_CHECK_MS ?? "10000");
  if (bootVersion && Number.isFinite(reloadCheckMs) && reloadCheckMs > 0) {
    const watcher = setInterval(() => {
      if (inFlight > 0) return;
      const current = readPackageVersion();
      if (!current || current === bootVersion) return;
      clearInterval(watcher);
      console.error(
        `[avcs-mcp] installed version changed ${bootVersion} -> ${current}; no calls in flight, ` +
          `exiting so the MCP client respawns on the new code.`,
      );
      server.close().catch(() => {}).finally(() => process.exit(0));
    }, reloadCheckMs);
    watcher.unref?.();
  }

  await server.connect(new stdio.StdioServerTransport());
  const target = ENV_REPO
    ? `repo ${ENV_REPO} (pinned via AVCS_REPO)`
    : "repo per call (cwd arg → client roots → server cwd)";
  console.error(
    `[avcs-mcp] serving ${target} over stdio (${TOOLS.length} tools)` +
      (bootVersion ? `, avcs v${bootVersion}` : ""),
  );
}

// Only start the stdio server when run as the entry point — importing this module
// (e.g. from tests, or the CLI dispatching `avcs mcp`) must not boot the server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
