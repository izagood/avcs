// High-level repository facade.
//
// This is the single API surface that the CLI, the demo, and the MCP server all
// call. It hides the object store and reducer behind verbs that map 1:1 onto the
// agent workflow: intent → session → propose op → attach evidence → materialize →
// decide → checkpoint.

import { mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { Buffer } from "node:buffer";
import { ObjectStore } from "../store/objectStore.ts";
import { LamportClock } from "../core/clock.ts";
import { computeOid } from "../core/canonical.ts";
import { reduce, conflictIdFor, type ReductionResult } from "../reducer/reducer.ts";
import { detectSemanticConflicts } from "../semantic/contract.ts";
import { computeReliability } from "../policy/reliability.ts";
import type { OwnerRule } from "../objects/types.ts";
import { defaultPolicy, MATERIALIZER_VERSION } from "../reducer/policy.ts";
import {
  Keyring,
  generateKeypair,
  signMessage,
  type KeyRecord,
  type Signature,
} from "../core/identity.ts";
import { checkLease, isActive, type LeaseConflict } from "../concurrency/lease.ts";
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
  WorkLease,
} from "../objects/types.ts";

export class Repo {
  readonly dir: string;
  readonly store: ObjectStore;
  readonly keyring = new Keyring();
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
    await repo.#loadKeyring();
    return repo;
  }

  async policy(): Promise<Policy> {
    const oid = await this.store.getRef("policy");
    if (!oid) return defaultPolicy();
    return this.store.get<Policy>(oid);
  }

  /** Replace the active policy (new version ⇒ a distinguishable checkpoint). */
  async setPolicy(policy: Policy): Promise<string> {
    const oid = await this.store.put(policy);
    await this.store.setRef("policy", oid);
    return oid;
  }

  /** Set code-owner rules (Phase 5), bumping the policy version. */
  async setOwners(owners: OwnerRule[]): Promise<string> {
    const current = await this.policy();
    return this.setPolicy({ ...current, owners, version: `${current.version}+owners`, createdAt: new Date().toISOString() });
  }

  /** actorId → learned reliability nudge, from history. */
  async reliability(): Promise<Map<string, number>> {
    const ops = await this.store.collect<Operation>("operation");
    const evidence = this.#verifiedEvidence(await this.store.collect<Evidence>("evidence"));
    const decisions = await this.store.collect<Decision>("decision");
    return computeReliability(ops, evidence, decisions);
  }

  // ── identity / keyring (Phase 3) ──────────────────────────────────────────
  #keysDir(): string {
    return join(this.store.root, "keys");
  }
  async #loadKeyring(): Promise<void> {
    const dir = this.#keysDir();
    if (!existsSync(dir)) return;
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      const rec = JSON.parse(await readFile(join(dir, f), "utf8")) as KeyRecord;
      this.keyring.register(rec);
    }
  }
  /** Persist a public key as trusted and load it into the keyring. */
  async registerPublicKey(rec: KeyRecord): Promise<void> {
    await mkdir(this.#keysDir(), { recursive: true });
    await writeFile(join(this.#keysDir(), `${rec.keyId}.json`), JSON.stringify(rec), "utf8");
    this.keyring.register(rec);
  }
  /**
   * Mint a keypair for an actor, register the public half as trusted, and return
   * the private half for the caller to hold. (MVP: a real deployment keeps private
   * keys with the actor, never in the repo.)
   */
  async generateActorKey(actor: Actor, keyId = actor.id): Promise<{ keyId: string; privateKey: string; publicKey: string }> {
    const { publicKey, privateKey } = generateKeypair();
    await this.registerPublicKey({ keyId, publicKey, actorId: actor.id, actorKind: actor.kind });
    return { keyId, privateKey, publicKey };
  }
  #sign(type: string, payload: Record<string, unknown>, signWith?: { keyId: string; privateKey: string }): Signature | undefined {
    if (!signWith) return undefined;
    const oid = computeOid(type, payload);
    return { keyId: signWith.keyId, alg: "ed25519", sig: signMessage(signWith.privateKey, oid) };
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

  /**
   * Phase 2: replace one named top-level symbol within a file. Two such edits to
   * different symbols of the same file auto-merge. Should causally depend on the op
   * that established the file (`causalDeps`) so reconstruction starts from it.
   */
  async proposeSymbolEdit(args: {
    sessionOid: string;
    intentOid: string;
    actor: Actor;
    path: string;
    symbolName: string;
    newText: string;
    declaredPurpose: string;
    causalDeps?: string[];
    effects?: Operation["effects"];
  }): Promise<string> {
    const blobOid = await this.putBlob(args.newText);
    return this.proposeOperation({
      sessionOid: args.sessionOid,
      intentOid: args.intentOid,
      actor: args.actor,
      target: { entityKind: "symbol", entityId: `${args.path}#${args.symbolName}` },
      body: { kind: "set_symbol", path: args.path, symbolName: args.symbolName, blobOid },
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
    /** Sign the evidence so the trust gate can verify it cryptographically. */
    signWith?: { keyId: string; privateKey: string };
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
    ev.sig = this.#sign("evidence", ev as unknown as Record<string, unknown>, args.signWith);
    return this.store.put(ev);
  }

  async recordDecision(args: {
    conflictId: string;
    chosenOps: string[];
    rejectedOps: string[];
    reason: string;
    decidedBy: Actor;
    futurePolicy?: string;
    signWith?: { keyId: string; privateKey: string };
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
    dec.sig = this.#sign("decision", dec as unknown as Record<string, unknown>, args.signWith);
    return this.store.put(dec);
  }

  // ── leases (Phase 3) ───────────────────────────────────────────────────────
  async activeLeases(): Promise<WorkLease[]> {
    const now = new Date().toISOString();
    return (await this.store.collect<WorkLease>("lease")).filter((l) => isActive(l, now));
  }

  /**
   * Request a soft write-lease over scopes. Returns the granted lease oid, or the
   * conflicts that block it (overlapping active exclusive lease held by another).
   */
  async requestLease(args: {
    intentOid: string;
    sessionOid: string;
    actor: Actor;
    writeScopes: ScopeRef[];
    mode?: "exclusive" | "shared";
    ttlMs?: number;
  }): Promise<{ granted: true; leaseOid: string } | { granted: false; conflicts: LeaseConflict[] }> {
    const mode = args.mode ?? "exclusive";
    const conflicts = checkLease({ writeScopes: args.writeScopes, mode, actorId: args.actor.id }, await this.activeLeases());
    if (conflicts.length) return { granted: false, conflicts };
    const now = Date.now();
    const lease: WorkLease = {
      type: "lease",
      intentOid: args.intentOid,
      sessionOid: args.sessionOid,
      actor: args.actor,
      writeScopes: args.writeScopes,
      mode,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (args.ttlMs ?? 30 * 60_000)).toISOString(),
    };
    return { granted: true, leaseOid: await this.store.put(lease) };
  }

  /** Build a minimal repair packet for ops whose validation failed. */
  async repairContext(opOids: string[]): Promise<import("../validation/repair.ts").RepairContext> {
    const { buildRepairContext } = await import("../validation/repair.ts");
    const ops: Operation[] = [];
    for (const oid of opOids) ops.push(await this.store.get<Operation>(oid));
    const evidence = await this.store.collect<Evidence>("evidence");
    const decisions = await this.store.collect<Decision>("decision");
    return buildRepairContext(ops, evidence, decisions);
  }

  /**
   * When a keyring is configured, trust must be earned by signature: evidence that
   * claims a trusted (non-agent) producer is dropped unless it carries a valid
   * signature for that actor. Forged or tampered evidence simply disappears, so the
   * op it vouched for stays gated. With no keyring, fall back to the Phase-1
   * producedBy heuristic (keep everything; the policy ignores agent self-reports).
   */
  #verifiedEvidence(all: Evidence[]): Evidence[] {
    if (this.keyring.size === 0) return all;
    return all.filter((e) => {
      if (e.producedBy.kind === "ai_agent") return true; // policy ignores these anyway
      return this.keyring.verifyFor(e.producedBy.id, e.oid as string, e.sig);
    });
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
    const evidence = this.#verifiedEvidence(await this.store.collect<Evidence>("evidence"));
    const decisions = await this.store.collect<Decision>("decision");
    const intents = new Map<string, Intent>();
    for await (const it of this.store.list<Intent>("intent")) intents.set(it.oid as string, it);

    // Preload blob content needed by content-aware ops (set_symbol reconstructs text).
    const blobContent = new Map<string, string>();
    for (const op of ops) {
      const oid = op.body.blobOid;
      if (oid && !blobContent.has(oid)) blobContent.set(oid, (await this.readBlob(oid)).toString("utf8"));
    }

    const policy = await this.policy();
    const reliability = computeReliability(ops, evidence, decisions);
    const base = { ops, evidence, decisions, intents, policy, materializeStatuses: q.includeStatuses, blobContent, reliability };
    const pass1 = reduce(base);

    // Phase 4: semantic-conflict pass. Find contract breaks that the text-clean
    // grouping accepted, then re-reduce with the breaking ops held back so the tree
    // stays safe and the break becomes a human decision.
    const semantic = detectSemanticConflicts(ops, pass1, evidence, blobContent);
    if (semantic.length === 0) return pass1;

    const breaking = new Set(semantic.map((s) => s.breakingOp));
    const pass2 = reduce({ ...base, ops: ops.filter((o) => !breaking.has(o.oid as string)) });
    for (const s of semantic) {
      pass2.statuses.set(s.breakingOp, "needs_decision");
      for (const d of s.dependentOps) pass2.statuses.set(d, pass2.statuses.get(d) ?? "needs_decision");
    }
    pass2.semanticConflicts = semantic;
    for (const s of semantic) {
      pass2.conflicts.push({
        id: `conflict_sem_${(s.symbol.split("#")[1] ?? s.symbol).slice(0, 16)}`,
        key: `contract:${s.symbol}`,
        kind: "needs_human",
        reason: s.reason,
        recommendedOp: null,
        options: [s.breakingOp, ...s.dependentOps].map((oid) => ({
          opOid: oid, actor: "", purpose: oid === s.breakingOp ? "contract change" : "depends on old contract",
          evidence: [], score: 0, blocked: false, requiresHuman: true,
        })),
      });
    }
    return pass2;
  }

  /**
   * Decision memory: given a conflict key, recall prior human rulings on the same
   * key — their verdict, reason, and any distilled `futurePolicy`. The next agent
   * (and the conflict UI) can reuse them instead of re-litigating.
   */
  async recallDecisions(conflictKey: string): Promise<{ reason: string; futurePolicy?: string; decidedBy: string }[]> {
    const cid = conflictIdFor(conflictKey);
    const decisions = await this.store.collect<Decision>("decision");
    return decisions
      .filter((d) => d.conflictId === cid || d.conflictId === conflictKey)
      .map((d) => ({ reason: d.reason, futurePolicy: d.futurePolicy, decidedBy: d.decidedBy.id }));
  }

  /** All distilled `futurePolicy` rules a human has left behind — learned constraints. */
  async learnedPolicies(): Promise<string[]> {
    const decisions = await this.store.collect<Decision>("decision");
    return [...new Set(decisions.map((d) => d.futurePolicy).filter((p): p is string => !!p))];
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
      // Symbol-merged files are synthesized content, not a stored blob.
      const synth = result.synthBlobs.get(blobOid);
      await writeFile(full, synth !== undefined ? Buffer.from(synth, "utf8") : await this.readBlob(blobOid));
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

  /** Resolve the materialized tree into {path, content} entries. */
  async materializedFiles(result: ReductionResult): Promise<{ path: string; content: string }[]> {
    const out: { path: string; content: string }[] = [];
    for (const [path, blobOid] of result.tree) {
      const synth = result.synthBlobs.get(blobOid);
      out.push({ path, content: synth ?? (await this.readBlob(blobOid)).toString("utf8") });
    }
    return out;
  }

  /**
   * Phase 6: cut a Release — a verified checkpoint + its evidence + an SBOM of what
   * shipped + signed-off artifacts. Refuses unless the view is conflict-free (no open
   * conflicts and no semantic contract breaks): you cannot release an unverified tree.
   */
  async cutRelease(
    viewName: string,
    opts: {
      artifacts?: import("../objects/types.ts").ArtifactRef[];
      signedBy?: string[];
      signWith?: { keyId: string; privateKey: string };
      summary?: string;
    } = {},
  ): Promise<{ released: true; releaseOid: string } | { released: false; reason: string }> {
    const result = await this.materialize(viewName);
    if (result.conflicts.length || result.semanticConflicts.length) {
      return {
        released: false,
        reason: `view has ${result.conflicts.length} open conflict(s) and ${result.semanticConflicts.length} contract break(s); resolve them before releasing`,
      };
    }
    const checkpointOid = await this.createCheckpoint(viewName, opts.summary ?? `release of ${viewName}`);
    const checkpoint = await this.store.get<Checkpoint>(checkpointOid);
    const { generateSbom } = await import("../release/sbom.ts");
    const sbom = generateSbom(await this.materializedFiles(result));

    const release: import("../objects/types.ts").Release = {
      type: "release",
      checkpointOid,
      treeHash: result.treeHash,
      sbom,
      artifacts: opts.artifacts ?? [],
      evidence: checkpoint.evidence,
      signedBy: opts.signedBy ?? (opts.signWith ? [opts.signWith.keyId] : []),
      status: "released",
      createdAt: new Date().toISOString(),
    };
    release.sig = this.#sign("release", release as unknown as Record<string, unknown>, opts.signWith);
    const oid = await this.store.put(release);
    await this.store.setRef(`release:${viewName}:latest`, oid);
    return { released: true, releaseOid: oid };
  }
}
