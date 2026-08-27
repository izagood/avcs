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
import { serializeResult, errorEnvelope, boundedLimit } from "./respond.ts";
import { unifiedDiff } from "../query/diff.ts";
import { buildGuide } from "./guide.ts";
import { land } from "./land.ts";
import { buildContextPack } from "./context.ts";
import { RESOURCES, readResource } from "./resources.ts";
import { PROMPTS, buildPrompt } from "./prompts.ts";
import { RepoWatcher, watchIntervalMs } from "./watch.ts";

/** The hub's governance refs (`head:<view>`, policy, …). Empty when unreachable — a head
 *  comparison is informational, so a dead hub degrades the answer instead of failing it. */
async function fetchHubRefs(url: string): Promise<Record<string, string>> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/refs`);
    if (!res.ok) return {};
    return ((await res.json()) as { refs?: Record<string, string> }).refs ?? {};
  } catch {
    return {};
  }
}
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

/**
 * Watch for the installed package version drifting away from the one this process booted
 * with, and report it ONCE when no call is in flight. Dependencies are injected so the
 * decision is testable without mutating a real package.json.
 *
 * Returns null when watching is disabled (no boot version, or a non-positive/NaN interval).
 */
/**
 * Append the stale-server notice to an error message. A server running older code fails in
 * ways that point at the wrong culprit — it cannot read a newer on-disk layout and says
 * "not an AVCS repo" about a directory the upgraded CLI reads fine. Naming the real cause
 * on the error itself is what turns that from an hour of debugging into a reconnect.
 */
export function appendStaleNote(message: string, notice: string | null): string {
  return notice ? `${message}\n\nnote: ${notice}` : message;
}

export function watchVersionDrift(opts: {
  bootVersion: string | null;
  readVersion: () => string | null;
  intervalMs: number;
  isBusy: () => boolean;
  onDrift: (from: string, to: string) => void;
}): { stop: () => void } | null {
  const { bootVersion, readVersion, intervalMs, isBusy, onDrift } = opts;
  if (!bootVersion || !Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  const timer = setInterval(() => {
    if (isBusy()) return; // never interrupt work in progress; check again next tick
    const current = readVersion();
    // A null read means "couldn't tell" — the package directory is mid-replacement during an
    // upgrade — not "changed". Treating it as drift would fire a bogus notice every upgrade.
    if (!current || current === bootVersion) return;
    clearInterval(timer); // say it once; repeating every interval is noise, not information
    onDrift(bootVersion, current);
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

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

/** Universal formatting switch (Phase 16 M1.1). Responses are compact by default because
 *  indentation is whitespace the agent pays for on every call; this restores pretty-print
 *  for the times a human is reading. Consumed by the dispatch layer, never by a handler. */
const verboseSchema = {
  type: "boolean",
  description: "Pretty-print the response for human reading. Default false (compact, fewer tokens).",
};

/**
 * The `core` profile (Phase 16 M5, docs/18 §M5): the tools the canonical loop actually
 * uses. A tool schema is a toll every agent pays every session, and 36 tools is mostly
 * noise for an agent doing the standard loop.
 *
 * What is deliberately ABSENT: checkpoint.create, sync.push and integration.submit, because
 * `sync.land` performs all three internally. Advertising them in the small profile would
 * re-teach the checkpoint dance M2 exists to remove. A test asserts the whole canonical
 * loop fits inside this list, so "small" can never mean "cannot finish the work".
 */
export const CORE_PROFILE: string[] = [
  "avcs.guide",
  "avcs.intent.read",
  "avcs.intent.list",
  "avcs.session.start",
  "avcs.context.build",
  "avcs.lease.request",
  "avcs.operation.propose",
  "avcs.evidence.attach",
  "avcs.validate.run",
  "avcs.repair.context",
  "avcs.view.materialize",
  "avcs.conflict.list",
  "avcs.sync.land",
];

/**
 * Tools to advertise for a profile name. The DEFAULT is everything — a profile is opt-in,
 * because silently hiding tools from an existing client would break it. An unrecognized
 * name degrades to the full set rather than to an empty one: a typo should cost tokens,
 * not capability.
 */
export function toolsForProfile(profile: string | undefined): ToolDef[] {
  if (profile !== "core") return TOOLS;
  const core = new Set(CORE_PROFILE);
  return TOOLS.filter((t) => core.has(t.name));
}

/** The schema advertised to clients: the tool's own inputs plus the universal `cwd` and
 *  `verbose`. Returns a fresh object — the ToolDef's own schema is never mutated. */
export function advertisedSchema(t: ToolDef): Record<string, unknown> {
  return {
    ...t.inputSchema,
    properties: {
      ...((t.inputSchema.properties as Record<string, unknown>) ?? {}),
      cwd: cwdSchema,
      verbose: verboseSchema,
    },
  };
}

/**
 * Run one tool call and render it for the transport (Phase 16 M1.1, docs/18 §1.1).
 * Exported so the layer is testable without booting the SDK, the same way the handlers are.
 *
 * Success keeps its raw shape — only the serialization changes (§2 principle 1). Failure
 * becomes `{ error, hint?, nextActions? }` so the agent recovers from a list instead of
 * parsing prose; it is returned with `isError`, not thrown, because a thrown error reaches
 * the agent as an opaque transport failure and loses the recovery hints entirely.
 */
export async function runTool(
  tool: ToolDef,
  repo: Repo,
  args: Record<string, unknown>,
  ctx?: ToolCtx,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const verbose = args.verbose === true;
  try {
    const result = await tool.handler(repo, args, ctx);
    return { content: [{ type: "text", text: serializeResult(result, { verbose }) }] };
  } catch (e) {
    return { content: [{ type: "text", text: serializeResult(errorEnvelope(e), { verbose }) }], isError: true };
  }
}

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
      "If this is a linked working tree, run `avcs worktree attach` in it to point at the main " +
      "checkout's store. Otherwise pass `cwd` to the tool, register the server with AVCS_REPO " +
      "(`avcs mcp install --repo <dir>`), or run `avcs init`.",
  );
}

export const TOOLS: ToolDef[] = [
  {
    // First in the list on purpose: it is the tool that explains the rest.
    name: "avcs.guide",
    description: "How to use AVCS: the canonical loop, agent rules, tool index, error recovery. Call this first.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: ["workflow", "tools", "sync", "rules", "errors"],
          description: "omit for the canonical loop",
        },
      },
    },
    handler: async (_repo, i) => buildGuide(TOOLS, typeof i.topic === "string" ? i.topic : undefined),
  },
  {
    // ── M4 governance/review subset (docs/18 §4.4) ──
    name: "avcs.governance.status",
    description: "Read-only review state for a view: protection rules, head, your role, and the effective approvals.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", description: "default 'main'" },
        as: { type: "string", description: "actor id whose role to report" },
        checkpointOid: { type: "string", description: "report approvals for this checkpoint instead of the head" },
      },
    },
    handler: async (repo, i) => {
      const view = (i.view as string) ?? "main";
      const [protection, head] = await Promise.all([repo.getProtection(view), repo.protectedHead(view)]);
      const me = (i.as as string) ?? (await repo.localActorId());
      const target = (i.checkpointOid as string) ?? head;
      return {
        view,
        protection,
        head,
        myRole: me ? await repo.roleOf(me) : null,
        approvals: target ? await repo.approvalsFor(target) : [],
      };
    },
  },
  {
    name: "avcs.approval.record",
    description: "Record a reviewer verdict on a checkpoint, signed with the reviewer's local key. Requires role >= reviewer.",
    inputSchema: {
      type: "object",
      properties: {
        checkpointOid: { type: "string" },
        verdict: { type: "string", enum: ["approve", "request_changes"] },
        by: { type: "string", description: "reviewer actor id" },
        reason: { type: "string" },
      },
      required: ["checkpointOid", "by"],
    },
    // No human elicitation gate here, unlike decision.record: an approval is already gated
    // downstream by role and signature, so a reviewer bot holding a key is the intended user.
    handler: async (repo, i) =>
      repo.approve(
        String(i.checkpointOid),
        String(i.by),
        (i.verdict as "approve" | "request_changes") ?? "approve",
        typeof i.reason === "string" ? { reason: i.reason } : {},
      ),
  },
  {
    // ── M3 ContextPack (docs/18 §M3) ──
    name: "avcs.context.build",
    description: "Assemble working context for a scope under a byte budget: provenance, decisions, risks, history. Deterministic truncation.",
    inputSchema: {
      type: "object",
      properties: {
        intentOid: { type: "string", description: "scope = the intent's allowed scopes plus what its sessions actually touched" },
        entityKeys: { type: "array", items: { type: "string" }, description: "explicit keys, e.g. ['file:src/a.ts']" },
        paths: { type: "array", items: { type: "string" }, description: "file paths, resolved to file: keys" },
        view: { type: "string", description: "default 'main'" },
        maxBytes: { type: "number", description: "budget for the compact response; default 8192. Dropped sections are listed in budget.truncated." },
      },
    },
    handler: (repo, i) =>
      buildContextPack(repo, {
        intentOid: i.intentOid as string | undefined,
        entityKeys: i.entityKeys as string[] | undefined,
        paths: i.paths as string[] | undefined,
        view: i.view as string | undefined,
        maxBytes: i.maxBytes as number | undefined,
      }),
  },
  {
    name: "avcs.decision.recall",
    description: "Prior human decisions for a conflict key plus the policies they taught. Read precedent before re-deciding.",
    inputSchema: {
      type: "object",
      properties: { conflictKey: { type: "string", description: "entity key, e.g. 'file:src/a.ts'" } },
    },
    handler: async (repo, i) => ({
      decisions: typeof i.conflictKey === "string" ? await repo.recallDecisions(i.conflictKey) : [],
      policies: await repo.learnedPolicies(),
    }),
  },
  {
    // ── M2 sync surface (docs/18 §M2): an agent never pulls by hand ──
    name: "avcs.sync.pull",
    description: "Pull objects from the hub (conflict-free gossip). dryRun reports what would arrive without importing.",
    inputSchema: {
      type: "object",
      properties: {
        hub: { type: "string", description: "remote name or hub URL; default the persisted 'origin'" },
        dryRun: { type: "boolean", description: "report the would-pull count and head comparison, import nothing" },
      },
    },
    handler: async (repo, i) => {
      const remote = typeof i.hub === "string" ? i.hub : "origin";
      const url = await repo.remoteUrl(remote);
      const hubRefs = await fetchHubRefs(url);
      const view = "main";
      const hubHead = hubRefs[`head:${view}`] ?? null;
      if (i.dryRun === true) {
        // Count what the hub holds and we lack, without importing any of it.
        const have = (await (await fetch(`${url}/have`)).json()) as string[];
        let missing = 0;
        for (const oid of have) if (!(await repo.store.has(oid))) missing++;
        const local = await repo.protectedHead(view);
        return { pulled: missing, dryRun: true, head: { local, hub: hubHead }, converged: local === hubHead };
      }
      const { pulled } = await repo.pullHub(url);
      const local = await repo.protectedHead(view);
      return { pulled, head: { local, hub: hubHead }, converged: local === hubHead };
    },
  },
  {
    name: "avcs.sync.push",
    description: "Push local objects to the hub. Returns how many were accepted and how many the gate rejected.",
    inputSchema: {
      type: "object",
      properties: {
        hub: { type: "string", description: "remote name or hub URL; default the persisted 'origin'" },
        as: { type: "string", description: "actor id whose key signs the writes" },
      },
    },
    handler: async (repo, i) => {
      const url = await repo.remoteUrl(typeof i.hub === "string" ? i.hub : "origin");
      return repo.pushHub(url, typeof i.as === "string" ? { as: i.as } : undefined);
    },
  },
  {
    name: "avcs.sync.land",
    description: "Land work on a protected head in one call: push, merge-check, checkpoint, integrate. Result is landed or a conflict packet.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", description: "default 'main'" },
        summary: { type: "string", description: "checkpoint summary" },
        by: { type: "string", description: "actor id landing the work" },
        hub: { type: "string", description: "remote name or hub URL; omit for the persisted 'origin', or a local-only repo" },
        maxAttempts: { type: "number", description: "bounded contention retries; default 5. Conflicts are never retried." },
        workspace: { type: "string", description: "land this workspace onto the base line first" },
      },
      required: ["by"],
    },
    handler: (repo, i) =>
      land(repo, {
        view: i.view as string | undefined,
        summary: i.summary as string | undefined,
        by: String(i.by),
        hub: i.hub as string | undefined,
        maxAttempts: i.maxAttempts as number | undefined,
        workspace: i.workspace as string | undefined,
      }),
  },
  {
    name: "avcs.workspace.project",
    description: "Write a view to a directory on disk, so build/test loops outside validate.run need no CLI.",
    inputSchema: {
      type: "object",
      properties: {
        out: { type: "string", description: "absolute target directory" },
        view: { type: "string", description: "default 'main'" },
        name: { type: "string", description: "project this workspace's isolated ops too" },
      },
      required: ["out"],
    },
    handler: async (repo, i) => {
      const view = (i.view as string) ?? "main";
      const workspace = typeof i.name === "string" ? i.name : undefined;
      const projected = await repo.projectInto(String(i.out), view, workspace ? { workspace } : undefined);
      const res = await repo.materialize(view, workspace ? { workspace } : undefined);
      // Shared build environments (docs/21). An agent about to build needs exactly one fact
      // the core can supply — is the cache empty? — and the core supplies only that. It never
      // learns to run the install itself (docs/21 §2 principle 2).
      const shared = projected.shared.map((s) => ({
        path: s.path, key: s.key, cache: s.cache, mode: s.mode, linked: s.linked, populated: s.populated,
        ...(s.warning ? { warning: s.warning } : {}),
      }));
      return {
        dir: String(i.out), fileCount: projected.written.length, treeHash: res.treeHash,
        ...(shared.length ? { shared } : {}),
        ...(projected.skipped.length ? { skippedInSharedPaths: projected.skipped.length } : {}),
      };
    },
  },
  {
    // ── keys (issue #51): signing must be reachable without writing a script ──
    name: "avcs.key.provision",
    description: "Mint a local signing key for an actor so its decisions and hub writes can be signed. Idempotent.",
    inputSchema: {
      type: "object",
      properties: { actor: actorSchema },
      required: ["actor"],
    },
    // Idempotent by design: re-minting would orphan the previous key while signatures made
    // with it stay in history, so an actor who provisions twice must not lose their identity.
    handler: async (repo, i) => repo.ensureOwnerKey(actorOf(i)),
  },
  {
    name: "avcs.key.list",
    description: "Which actors this machine can sign as, and which public keys the repo trusts. Ids only, never key material.",
    inputSchema: { type: "object", properties: {} },
    handler: async (repo) => ({
      local: await repo.listLocalKeys(),
      trusted: await repo.listTrustedKeys(),
    }),
  },
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
    description: "List intents in the repo. Bounded: limit (default 50).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "max intents to return; default 50" } },
    },
    handler: async (repo, i) => (await repo.listIntents()).slice(0, boundedLimit(i.limit, 50)),
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
    description: "Propose a semantic change (MVP: file writes). Declare effects honestly — policy gates on them. baseText/baseBlobOid authors a 3-way-mergeable edit_file.",
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
        warnContention: { type: "boolean", description: "also run an early conflict check on the op's keys (Phase 15.3): response becomes { oid, contentionWarnings } listing other actors' live concurrent ops + overlapping lease holders. Omit for the plain oid response." },
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
    handler: async (repo, i) => {
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
      const oid = i.baseText !== undefined || i.baseBlobOid !== undefined
        ? await repo.proposeEdit({
            ...common,
            newText: String(i.content),
            baseText: i.baseText as string | undefined,
            baseBlobOid: i.baseBlobOid as string | undefined,
          })
        : await repo.proposeFileWrite({ ...common, content: String(i.content) });
      // Phase 15.3 (additive, opt-in): the response shape stays a plain oid unless the
      // caller asked for the early-warning check.
      if (i.warnContention === true) {
        const contentionWarnings = await repo.contention({ keys: [`file:${String(i.path)}`], actorId: common.actor.id, line: common.line });
        return { oid, contentionWarnings };
      }
      return oid;
    },
  },
  {
    name: "avcs.contention.check",
    description: "Other actors' live concurrent ops and overlapping lease holders for given keys. Run while editing, so overlap surfaces before finalize.",
    inputSchema: {
      type: "object",
      properties: {
        keys: { type: "array", items: { type: "string" }, description: "entity keys to check, e.g. [\"file:src/a.ts\"]" },
        sessionOid: { type: "string", description: "use this session's actor + authored keys as the perspective" },
        actor: { type: "string", description: "actor id for the perspective (with no keys: every key they authored on)" },
        line: { type: "string", description: "lineage to check on; default 'main'" },
        acrossLines: { type: "boolean", description: "also check other lines/branches; each warning names the competing line" },
      },
    },
    handler: (repo, i) =>
      repo.contention({
        keys: i.keys as string[] | undefined,
        sessionOid: i.sessionOid as string | undefined,
        actorId: i.actor as string | undefined,
        line: i.line as string | undefined,
        acrossLines: i.acrossLines as boolean | undefined,
      }),
  },
  {
    name: "avcs.workspace.land",
    description: "Land a workspace onto its base line: its isolated ops join the base view and merge there. Idempotent.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    handler: async (repo, i) => {
      await repo.landWorkspace(String(i.name));
      return { landed: await repo.landedWorkspaces() };
    },
  },
  {
    name: "avcs.workspace.list",
    description: "List this repo's workspaces: `workspaces` names them all, `landed` the subset joined onto the base view. The rest stay isolated.",
    inputSchema: { type: "object", properties: {} },
    handler: async (repo) => ({ landed: await repo.landedWorkspaces(), workspaces: await repo.workspaceNames() }),
  },
  {
    name: "avcs.line.create",
    description: "Fork a long-lived line (e.g. 'v1.x') from another at its current state. It inherits history to the fork, then diverges.",
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
    description: "Cherry-pick an operation onto another line: mints a new op carrying the change, with derivedFrom provenance. Source line untouched.",
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
    description: "Reduce a view's operation graph into a tree, per-op status and open conflicts — how an agent checks that its work merges.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string" },
        includeStatuses: {
          type: "array",
          items: { type: "string", enum: ["proposed", "validating", "accepted", "rejected", "superseded", "needs_decision", "quarantined"] },
          description: "op statuses to project into the tree; default ['accepted']",
        },
        filesLimit: { type: "number", description: "max paths to list; default 500. treeHash/status/conflicts/dropped are never bounded." },
        pathsOnlyUnder: { type: "string", description: "list only paths under this prefix (e.g. 'src/')" },
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
      // Only the FILE LISTING is bounded (Phase 16 M1.2). treeHash, status, conflicts and
      // dropped are correctness data — bounding them would make a wrong answer look right.
      const under = typeof i.pathsOnlyUnder === "string" ? i.pathsOnlyUnder : undefined;
      const all = [...res.tree.keys()].sort().filter((p) => (under ? p.startsWith(under) : true));
      const filesLimit = boundedLimit(i.filesLimit, 500);
      return {
        treeHash: res.treeHash,
        files: all.slice(0, filesLimit),
        filesTotal: all.length,
        filesTruncated: all.length > filesLimit,
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
    description: "Record a human owner's conflict resolution. Owner-confirmed and signed with their local key; an agent cannot forge it.",
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
    name: "avcs.integration.submit",
    description:
      "Submit a checkpoint to the integration queue. Verdict is advanced, conflict, needs_evidence or queued — never 'pull and redo'.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", description: "default 'main'" },
        remote: { type: "string", description: "remote name or hub url; default 'origin'" },
        checkpoint: { type: "string", description: "draft checkpoint oid; created from the view when omitted" },
        message: { type: "string", description: "checkpoint summary when auto-creating" },
        actor: actorSchema,
        ticketId: { type: "string", description: "resubmission: reuse the ticketId from the needs_evidence verdict" },
      },
      required: ["actor"],
    },
    handler: async (repo, i) => {
      const view = (i.view as string) ?? "main";
      const checkpoint = (i.checkpoint as string | undefined) ?? (await repo.createCheckpoint(view, (i.message as string) ?? `submit ${view}`));
      return repo.integrateHub((i.remote as string) ?? "origin", { view, checkpoint, by: actorOf(i).id, ticketId: i.ticketId as string | undefined });
    },
  },
  {
    name: "avcs.integration.status",
    description: "Idempotent lookup of an integration ticket's recorded verdict on a remote hub (polling companion to avcs.integration.submit).",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string" },
        view: { type: "string", description: "default 'main'" },
        remote: { type: "string", description: "remote name or hub url; default 'origin'" },
      },
      required: ["ticketId"],
    },
    handler: async (repo, i) => {
      const url = await repo.remoteUrl((i.remote as string) ?? "origin");
      const res = await fetch(`${url}/integrations/${encodeURIComponent(String(i.ticketId))}?view=${encodeURIComponent((i.view as string) ?? "main")}`);
      return res.json();
    },
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
    description: "Run validation commands against a view and attach treeHash-bound evidence. Pass dir to reuse an existing build environment.",
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
    description: "Minimal repair packet for ops whose validation failed: failing output, related decisions, a fix instruction. Cheaper than re-reading the repo.",
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
    name: "avcs.blame.lines",
    description: "Per-line provenance: the op that last wrote each line, with actor, intent and purpose. Why THIS line is here.",
    inputSchema: { type: "object", properties: { entityKey: { type: "string" }, path: { type: "string" }, line: { type: "string" } }, required: ["entityKey", "path"] },
    handler: (repo, i) => repo.blameLines(String(i.entityKey), String(i.path), (i.line as string) ?? "main"),
  },
  {
    name: "avcs.history",
    description: "History of one entity in causal order. Paged: limit (default 20) + cursor.",
    inputSchema: {
      type: "object",
      properties: {
        entityKey: { type: "string" },
        limit: { type: "number", description: "max ops to return; default 20. A full page means there may be more." },
        cursor: { type: "string", description: "opaque: the last op oid of the previous page; returns what follows it." },
      },
      required: ["entityKey"],
    },
    // Stays an ARRAY: success shapes are never wrapped (docs/18 §2 principle 1, §5), so the
    // page-size signal is the standard "short page = end" rather than an added total field.
    handler: async (repo, i) => {
      const all = await repo.historyOf(String(i.entityKey));
      const from = i.cursor ? all.findIndex((o) => o.oid === i.cursor) + 1 : 0;
      const limit = boundedLimit(i.limit, 20);
      return all.slice(from, from + limit).map((o) => ({ op: o.oid, actor: o.actor.id, purpose: o.declaredPurpose, at: o.createdAt, line: o.line ?? "main" }));
    },
  },
  {
    name: "avcs.diff",
    description: "Diff two views/lines. format 'paths' (default) or 'patch' (unified diff).",
    inputSchema: {
      type: "object",
      properties: {
        viewA: { type: "string" },
        viewB: { type: "string" },
        format: { type: "string", enum: ["paths", "patch"], description: "'paths' (default, unchanged shape) or 'patch' for unified diffs" },
        path: { type: "string", description: "restrict a patch to this single path" },
      },
      required: ["viewA", "viewB"],
    },
    handler: async (repo, i) => {
      const paths = await repo.diff(String(i.viewA), String(i.viewB));
      if (i.format !== "patch") return paths; // default shape is unchanged (compatibility)
      const [a, b] = await Promise.all([repo.materialize(String(i.viewA)), repo.materialize(String(i.viewB))]);
      const only = typeof i.path === "string" ? i.path : undefined;
      const changed = [...paths.added, ...paths.removed, ...paths.modified].sort().filter((p) => (only ? p === only : true));
      // Go through materializedFiles, NOT readBlob: a merged path's tree entry can be a
      // synth oid derived from the merge result, which was never stored as a blob.
      const [fa, fb] = await Promise.all([repo.materializedFiles(a), repo.materializedFiles(b)]);
      const textOf = (files: { path: string; content: string }[], p: string): string =>
        files.find((f) => f.path === p)?.content ?? "";
      const patches = changed.map((p) => ({ path: p, patch: unifiedDiff(textOf(fa, p), textOf(fb, p)) }));
      return { ...paths, patches };
    },
  },
  {
    name: "avcs.release.cut",
    description: "Cut a release: a conflict-free checkpoint plus evidence, SBOM and artifact references. Refuses if the view has open conflicts.",
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
    description: "Read an object by oid. Blobs return decoded content (utf8 text or base64); other types return the structured object.",
    inputSchema: {
      type: "object",
      properties: {
        oid: { type: "string" },
        maxBytes: { type: "number", description: "cap on returned blob content; default 65536. `bytes` always reports the FULL size." },
        lines: {
          type: "object",
          properties: { start: { type: "number" }, end: { type: "number" } },
          description: "1-based inclusive line range of a text blob to return instead of the whole thing",
        },
      },
      required: ["oid"],
    },
    handler: async (repo, i) => {
      const oid = String(i.oid);
      const obj = await repo.store.get(oid);
      if ((obj as { type?: string }).type === "blob") {
        const buf = await repo.readBlob(oid);
        const bytes = buf.length; // ALWAYS the full size, even when the payload is a slice
        if (isBinary(buf)) {
          const maxBytes = boundedLimit(i.maxBytes, 65_536);
          const slice = buf.subarray(0, maxBytes);
          return { oid, kind: "blob", encoding: "base64", binary: true, bytes, truncated: bytes > maxBytes, data: slice.toString("base64") };
        }
        let text = buf.toString("utf8");
        let truncated = false;
        // A line range is the cheaper ask: slice first, then still honour maxBytes.
        const range = i.lines as { start?: number; end?: number } | undefined;
        if (range && (range.start !== undefined || range.end !== undefined)) {
          const all = text.split("\n");
          const trailing = text.endsWith("\n");
          const body = trailing ? all.slice(0, -1) : all;
          const start = Math.max(1, Math.floor(range.start ?? 1));
          const end = Math.min(body.length, Math.floor(range.end ?? body.length));
          const picked = body.slice(start - 1, end);
          truncated = picked.length < body.length;
          text = picked.length ? picked.join("\n") + "\n" : "";
        }
        const maxBytes = boundedLimit(i.maxBytes, 65_536);
        if (Buffer.byteLength(text, "utf8") > maxBytes) {
          text = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
          truncated = true;
        }
        return { oid, kind: "blob", encoding: "utf8", binary: false, bytes, truncated, text };
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
export async function startMcpServer(opts: { profile?: string } = {}): Promise<void> {
  // `core` trims the advertised menu to the canonical loop (docs/18 §M5). CLI flag wins
  // over the env var so a single client can opt in without changing the whole environment.
  const profile = opts.profile ?? process.env.AVCS_MCP_PROFILE;
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
  // Phase 16 M4: resources are advertised as subscribable so a client can be TOLD the head
  // moved instead of polling for it; prompts carry their facts pre-inlined.
  const server = new sdk.Server(
    { name: "avcs", version: bootVersion ?? "0.0.0" },
    // `logging` is not decoration: the SDK refuses to send `notifications/message` unless it
    // is declared (`assertNotificationCapability`), and every such send here is wrapped in a
    // `.catch(() => {})`. Omitting it silently dropped every watch event and every notice —
    // the code looked like it was reporting and nothing ever arrived.
    { capabilities: { tools: {}, resources: { subscribe: true }, prompts: {}, logging: {} } },
  );

  // M5: the advertised SET is profile-controlled, but every registered tool stays callable —
  // a profile trims the menu, it does not remove capability from a client that knows the name.
  const advertised = toolsForProfile(profile);
  server.setRequestHandler(typesMod.ListToolsRequestSchema, async () => ({
    tools: advertised.map((t) => ({
      name: t.name,
      description: t.description,
      // Advertise the universal optional `cwd` and `verbose` so both are discoverable.
      inputSchema: advertisedSchema(t),
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
  // Set once the installed version drifts past ours; appended to errors so a stale server's
  // failures name their own cause instead of looking like a fault in the caller's repo.
  let staleNotice: string | null = null;
  server.setRequestHandler(typesMod.CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) throw new Error(`unknown tool: ${req.params.name}`);
    const argsIn = (req.params.arguments ?? {}) as Record<string, unknown>;
    const callCwd = typeof argsIn.cwd === "string" ? argsIn.cwd : undefined;
    let repo: Repo;
    try {
      repo = await openRepo(callCwd);
    } catch (e) {
      // Repo resolution runs before the tool does, so its failures never reach the tool's
      // error envelope — they surface as a bare transport error. That is exactly the failure
      // a stale server produces, so it is exactly where the notice has to land.
      (e as Error).message = appendStaleNote((e as Error).message, staleNotice);
      throw e;
    }
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
      const out = await runTool(tool, repo, argsIn, ctx);
      // Phase 16 M4.3: what this client authored on IS the hot set worth interrupting it
      // for. A stdio server is one process per client, so this scope is exactly right.
      if (!out.isError && tool.name === "avcs.operation.propose" && typeof argsIn.path === "string") {
        watchers.get(await resolveRepoDir(callCwd, clientRoots))?.trackKeys([`file:${argsIn.path}`]);
      }
      if (out.isError && staleNotice) out.content.push({ type: "text", text: `note: ${staleNotice}` });
      return out;
    } finally {
      inFlight--;
    }
  });

  // ── M4.1/4.2: resources (subscribable) and prompts ──
  server.setRequestHandler(typesMod.ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
  server.setRequestHandler(typesMod.ReadResourceRequestSchema, async (req: { params: { uri: string } }) => {
    const repo = await openRepo(undefined);
    return { contents: [{ uri: req.params.uri, mimeType: "application/json", text: await readResource(repo, req.params.uri, TOOLS) }] };
  });
  server.setRequestHandler(typesMod.ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
  server.setRequestHandler(typesMod.GetPromptRequestSchema, async (req: { params: { name: string; arguments?: Record<string, unknown> } }) => {
    const repo = await openRepo(undefined);
    const text = await buildPrompt(repo, req.params.name, req.params.arguments ?? {}, TOOLS);
    return { messages: [{ role: "user", content: { type: "text", text } }] };
  });

  // ── M4.3: local watcher → notifications ──
  // Polling is the correctness path (fs.watch drops events per-platform, and a missed head
  // advance is the failure this prevents). Set AVCS_MCP_WATCH_MS=0 to disable.
  const watchers = new Map<string, RepoWatcher>();
  const watchMs = watchIntervalMs();
  if (watchMs > 0) {
    const tick = setInterval(() => {
      void (async () => {
        for (const [dir, repo] of repos) {
          let w = watchers.get(dir);
          if (!w) {
            w = new RepoWatcher(repo);
            watchers.set(dir, w);
          }
          for (const ev of await w.poll()) {
            // Subscribed clients get the resource-updated signal; everyone else still sees
            // the event as a log message, so a client without subscriptions is not blind.
            const uri = ev.type === "head-advanced" ? `avcs://view/${ev.view}/head`
              : ev.type === "conflict-opened" ? `avcs://view/main/conflicts`
              : null;
            if (uri) server.notification({ method: "notifications/resources/updated", params: { uri } }).catch(() => {});
            server.notification({ method: "notifications/message", params: { level: "info", logger: "avcs", data: ev } }).catch(() => {});
          }
        }
      })();
    }, watchMs);
    tick.unref?.();
  }

  // Update-in-place: a long-lived stdio server holds the code it was spawned with, so
  // `npm i -g @izagood/avcs@latest` never reaches a running process. We cannot hot-swap the
  // loaded module, so the only question is what to do once we notice.
  //
  // Exiting is right ONLY if the client respawns us. The common client, Claude Code, does
  // not: it marks the server disconnected and waits for a manual `/mcp`. Exiting there strips
  // every AVCS tool out of a live session with no visible cause — worse than serving code one
  // version behind, which still works. So the default is to SAY so and keep serving, and the
  // notice is also appended to later errors, because a stale server's failures are otherwise
  // baffling: an old server that cannot read a newer on-disk layout reports "not an AVCS
  // repo" while the freshly-upgraded CLI reads the very same directory fine.
  //
  // Clients that DO respawn get the old behaviour with AVCS_MCP_RELOAD=exit.
  // AVCS_MCP_RELOAD_CHECK_MS=0 turns the check off entirely.
  const reloadCheckMs = Number(process.env.AVCS_MCP_RELOAD_CHECK_MS ?? "10000");
  const exitOnDrift = process.env.AVCS_MCP_RELOAD === "exit";
  watchVersionDrift({
    bootVersion,
    readVersion: readPackageVersion,
    intervalMs: reloadCheckMs,
    isBusy: () => inFlight > 0,
    onDrift: (from, to) => {
      const advice =
        `avcs was updated ${from} -> ${to}, but this MCP server is still running ${from}. ` +
        `Reconnect it to pick up the new version (in Claude Code: /mcp).`;
      staleNotice = advice;
      console.error(`[avcs-mcp] ${advice}`);
      if (exitOnDrift) {
        console.error("[avcs-mcp] AVCS_MCP_RELOAD=exit — exiting so the client respawns us.");
        server.close().catch(() => {}).finally(() => process.exit(0));
        return;
      }
      // Surface it where a human actually looks. Best-effort: a client that drops
      // notifications still gets the hint appended to any subsequent error.
      server
        .notification({ method: "notifications/message", params: { level: "warning", logger: "avcs", data: advice } })
        .catch(() => {});
    },
  });

  await server.connect(new stdio.StdioServerTransport());
  const target = ENV_REPO
    ? `repo ${ENV_REPO} (pinned via AVCS_REPO)`
    : "repo per call (cwd arg → client roots → server cwd)";
  console.error(
    `[avcs-mcp] serving ${target} over stdio (${advertised.length}/${TOOLS.length} tools${profile === "core" ? ", profile=core" : ""})` +
      (bootVersion ? `, avcs v${bootVersion}` : ""),
  );
}

// Only start the stdio server when run as the entry point — importing this module
// (e.g. from tests, or the CLI dispatching `avcs mcp`) must not boot the server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const profileArg = process.argv.indexOf("--profile");
  startMcpServer({ profile: profileArg >= 0 ? process.argv[profileArg + 1] : undefined }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
