// High-level repository facade.
//
// This is the single API surface that the CLI, the demo, and the MCP server all
// call. It hides the object store and reducer behind verbs that map 1:1 onto the
// agent workflow: intent → session → propose op → attach evidence → materialize →
// decide → checkpoint.

import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { Buffer } from "node:buffer";
import { ObjectStore } from "../store/objectStore.ts";
import { LamportClock } from "../core/clock.ts";
import { reduce, type ReductionResult } from "../reducer/reducer.ts";
import { defaultPolicy, MATERIALIZER_VERSION } from "../reducer/policy.ts";
import type {
  Actor,
  Blob,
  Checkpoint,
  Decision,
  Evidence,
  EvidenceKind,
  EvidenceResult,
  Intent,
  IntentKind,
  Operation,
  OperationBody,
  OperationTarget,
  Policy,
  ScopeRef,
  Session,
  View,
  ViewQuery,
} from "../objects/types.ts";

export class Repo {
  readonly dir: string;
  readonly store: ObjectStore;
  #clock = new LamportClock();

  private constructor(dir: string, store: ObjectStore) {
    this.dir = dir;
    this.store = store;
  }

  static async init(dir: string): Promise<Repo> {
    const store = new ObjectStore(dir);
    await store.init();
    const repo = new Repo(dir, store);
    // Seed the default policy and the `main` view if absent.
    if (!(await store.getRef("policy"))) {
      const policyOid = await store.put(defaultPolicy());
      await store.setRef("policy", policyOid);
    }
    if (!(await store.getRef("view:main"))) {
      const view: View = {
        type: "view",
        name: "main",
        baseViewOid: null,
        query: { includeStatuses: ["accepted"] },
        createdAt: new Date().toISOString(),
      };
      const oid = await store.put(view);
      await store.setRef("view:main", oid);
    }
    return repo;
  }

  static async open(dir: string): Promise<Repo> {
    if (!ObjectStore.isRepo(dir)) {
      throw new Error(`not an AVCS repo: ${dir} (run \`avcs init\`)`);
    }
    const store = new ObjectStore(dir);
    const repo = new Repo(dir, store);
    // Re-seed the Lamport clock past the highest operation we've seen.
    let max = 0;
    for await (const op of store.list<Operation>("operation")) max = Math.max(max, op.lamport);
    repo.#clock = new LamportClock(max);
    return repo;
  }

  async policy(): Promise<Policy> {
    const oid = await this.store.getRef("policy");
    if (!oid) return defaultPolicy();
    return this.store.get<Policy>(oid);
  }

  // ── reading ──────────────────────────────────────────────────────────────
  async readIntent(oid: string): Promise<Intent> {
    return this.store.get<Intent>(oid);
  }
  async listIntents(): Promise<Intent[]> {
    return this.store.collect<Intent>("intent");
  }

  // ── authoring ──────────────────────────────────────────────────────────
  async createIntent(args: {
    title: string;
    owner: string;
    kind?: IntentKind;
    priority?: Intent["priority"];
    constraints?: string[];
    constraintKinds?: Intent["constraintKinds"];
    successCriteria?: string[];
    allowedScopes?: ScopeRef[];
  }): Promise<string> {
    const intent: Intent = {
      type: "intent",
      title: args.title,
      owner: args.owner,
      kind: args.kind ?? "feature",
      priority: args.priority ?? "normal",
      constraints: args.constraints ?? [],
      constraintKinds: args.constraintKinds,
      successCriteria: args.successCriteria ?? [],
      allowedScopes: args.allowedScopes ?? [],
      createdAt: new Date().toISOString(),
    };
    return this.store.put(intent);
  }

  async startSession(args: {
    intentOid: string;
    actor: Actor;
    summary?: string;
    openedEntities?: ScopeRef[];
    baseViewOid?: string | null;
  }): Promise<string> {
    const session: Session = {
      type: "session",
      intentOid: args.intentOid,
      actor: args.actor,
      baseViewOid: args.baseViewOid ?? (await this.store.getRef("view:main")),
      summary: args.summary ?? "",
      openedEntities: args.openedEntities ?? [],
      toolCalls: [],
      startedAt: new Date().toISOString(),
    };
    return this.store.put(session);
  }

  async putBlob(content: string | Uint8Array): Promise<string> {
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const blob: Blob = { type: "blob", data: Buffer.from(data).toString("base64"), encoding: "base64" };
    return this.store.put(blob);
  }

  async readBlob(oid: string): Promise<Buffer> {
    const blob = await this.store.get<Blob>(oid);
    return Buffer.from(blob.data, "base64");
  }

  async proposeOperation(args: {
    sessionOid: string;
    intentOid: string;
    actor: Actor;
    target: OperationTarget;
    body: OperationBody;
    declaredPurpose: string;
    causalDeps?: string[];
    effects?: Operation["effects"];
    confidence?: number;
  }): Promise<string> {
    const op: Operation = {
      type: "operation",
      sessionOid: args.sessionOid,
      intentOid: args.intentOid,
      actor: args.actor,
      target: args.target,
      body: args.body,
      declaredPurpose: args.declaredPurpose,
      causalDeps: args.causalDeps ?? [],
      effects: args.effects,
      lamport: this.#clock.tick(),
      createdAt: new Date().toISOString(),
      confidence: args.confidence,
    };
    return this.store.put(op);
  }

  /** Convenience: write file content as a blob + a put_file operation. */
  async proposeFileWrite(args: {
    sessionOid: string;
    intentOid: string;
    actor: Actor;
    path: string;
    content: string;
    declaredPurpose: string;
    causalDeps?: string[];
    effects?: Operation["effects"];
  }): Promise<string> {
    const blobOid = await this.putBlob(args.content);
    return this.proposeOperation({
      sessionOid: args.sessionOid,
      intentOid: args.intentOid,
      actor: args.actor,
      target: { entityKind: "file", entityId: args.path },
      body: { kind: "put_file", path: args.path, blobOid },
      declaredPurpose: args.declaredPurpose,
      causalDeps: args.causalDeps,
      effects: args.effects,
    });
  }

  async attachEvidence(args: {
    forOps: string[];
    kind: EvidenceKind;
    result: EvidenceResult;
    producedBy: Actor;
    command?: string;
    detail?: string;
  }): Promise<string> {
    const ev: Evidence = {
      type: "evidence",
      forOps: args.forOps,
      kind: args.kind,
      result: args.result,
      producedBy: args.producedBy,
      command: args.command,
      detail: args.detail,
      createdAt: new Date().toISOString(),
    };
    return this.store.put(ev);
  }

  async recordDecision(args: {
    conflictId: string;
    chosenOps: string[];
    rejectedOps: string[];
    reason: string;
    decidedBy: Actor;
    futurePolicy?: string;
  }): Promise<string> {
    const dec: Decision = {
      type: "decision",
      conflictId: args.conflictId,
      chosenOps: args.chosenOps,
      rejectedOps: args.rejectedOps,
      reason: args.reason,
      decidedBy: args.decidedBy,
      futurePolicy: args.futurePolicy,
      createdAt: new Date().toISOString(),
    };
    return this.store.put(dec);
  }

  // ── views & materialization ──────────────────────────────────────────────
  async getView(name: string): Promise<View> {
    const oid = await this.store.getRef(`view:${name}`);
    if (!oid) throw new Error(`no such view: ${name}`);
    return this.store.get<View>(oid);
  }

  async createView(name: string, query: ViewQuery, baseViewOid: string | null = null): Promise<string> {
    const view: View = {
      type: "view",
      name,
      baseViewOid,
      query,
      createdAt: new Date().toISOString(),
    };
    const oid = await this.store.put(view);
    await this.store.setRef(`view:${name}`, oid);
    return oid;
  }

  /** Resolve a view's query into the candidate operation set, then reduce. */
  async materialize(viewName = "main"): Promise<ReductionResult> {
    const view = await this.getView(viewName);
    const q = view.query;
    const exclude = new Set(q.excludeOps ?? []);
    const intentFilter = q.intentOids && q.intentOids.length ? new Set(q.intentOids) : null;
    const sessionFilter = q.sessionOids && q.sessionOids.length ? new Set(q.sessionOids) : null;

    const ops: Operation[] = [];
    for await (const op of this.store.list<Operation>("operation")) {
      if (exclude.has(op.oid as string)) continue;
      if (intentFilter && !intentFilter.has(op.intentOid)) continue;
      if (sessionFilter && !sessionFilter.has(op.sessionOid)) continue;
      ops.push(op);
    }
    const evidence = await this.store.collect<Evidence>("evidence");
    const decisions = await this.store.collect<Decision>("decision");
    const intents = new Map<string, Intent>();
    for await (const it of this.store.list<Intent>("intent")) intents.set(it.oid as string, it);

    return reduce({
      ops,
      evidence,
      decisions,
      intents,
      policy: await this.policy(),
      materializeStatuses: q.includeStatuses,
    });
  }

  /**
   * Write the materialized tree to a directory. Refuses to clobber an existing
   * non-empty directory unless it carries our marker, so a stray `--out` can't
   * `rm -rf` someone's source tree.
   */
  async writeWorkspace(result: ReductionResult, targetDir: string): Promise<void> {
    const marker = join(targetDir, ".avcs-workspace");
    if (existsSync(targetDir)) {
      const entries = await readdir(targetDir);
      const nonEmpty = entries.filter((e) => e !== "." && e !== "..");
      if (nonEmpty.length > 0 && !existsSync(marker)) {
        throw new Error(
          `refusing to overwrite non-empty directory without an .avcs-workspace marker: ${targetDir}`,
        );
      }
      await rm(targetDir, { recursive: true, force: true });
    }
    await mkdir(targetDir, { recursive: true });
    await writeFile(marker, `materialized ${result.treeHash}\n`, "utf8");
    for (const [path, blobOid] of result.tree) {
      const full = join(targetDir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, await this.readBlob(blobOid));
    }
  }

  async createCheckpoint(viewName: string, summary: string): Promise<string> {
    const view = await this.getView(viewName);
    const result = await this.materialize(viewName);
    const evidence: Checkpoint["evidence"] = {};
    // Deterministic aggregation: process evidence in canonical (createdAt, oid) order
    // so the "last result wins per kind" outcome is replica-independent.
    const allEvidence = (await this.store.collect<Evidence>("evidence")).sort(
      (a, b) =>
        (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
        ((a.oid ?? "") < (b.oid ?? "") ? -1 : 1),
    );
    for (const ev of allEvidence) {
      // Only count trusted evidence for accepted ops.
      if (ev.producedBy.kind === "ai_agent") continue;
      if (ev.forOps.some((o) => result.statuses.get(o) === "accepted")) {
        evidence[ev.kind] = ev.result;
      }
    }
    const cp: Checkpoint = {
      type: "checkpoint",
      viewOid: view.oid as string,
      headOps: result.headOps,
      treeHash: result.treeHash,
      policyOid: (await this.store.getRef("policy")) as string,
      materializerVersion: MATERIALIZER_VERSION,
      evidence,
      status: result.conflicts.length === 0 ? "verified" : "draft",
      summary,
      createdAt: new Date().toISOString(),
    };
    const oid = await this.store.put(cp);
    await this.store.setRef(`checkpoint:${viewName}:latest`, oid);
    return oid;
  }
}
