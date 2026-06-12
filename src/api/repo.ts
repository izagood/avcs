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
import { computeOid, sha256hex } from "../core/canonical.ts";
import { reduce, conflictIdFor, keysOf, detectCrossGranularity, type ReductionResult } from "../reducer/reducer.ts";
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
import { Metrics } from "../observe/metrics.ts";
import type {
  Actor,
  AnyObject,
  Blob,
  Checkpoint,
  Decision,
  Evidence,
  EvidenceKind,
  EvidenceResult,
  Intent,
  IntentKind,
  Line,
  Membership,
  Operation,
  OperationBody,
  OperationTarget,
  Override,
  Policy,
  Promotion,
  Protection,
  Redaction,
  RoleName,
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
  readonly metrics = new Metrics();
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

  // Large blobs are chunked so a huge file never inflates one JSON object, and
  // identical chunks dedup by content address. (Phase 9b)
  static readonly CHUNK_THRESHOLD = 256 * 1024;
  static readonly CHUNK_SIZE = 64 * 1024;

  async putBlob(content: string | Uint8Array): Promise<string> {
    const data = Buffer.from(typeof content === "string" ? Buffer.from(content, "utf8") : content);
    if (data.length <= Repo.CHUNK_THRESHOLD) {
      return this.store.put({ type: "blob", data: data.toString("base64"), encoding: "base64" } satisfies Blob);
    }
    const chunks: string[] = [];
    for (let i = 0; i < data.length; i += Repo.CHUNK_SIZE) {
      const part = data.subarray(i, i + Repo.CHUNK_SIZE);
      chunks.push(await this.store.put({ type: "blob", data: part.toString("base64"), encoding: "base64" } satisfies Blob));
    }
    return this.store.put({ type: "blob", data: "", encoding: "base64", chunked: true, chunks } satisfies Blob);
  }

  async readBlob(oid: string): Promise<Buffer> {
    const blob = await this.store.get<Blob>(oid);
    if (blob.chunked && blob.chunks) {
      return Buffer.concat(await Promise.all(blob.chunks.map((c) => this.readBlob(c))));
    }
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
    line?: string;
    derivedFrom?: string;
    revertOf?: string;
    coAuthors?: Actor[];
    private?: boolean;
    signWith?: { keyId: string; privateKey: string };
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
      // Only store `line` when it is non-default, so existing (line-less) repos and
      // their oids stay byte-identical — backward compatibility with "main".
      ...(args.line && args.line !== "main" ? { line: args.line } : {}),
      ...(args.derivedFrom ? { derivedFrom: args.derivedFrom } : {}),
      ...(args.revertOf ? { revertOf: args.revertOf } : {}),
      ...(args.coAuthors && args.coAuthors.length ? { coAuthors: args.coAuthors } : {}),
      ...(args.private ? { private: true } : {}),
    };
    op.sig = this.#sign("operation", op as unknown as Record<string, unknown>, args.signWith);
    const oid = await this.store.put(op);
    // Maintain the entity index (Phase 9): key → op oids for fast history/blame.
    for (const key of keysOf({ ...op, oid })) await this.store.appendEntityIndex(key, oid);
    return oid;
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
    line?: string;
    signWith?: { keyId: string; privateKey: string };
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
      line: args.line,
      signWith: args.signWith,
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
    line?: string;
    signWith?: { keyId: string; privateKey: string };
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
      line: args.line,
      signWith: args.signWith,
    });
  }

  /**
   * M3 AST op: rename a top-level symbol (declaration + same-file references). Contends
   * on both the old and new symbol keys. Should causally depend on the op that
   * established the file. Cross-file references are a follow-up (needs reference analysis).
   */
  async proposeRenameSymbol(args: {
    sessionOid: string;
    intentOid: string;
    actor: Actor;
    path: string;
    from: string;
    to: string;
    declaredPurpose: string;
    causalDeps?: string[];
    line?: string;
  }): Promise<string> {
    return this.proposeOperation({
      sessionOid: args.sessionOid,
      intentOid: args.intentOid,
      actor: args.actor,
      target: { entityKind: "symbol", entityId: `${args.path}#${args.from}` },
      body: { kind: "rename_symbol", path: args.path, symbolName: args.from, newName: args.to },
      declaredPurpose: args.declaredPurpose,
      causalDeps: args.causalDeps,
      line: args.line,
    });
  }

  /**
   * M3 AST op: move a top-level symbol from one file to another. Contends on the
   * symbol at both source and destination. Cross-file references are a follow-up.
   */
  async proposeMoveSymbol(args: {
    sessionOid: string;
    intentOid: string;
    actor: Actor;
    fromPath: string;
    toPath: string;
    symbolName: string;
    declaredPurpose: string;
    causalDeps?: string[];
    line?: string;
    signWith?: { keyId: string; privateKey: string };
  }): Promise<string> {
    return this.proposeOperation({
      sessionOid: args.sessionOid,
      intentOid: args.intentOid,
      actor: args.actor,
      target: { entityKind: "symbol", entityId: `${args.fromPath}#${args.symbolName}` },
      body: { kind: "move_symbol", fromPath: args.fromPath, path: args.toPath, symbolName: args.symbolName },
      declaredPurpose: args.declaredPurpose,
      causalDeps: args.causalDeps,
      line: args.line,
      signWith: args.signWith,
    });
  }

  async attachEvidence(args: {
    forOps: string[];
    kind: EvidenceKind;
    result: EvidenceResult;
    producedBy: Actor;
    command?: string;
    detail?: string;
    /** Produced by a secret-less isolated runner over untrusted code (Phase 11). */
    fromUntrustedRunner?: boolean;
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
      ...(args.fromUntrustedRunner ? { fromUntrustedRunner: true } : {}),
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
    // H-6: check-then-write under a lock so two concurrent requesters cannot both
    // read "no conflict" and both acquire an overlapping exclusive lease (TOCTOU).
    return this.store.withLock("leases", async () => {
      const conflicts = checkLease(
        { writeScopes: args.writeScopes, mode, actorId: args.actor.id },
        await this.activeLeases(),
      );
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
    });
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

  // ── lineage (Phase 8) ──────────────────────────────────────────────────────
  async #getLine(name: string): Promise<Line | null> {
    const oid = await this.store.getRef(`line:${name}`);
    return oid ? this.store.get<Line>(oid) : null;
  }

  /** Oids inherited by a line: the causal closure of its fork checkpoint's frontier. */
  async #inheritedOps(lineName: string, allOps: Operation[]): Promise<Set<string>> {
    const line = await this.#getLine(lineName);
    if (!line?.forkCheckpointOid) return new Set();
    const cp = await this.store.get<Checkpoint>(line.forkCheckpointOid);
    const byId = new Map(allOps.map((o) => [o.oid as string, o]));
    const seen = new Set<string>();
    const stack = [...cp.headOps];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const dep of byId.get(id)?.causalDeps ?? []) if (!seen.has(dep)) stack.push(dep);
    }
    return seen;
  }

  async listLines(): Promise<Line[]> {
    return this.store.collect<Line>("line");
  }

  /**
   * Fork a new line from `fromLine` at its current (or a given) checkpoint. The fork
   * checkpoint freezes what the new line inherits; everything the base line does
   * afterwards stays out of the new line. Also creates a same-named view selecting it.
   */
  async createLine(name: string, fromLine = "main", atCheckpointOid?: string): Promise<string> {
    if (await this.#getLine(name)) throw new Error(`line already exists: ${name}`);
    const forkCheckpointOid = atCheckpointOid ?? (await this.createCheckpoint(fromLine, `fork point for line ${name}`));
    const line: Line = {
      type: "line",
      name,
      baseLine: fromLine,
      forkCheckpointOid,
      createdAt: new Date().toISOString(),
    };
    const oid = await this.store.put(line);
    await this.store.setRef(`line:${name}`, oid);
    await this.createView(name, { includeStatuses: ["accepted"], line: name });
    return oid;
  }

  /** Frontier (accepted head ops) of a line — the causalDeps a new op should build on. */
  async lineFrontier(lineName: string): Promise<string[]> {
    return (await this.materialize(lineName)).headOps;
  }

  /**
   * Port (cherry-pick / backport) an operation onto another line: mint a NEW op on
   * the target line carrying the source's body, based on the target line's current
   * frontier, with `derivedFrom` provenance. set_symbol re-splices against the target
   * line's content automatically at materialize; put_file replaces on the target line.
   */
  async portOp(sourceOpOid: string, targetLine: string, actor?: Actor): Promise<string> {
    const src = await this.store.get<Operation>(sourceOpOid);
    await this.getView(targetLine); // ensure the target line/view exists
    return this.proposeOperation({
      sessionOid: src.sessionOid,
      intentOid: src.intentOid,
      actor: actor ?? src.actor,
      target: src.target,
      body: src.body,
      declaredPurpose: `backport ${sourceOpOid.slice(0, 16)} → ${targetLine}: ${src.declaredPurpose}`,
      causalDeps: await this.lineFrontier(targetLine),
      effects: src.effects,
      line: targetLine,
      derivedFrom: sourceOpOid,
    });
  }

  // ── governance: membership, roles, protection, finalize (Phase 7) ──────────
  static readonly ROLE_WEIGHT: Record<RoleName, number> = {
    reader: 0,
    proposer: 1,
    reviewer: 2,
    maintainer: 3,
    admin: 4,
  };

  /** Issue a root-signed membership granting a role; registers the member's key. */
  async registerMembership(args: {
    actorId: string;
    publicKey: string;
    role: RoleName;
    actorKind?: "human" | "ai_agent" | "ci_bot";
    scopes?: ScopeRef[];
    root: { keyId: string; privateKey: string };
  }): Promise<string> {
    const m: Membership = {
      type: "membership",
      actorId: args.actorId,
      publicKey: args.publicKey,
      role: args.role,
      scopes: args.scopes,
      issuedBy: args.root.keyId,
      createdAt: new Date().toISOString(),
    };
    m.sig = this.#sign("membership", m as unknown as Record<string, unknown>, args.root);
    const oid = await this.store.put(m);
    await this.store.setRef(`member:${args.actorId}`, oid);
    await this.registerPublicKey({ keyId: args.actorId, publicKey: args.publicKey, actorId: args.actorId, actorKind: args.actorKind ?? "ai_agent" });
    return oid;
  }

  async membershipOf(actorId: string): Promise<Membership | null> {
    const oid = await this.store.getRef(`member:${actorId}`);
    if (!oid) return null;
    const m = await this.store.get<Membership>(oid);
    return m.revokedAt ? null : m;
  }
  async roleOf(actorId: string): Promise<RoleName> {
    return (await this.membershipOf(actorId))?.role ?? "reader";
  }
  async hasRole(actorId: string, min: RoleName): Promise<boolean> {
    return Repo.ROLE_WEIGHT[await this.roleOf(actorId)] >= Repo.ROLE_WEIGHT[min];
  }

  /** deciderId → role weight, for authority-weighted decision precedence (docs/08 §4). */
  async #authorityMap(): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    for (const mem of await this.store.collect<Membership>("membership")) {
      if (mem.revokedAt) continue;
      m.set(mem.actorId, Repo.ROLE_WEIGHT[mem.role]);
    }
    return m;
  }

  /** Revoke a membership (admin only): future ops/decisions by this actor lose trust. */
  async revokeMembership(actorId: string, byAdmin: string): Promise<void> {
    if (!(await this.hasRole(byAdmin, "admin"))) {
      throw new Error(`revoke requires role admin; ${byAdmin} is ${await this.roleOf(byAdmin)}`);
    }
    const m = await this.membershipOf(actorId);
    if (!m) return;
    const revoked: Membership = { ...m, revokedAt: new Date().toISOString() };
    delete (revoked as { oid?: string }).oid;
    revoked.sig = undefined;
    const oid = await this.store.put(revoked);
    await this.store.setRef(`member:${actorId}`, oid);
  }

  async setProtection(p: Omit<Protection, "type" | "createdAt">): Promise<string> {
    const protection: Protection = { type: "protection", ...p, createdAt: new Date().toISOString() };
    const oid = await this.store.put(protection);
    await this.store.setRef(`protection:${p.view}`, oid);
    return oid;
  }
  async getProtection(view: string): Promise<Protection | null> {
    const oid = await this.store.getRef(`protection:${view}`);
    return oid ? this.store.get<Protection>(oid) : null;
  }

  /** Current protected head (a checkpoint oid) of a view, or null if never finalized. */
  async protectedHead(view: string): Promise<string | null> {
    return this.store.getRef(`head:${view}`);
  }

  /**
   * Finalize (= PR merge): advance a view's protected head to `newCheckpoint` via a
   * compare-and-swap on `parentHead`. Rejects a stale (non-fast-forward) finalize
   * even for admins unless allowForcePush — this is the causal-currency guard (docs/08
   * §6/§9): authority never licenses overwriting fresher history.
   */
  async finalize(args: {
    view: string;
    newCheckpoint: string;
    parentHead: string | null;
    by: string; // actor id
  }): Promise<{ finalized: true; head: string } | { finalized: false; reason: string }> {
    return this.store.withLock(`finalize:${args.view}`, async () => {
      const prot = await this.getProtection(args.view);
      const current = await this.protectedHead(args.view);
      // CAS / non-fast-forward check
      if (current !== args.parentHead && !(prot?.allowForcePush)) {
        return { finalized: false as const, reason: `head moved: ${current ?? "∅"} ≠ parent ${args.parentHead ?? "∅"} — pull and re-reduce first` };
      }
      // role gate
      const minRole = prot?.finalizeRole ?? "maintainer";
      if (prot && !(await this.hasRole(args.by, minRole))) {
        return { finalized: false as const, reason: `${args.by} lacks role ${minRole} to finalize ${args.view}` };
      }
      // required checks — unless an active break-glass Override waives them (Phase 12)
      const cp = await this.store.get<Checkpoint>(args.newCheckpoint);
      const waived = await this.#activeWaivers(args.view);
      for (const k of prot?.requiredChecks ?? []) {
        if (cp.evidence[k] !== "pass" && !waived.has(k)) {
          return { finalized: false as const, reason: `required check ${k} not pass` };
        }
      }
      await this.store.setRef(`head:${args.view}`, args.newCheckpoint);
      return { finalized: true as const, head: args.newCheckpoint };
    });
  }

  // ── security (Phase 12) ────────────────────────────────────────────────────
  /**
   * Redact (tombstone) a blob's bytes — for a leaked secret. Admin-only. The oid is
   * preserved so all references and the treeHash stay valid; the plaintext is evicted
   * from this store (and, once a real sync ships, propagated to every replica).
   */
  async redact(blobOid: string, reason: string, by: string): Promise<string> {
    if (!(await this.hasRole(by, "admin"))) {
      throw new Error(`redact requires role admin; ${by} is ${await this.roleOf(by)}`);
    }
    const blob = await this.store.get<Blob>(blobOid);
    const original = Buffer.from(blob.data, "base64");
    const redaction: Redaction = {
      type: "redaction",
      blobOid,
      sha256: sha256hex(original),
      length: original.length,
      reason,
      by,
      createdAt: new Date().toISOString(),
    };
    const redactionOid = await this.store.put(redaction);
    // Evict the bytes: overwrite the blob object in place with a stub (oid preserved).
    const stub: Blob = {
      type: "blob",
      data: Buffer.from(`[REDACTED: ${reason}]`).toString("base64"),
      encoding: "base64",
      redacted: true,
      redactionOid,
    };
    await this.store.overwriteAt(blobOid, stub);
    return redactionOid;
  }

  async #activeWaivers(view: string): Promise<Set<EvidenceKind>> {
    const now = new Date().toISOString();
    const out = new Set<EvidenceKind>();
    for (const o of await this.store.collect<Override>("override")) {
      if (o.view === view && o.expiresAt > now) for (const k of o.waiveChecks) out.add(k);
    }
    return out;
  }

  /** Break-glass: a maintainer/admin grants an expiring waiver of required checks. */
  async grantOverride(args: { view: string; waiveChecks: EvidenceKind[]; reason: string; by: string; ttlMs?: number }): Promise<string> {
    if (!(await this.hasRole(args.by, "maintainer"))) {
      throw new Error(`override requires role >= maintainer; ${args.by} is ${await this.roleOf(args.by)}`);
    }
    const o: Override = {
      type: "override",
      view: args.view,
      waiveChecks: args.waiveChecks,
      reason: args.reason,
      by: args.by,
      expiresAt: new Date(Date.now() + (args.ttlMs ?? 30 * 60_000)).toISOString(),
      createdAt: new Date().toISOString(),
    };
    return this.store.put(o);
  }

  /**
   * Rollback a protected head to an earlier checkpoint — FORWARD-only: it advances the
   * head (a new finalize CAS) to point at a prior state, never rewriting history.
   */
  async rollbackTo(view: string, checkpointOid: string, by: string): Promise<{ finalized: true; head: string } | { finalized: false; reason: string }> {
    return this.finalize({ view, newCheckpoint: checkpointOid, parentHead: await this.protectedHead(view), by });
  }

  // ── sync: object gossip between two stores (Phase 7) ───────────────────────
  /**
   * Pull objects from another repo's store into this one. Objects are append-only and
   * content-addressed, so sync is a conflict-free union of whatever the other side has
   * that we lack. `gate` (optional) lets a hub reject ops not signed by a known member.
   * Returns counts. Refs (governance) are NOT synced — those are hub-authoritative.
   */
  async pull(otherDir: string, opts: { requireSignedMembers?: boolean } = {}): Promise<{ copied: number; rejected: number }> {
    const other = new ObjectStore(otherDir);
    let copied = 0;
    let rejected = 0;
    for await (const obj of other.list()) {
      const oid = obj.oid as string;
      if (await this.store.has(oid)) continue;
      // Stash: private ops are local-only — never gossiped (Phase 7 follow-up).
      if (obj.type === "operation" && (obj as Operation).private) continue;
      if (opts.requireSignedMembers && obj.type === "operation") {
        const op = obj as Operation;
        const ok = this.keyring.verifyFor(op.actor.id, oid, op.sig) && (await this.hasRole(op.actor.id, "proposer"));
        if (!ok) {
          rejected++;
          continue;
        }
      }
      await this.store.put(obj as never);
      if (obj.type === "operation") for (const k of keysOf(obj as Operation)) await this.store.appendEntityIndex(k, oid);
      copied++;
    }
    return { copied, rejected };
  }

  /** Push objects this repo holds that a network hub lacks (M2 / docs/10 WS-B). */
  async pushHub(hubUrl: string): Promise<{ pushed: number; rejected: number }> {
    const { pushToHub } = await import("../hub/hubClient.ts");
    return pushToHub(this.dir, hubUrl);
  }
  /** Pull objects a network hub holds that this repo lacks. */
  async pullHub(hubUrl: string): Promise<{ pulled: number }> {
    const { pullFromHub } = await import("../hub/hubClient.ts");
    return pullFromHub(this.dir, hubUrl);
  }

  /** Resolve a view's query into the candidate operation set, then reduce. */
  async materialize(viewName = "main"): Promise<ReductionResult> {
    this.metrics.inc("materialize.calls");
    const view = await this.getView(viewName);
    const q = view.query;
    const exclude = new Set(q.excludeOps ?? []);
    const intentFilter = q.intentOids && q.intentOids.length ? new Set(q.intentOids) : null;
    const sessionFilter = q.sessionOids && q.sessionOids.length ? new Set(q.sessionOids) : null;

    // Lineage (Phase 8): a line materializes its own ops + everything inherited from
    // its fork checkpoint (the base line's frozen frontier). Ops authored on the base
    // line AFTER the fork are excluded, which is what keeps lines divergent.
    const lineName = q.line ?? "main";
    const allOps = await this.store.collect<Operation>("operation");
    const inherited = await this.#inheritedOps(lineName, allOps);

    const ops: Operation[] = [];
    for (const op of allOps) {
      const onLine = (op.line ?? "main") === lineName || inherited.has(op.oid as string);
      if (!onLine) continue;
      if (exclude.has(op.oid as string)) continue;
      if (intentFilter && !intentFilter.has(op.intentOid)) continue;
      if (sessionFilter && !sessionFilter.has(op.sessionOid)) continue;
      ops.push(op);
    }
    // Phase 11: in a governed repo, ops authored by non-members (outsiders) are
    // quarantined — excluded from the materialized tree until a reviewer promotes them.
    const { kept, quarantined } = await this.#partitionQuarantine(ops);
    const res = await this.#reduceOpSet(kept, q.includeStatuses);
    for (const oid of quarantined) res.statuses.set(oid, "quarantined");
    return res;
  }

  /** Split ops into kept vs quarantined (outsider, not-yet-promoted) for a governed repo. */
  async #partitionQuarantine(ops: Operation[]): Promise<{ kept: Operation[]; quarantined: Set<string> }> {
    const memberships = await this.store.collect<Membership>("membership");
    if (memberships.length === 0) return { kept: ops, quarantined: new Set() }; // governance off
    const members = new Set(memberships.filter((m) => !m.revokedAt).map((m) => m.actorId));
    const promoted = new Set((await this.store.collect<Promotion>("promotion")).flatMap((p) => p.ops));
    const kept: Operation[] = [];
    const quarantined = new Set<string>();
    for (const op of ops) {
      if (!members.has(op.actor.id) && !promoted.has(op.oid as string)) quarantined.add(op.oid as string);
      else kept.push(op);
    }
    return { kept, quarantined };
  }

  /** List currently-quarantined ops (outsider contributions awaiting review). */
  async quarantinedOps(line = "main"): Promise<string[]> {
    const res = await this.materialize(line);
    return [...res.statuses].filter(([, s]) => s === "quarantined").map(([oid]) => oid);
  }

  /**
   * Phase 11: a non-member (external contributor) submits an op. It self-signs and
   * lands quarantined. Admission control caps outstanding outsider ops per actor.
   */
  async proposeOutsider(
    args: Parameters<Repo["proposeOperation"]>[0] & { maxOutstanding?: number },
  ): Promise<string> {
    const cap = args.maxOutstanding ?? 50;
    const mine = (await this.store.collect<Operation>("operation")).filter((o) => o.actor.id === args.actor.id);
    if (mine.length >= cap) throw new Error(`admission cap (${cap}) reached for outsider ${args.actor.id}`);
    return this.proposeOperation(args);
  }

  /** A reviewer promotes quarantined outsider ops into the normal accepted flow. */
  async promote(opOids: string[], byActor: string, reason?: string): Promise<string> {
    if (!(await this.hasRole(byActor, "reviewer"))) {
      throw new Error(`promote requires role >= reviewer; ${byActor} is ${await this.roleOf(byActor)}`);
    }
    const p: Promotion = { type: "promotion", ops: opOids, by: byActor, reason, createdAt: new Date().toISOString() };
    return this.store.put(p);
  }

  /**
   * Revert an op: a forward-only inverse. Restores the op's file to its pre-op content
   * (or deletes it if it didn't exist before) as a NEW op with `revertOf` provenance —
   * append-only, recorded, itself revertable. File-granular in the MVP.
   */
  async revert(opOid: string, actor: Actor, line = "main"): Promise<string> {
    const target = await this.store.get<Operation>(opOid);
    const path = target.body.path ?? (target.target.entityId.split("#")[0] as string);
    const before = await this.materializeAt(target.causalDeps);
    const prev = (await this.materializedFiles(before)).find((f) => f.path === path);
    const causalDeps = await this.lineFrontier(line);
    const common = {
      sessionOid: target.sessionOid,
      intentOid: target.intentOid,
      actor,
      declaredPurpose: `revert ${opOid.slice(0, 16)}: ${target.declaredPurpose}`,
      causalDeps,
      line,
      revertOf: opOid,
    } as const;
    if (prev === undefined) {
      return this.proposeOperation({ ...common, target: { entityKind: "file", entityId: path }, body: { kind: "delete_file", path } });
    }
    return this.proposeOperation({
      ...common,
      target: { entityKind: "file", entityId: path },
      body: { kind: "put_file", path, blobOid: await this.putBlob(prev.content) },
    });
  }

  /**
   * Reduce an explicit operation set (with the semantic-conflict 2-pass). Shared by
   * `materialize` (view-selected ops) and `materializeAt` (a frontier's closure).
   */
  // M1: cache reduction results keyed on a signature of the inputs. reduce() is a
  // pure function of (ops, evidence, decisions, policy, materializer), so identical
  // inputs ⇒ identical result — we skip the grouping/eval/semantic-2-pass/blob-load
  // cost on repeat calls (the hundreds-of-agents-re-materialize case, and CLI/MCP
  // repeats). A clone is returned so callers can mutate without corrupting the cache.
  #reduceCache = new Map<string, ReductionResult>();
  static readonly REDUCE_CACHE_MAX = 64;

  #cloneResult(r: ReductionResult): ReductionResult {
    return {
      tree: new Map(r.tree),
      treeHash: r.treeHash,
      statuses: new Map(r.statuses),
      conflicts: r.conflicts.map((c) => ({ ...c })),
      autoDecisions: r.autoDecisions.map((a) => ({ ...a })),
      semanticConflicts: r.semanticConflicts.map((s) => ({ ...s })),
      headOps: [...r.headOps],
      synthBlobs: new Map(r.synthBlobs),
    };
  }

  async #reduceOpSet(ops: Operation[], includeStatuses: ViewQuery["includeStatuses"]): Promise<ReductionResult> {
    const evidence = this.#verifiedEvidence(await this.store.collect<Evidence>("evidence"));
    const decisions = await this.store.collect<Decision>("decision");

    // Redactions overwrite blob bytes while keeping the oid, so they don't change op
    // oids — include them in the signature so a redaction invalidates the cache.
    const redactions = await this.store.collect<Redaction>("redaction");
    const sig = sha256hex(
      [
        ops.map((o) => o.oid).sort().join(","),
        evidence.map((e) => e.oid).sort().join(","),
        decisions.map((d) => d.oid).sort().join(","),
        redactions.map((r) => r.oid).sort().join(","),
        // memberships affect authority-weighted decisions → invalidate on change
        (await this.store.collect<Membership>("membership")).map((m) => m.oid).sort().join(","),
        (await this.store.getRef("policy")) ?? "default",
        MATERIALIZER_VERSION,
        (includeStatuses ?? []).join("+"),
      ].join("|"),
    );
    const hit = this.#reduceCache.get(sig);
    if (hit) {
      this.metrics.inc("reduce.cache.hit");
      return this.#cloneResult(hit);
    }
    this.metrics.inc("reduce.cache.miss");

    const result = await this.metrics.time("reduce.ms", () =>
      this.#reduceOpSetUncached(ops, includeStatuses, evidence, decisions),
    );
    if (this.#reduceCache.size >= Repo.REDUCE_CACHE_MAX) {
      this.#reduceCache.delete(this.#reduceCache.keys().next().value as string);
    }
    this.#reduceCache.set(sig, result);
    return this.#cloneResult(result);
  }

  async #reduceOpSetUncached(
    ops: Operation[],
    includeStatuses: ViewQuery["includeStatuses"],
    evidence: Evidence[],
    decisions: Decision[],
  ): Promise<ReductionResult> {
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
    const authority = await this.#authorityMap();
    const base = { ops, evidence, decisions, intents, policy, materializeStatuses: includeStatuses, blobContent, reliability, authority };
    const pass1 = reduce(base);

    // Second-pass conflicts that the text-clean grouping accepted but that must be
    // held back (re-reduce excluding them so the tree stays safe — base content falls
    // back in automatically): (a) Phase-4 semantic contract breaks, and (b) the
    // cross-granularity determinism hole — a whole-file op concurrent with a symbol
    // edit on the same file (found by the determinism harness).
    const semantic = detectSemanticConflicts(ops, pass1, evidence, blobContent);
    const cross = detectCrossGranularity(ops, pass1);
    if (semantic.length === 0 && cross.length === 0) return pass1;

    const held = new Set<string>([...semantic.map((s) => s.breakingOp), ...cross.flatMap((c) => c.ops)]);
    const pass2 = reduce({ ...base, ops: ops.filter((o) => !held.has(o.oid as string)) });
    for (const s of semantic) {
      pass2.statuses.set(s.breakingOp, "needs_decision");
      for (const d of s.dependentOps) pass2.statuses.set(d, pass2.statuses.get(d) ?? "needs_decision");
    }
    for (const oid of cross.flatMap((c) => c.ops)) pass2.statuses.set(oid, "needs_decision");
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
    for (const c of cross) {
      pass2.conflicts.push({
        id: conflictIdFor(`file:${c.file}`),
        key: `file:${c.file}`,
        kind: "concurrent_write",
        reason: `whole-file write and symbol edit on ${c.file} are concurrent — can't both apply deterministically`,
        recommendedOp: null,
        options: c.ops.map((oid) => ({ opOid: oid, actor: "", purpose: "concurrent whole-file/symbol edit", evidence: [], score: 0, blocked: false, requiresHuman: false })),
      });
    }
    return pass2;
  }

  // ── git-like working tree (checkout / commit) ─────────────────────────────
  /** Read a working directory's files (relative paths → content), skipping .avcs/. */
  async #readWorkTree(workDir: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!existsSync(workDir)) return out;
    for (const ent of await readdir(workDir, { recursive: true, withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const rel = join(ent.parentPath ?? (ent as { path?: string }).path ?? workDir, ent.name).slice(workDir.length + 1);
      if (rel.startsWith(".avcs") || rel === ".avcs-workspace" || rel.startsWith(".git")) continue;
      out.set(rel.split("\\").join("/"), await readFile(join(workDir, rel), "utf8"));
    }
    return out;
  }

  /** Write a view's materialized files into `workDir` (alongside .avcs, like git). */
  async checkoutInto(workDir: string, view = "main"): Promise<string[]> {
    const res = await this.materialize(view);
    const written: string[] = [];
    for (const [path, blobOid] of res.tree) {
      const full = join(workDir, path);
      await mkdir(dirname(full), { recursive: true });
      const synth = res.synthBlobs.get(blobOid);
      await writeFile(full, synth !== undefined ? Buffer.from(synth, "utf8") : await this.readBlob(blobOid));
      written.push(path);
    }
    return written.sort();
  }

  /**
   * Commit a working tree: diff `workDir`'s files against the materialized view and
   * author put_file / delete_file ops for the changes (the git `add`+`commit` step,
   * which agents do via operation.propose). Causally builds on the current frontier.
   */
  async commitWorkingTree(
    workDir: string,
    opts: { message: string; actor: Actor; line?: string },
  ): Promise<{ ops: string[]; added: string[]; modified: string[]; removed: string[]; intent: string }> {
    const view = opts.line ?? "main";
    const res = await this.materialize(view);
    const current = new Map((await this.materializedFiles(res)).map((f) => [f.path, f.content]));
    const disk = await this.#readWorkTree(workDir);
    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];
    for (const [path, content] of disk) {
      if (!current.has(path)) added.push(path);
      else if (current.get(path) !== content) modified.push(path);
    }
    for (const path of current.keys()) if (!disk.has(path)) removed.push(path);

    const ops: string[] = [];
    if (!added.length && !modified.length && !removed.length) return { ops, added, modified, removed, intent: "" };

    const intent = await this.createIntent({ title: opts.message, owner: opts.actor.id });
    const sess = await this.startSession({ intentOid: intent, actor: opts.actor });
    const deps = res.headOps;
    for (const path of [...added, ...modified].sort()) {
      ops.push(await this.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: opts.actor, path, content: disk.get(path)!, declaredPurpose: opts.message, causalDeps: deps, line: opts.line }));
    }
    for (const path of removed.sort()) {
      ops.push(await this.proposeOperation({ sessionOid: sess, intentOid: intent, actor: opts.actor, target: { entityKind: "file", entityId: path }, body: { kind: "delete_file", path }, declaredPurpose: `delete ${path}`, causalDeps: deps, line: opts.line }));
    }
    return { ops, added: added.sort(), modified: modified.sort(), removed: removed.sort(), intent };
  }

  // ── backup / transfer (docs/10 WS-F) ──────────────────────────────────────
  /** Export the whole repo (all objects + refs) as a portable bundle for backup/transfer. */
  async exportBundle(): Promise<{ version: number; objects: AnyObject[]; refs: Record<string, string> }> {
    const objects: AnyObject[] = [];
    for await (const o of this.store.list()) objects.push(o);
    return { version: 1, objects, refs: Object.fromEntries(await this.store.listRefs()) };
  }

  /** Import a bundle into this repo (idempotent, content-addressed). Rebuilds the entity index. */
  async importBundle(bundle: { objects: AnyObject[]; refs?: Record<string, string> }): Promise<{ objects: number; refs: number }> {
    for (const o of bundle.objects) {
      const oid = await this.store.put(o);
      if (o.type === "operation") for (const k of keysOf(o as Operation)) await this.store.appendEntityIndex(k, oid);
    }
    let refs = 0;
    for (const [name, oid] of Object.entries(bundle.refs ?? {})) {
      if (await this.store.has(oid)) {
        await this.store.setRef(name, oid);
        refs++;
      }
    }
    return { objects: bundle.objects.length, refs };
  }

  /**
   * Materialize the state AT a given frontier: reduce only the causal closure of
   * `headOps`. The basis for time-travel — history, bisect, and diff-at-point all
   * reduce over a prefix instead of the whole graph. (Phase 9 / Phase 10)
   */
  async materializeAt(headOps: string[], includeStatuses: ViewQuery["includeStatuses"] = ["accepted"]): Promise<ReductionResult> {
    const allOps = await this.store.collect<Operation>("operation");
    const byId = new Map(allOps.map((o) => [o.oid as string, o]));
    const closure = new Set<string>();
    const stack = [...headOps];
    while (stack.length) {
      const id = stack.pop()!;
      if (closure.has(id)) continue;
      closure.add(id);
      for (const dep of byId.get(id)?.causalDeps ?? []) if (!closure.has(dep)) stack.push(dep);
    }
    return this.#reduceOpSet(allOps.filter((o) => closure.has(o.oid as string)), includeStatuses);
  }

  /**
   * History of one entity (file path or `<path>#<symbol>`) in causal order, via the
   * entity index — O(ops-on-that-entity), not a full-store scan. The basis for blame
   * and `log -p`. (Phase 9 / Phase 10)
   */
  async historyOf(entityKey: string): Promise<Operation[]> {
    const oids = await this.store.readEntityIndex(entityKey);
    const ops = await Promise.all(oids.map((o) => this.store.get<Operation>(o)));
    return ops.sort((a, b) => a.lamport - b.lamport || ((a.oid ?? "") < (b.oid ?? "") ? -1 : 1));
  }

  // ── observability (Phase 10) ────────────────────────────────────────────
  /**
   * Blame: who currently owns an entity and WHY — the accepted head op on its key,
   * with actor + intent + purpose. Stronger than git blame: the 'why' is first-class.
   */
  async blame(
    entityKey: string,
    line = "main",
  ): Promise<{ op: string; actor: Actor; purpose: string; intentTitle?: string; at: string } | null> {
    const res = await this.materialize(line);
    const hist = await this.historyOf(entityKey);
    const owner = [...hist].reverse().find((o) => res.statuses.get(o.oid as string) === "accepted");
    if (!owner) return null;
    const intent = await this.readIntent(owner.intentOid).catch(() => null);
    return {
      op: owner.oid as string,
      actor: owner.actor,
      purpose: owner.declaredPurpose,
      ...(intent ? { intentTitle: intent.title } : {}),
      at: owner.createdAt,
    };
  }

  /** `log -p` for one entity: each op with its before/after content reconstructed. */
  async logP(entityKey: string, filePath: string): Promise<{ op: string; purpose: string; before: string; after: string }[]> {
    const hist = await this.historyOf(entityKey);
    const out: { op: string; purpose: string; before: string; after: string }[] = [];
    const fileOf = async (heads: string[]) =>
      (await this.materializedFiles(await this.materializeAt(heads))).find((f) => f.path === filePath)?.content ?? "";
    for (const o of hist) {
      out.push({
        op: o.oid as string,
        purpose: o.declaredPurpose,
        before: await fileOf(o.causalDeps),
        after: await fileOf([o.oid as string]),
      });
    }
    return out;
  }

  /** Diff two views (or, with materializeAt, two frontiers). */
  async diff(viewA: string, viewB: string): Promise<import("../query/diff.ts").TreeDiff> {
    const { diffTrees } = await import("../query/diff.ts");
    return diffTrees(await this.materialize(viewA), await this.materialize(viewB));
  }

  /**
   * Bisect: find the first operation (between a known-good and known-bad frontier)
   * that makes `isBad` true. Deterministic — re-reduces at each step with no checkout.
   */
  async bisect(
    goodHeads: string[],
    badHeads: string[],
    isBad: (res: ReductionResult) => boolean | Promise<boolean>,
  ): Promise<string | null> {
    const allOps = await this.store.collect<Operation>("operation");
    const byId = new Map(allOps.map((o) => [o.oid as string, o]));
    const closure = (heads: string[]) => {
      const seen = new Set<string>();
      const stack = [...heads];
      while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const d of byId.get(id)?.causalDeps ?? []) if (!seen.has(d)) stack.push(d);
      }
      return seen;
    };
    const good = closure(goodHeads);
    const between = [...closure(badHeads)]
      .filter((id) => !good.has(id))
      .map((id) => byId.get(id)!)
      .sort((a, b) => a.lamport - b.lamport || ((a.oid ?? "") < (b.oid ?? "") ? -1 : 1));
    // smallest k in [0..n] such that good ∪ first-k-between is bad
    let lo = 0;
    let hi = between.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const heads = [...goodHeads, ...between.slice(0, mid).map((o) => o.oid as string)];
      if (await isBad(await this.materializeAt(heads))) hi = mid;
      else lo = mid + 1;
    }
    return lo > 0 && lo <= between.length ? (between[lo - 1]!.oid as string) : null;
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
      version?: string;
      supportStatus?: "supported" | "maintenance" | "eol";
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
      ...(opts.version ? { version: opts.version } : {}),
      ...(opts.supportStatus ? { supportStatus: opts.supportStatus } : {}),
      createdAt: new Date().toISOString(),
    };
    release.sig = this.#sign("release", release as unknown as Record<string, unknown>, opts.signWith);
    const oid = await this.store.put(release);
    await this.store.setRef(`release:${viewName}:latest`, oid);
    if (opts.version) await this.store.setRef(`release:${viewName}:${opts.version}`, oid);
    return { released: true, releaseOid: oid };
  }
}
