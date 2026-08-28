// High-level repository facade.
//
// This is the single API surface that the CLI, the demo, and the MCP server all
// call. It hides the object store and reducer behind verbs that map 1:1 onto the
// agent workflow: intent → session → propose op → attach evidence → materialize →
// decide → checkpoint.

import { mkdir, writeFile, rm, readdir, readFile, lstat, readlink, symlink, cp, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { Buffer } from "node:buffer";
import { ObjectStore } from "../store/objectStore.ts";
import { LamportClock } from "../core/clock.ts";
import { computeOid, sha256hex, canonicalize } from "../core/canonical.ts";
import { reduce, conflictIdFor, keysOf, detectFileConflicts, arbitrateFileConflicts, type ReductionResult, type ReduceInput } from "../reducer/reducer.ts";
import { reduceIncremental, snapshotReduce, NonIncrementalError, serializeSnapshot, deserializeSnapshot, type ReduceSnapshot } from "../reducer/incremental.ts";
import { encodeCbor, decodeCbor } from "../core/cbor.ts";
import { computeReliability } from "../policy/reliability.ts";
import type { OwnerRule } from "../objects/types.ts";
import { defaultPolicy, MATERIALIZER_VERSION } from "../reducer/policy.ts";
import {
  Keyring,
  generateKeypair,
  publicKeyFromPrivate,
  signMessage,
  type KeyRecord,
  type Signature,
} from "../core/identity.ts";
import {
  adoptionEnabled,
  assertKeyFilename,
  listMachineKeys,
  loadMachineKey,
  machineKeyPath,
  machineKeystoreDir,
  readKeyFile,
  saveMachineKey,
  type KeyFile,
} from "./keystore.ts";
import { checkLease, isActive, scopesOverlap, type LeaseConflict } from "../concurrency/lease.ts";
import { isBinary } from "../core/bytes.ts";
import { lcsLineLength } from "../merge/merge3.ts";
import { Metrics } from "../observe/metrics.ts";
import { silentLogger, type Logger } from "../observe/logger.ts";
import type {
  Actor,
  AnyObject,
  Approval,
  Blob,
  Checkpoint,
  Decision,
  Evidence,
  EvidenceKind,
  EvidenceResult,
  Integration,
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
  Undo,
  View,
  ViewQuery,
  WorkLease,
} from "../objects/types.ts";

/**
 * Phase 14 (docs/17 §14.2): the four-way contract of `submitIntegration`. There is no
 * "pull and redo" outcome by design — ops are append-only, so no work is ever redone:
 *  - advanced       — the head moved to an integrated checkpoint containing your work
 *  - conflict       — a minimal repair packet (the ONLY human/agent decision point)
 *  - needs_evidence — run validation ONCE against the integrated tree, resubmit the ticket
 *  - queued         — another ticket holds the needs_evidence reservation; retry later
 *  - rejected       — a hard gate (role/approvals/causal-incompleteness) refused it
 */
export type IntegrationResult =
  | { verdict: "advanced"; head: string; integration: string }
  | { verdict: "conflict"; packet: ConflictPacket; integration: string }
  | { verdict: "needs_evidence"; integratedCheckpoint: string; treeHash: string; requiredChecks: EvidenceKind[]; missingLocally: string[]; ticketId: string; integration: string }
  | { verdict: "rejected"; reason: string }
  | { verdict: "queued"; behindTicket: string; retryAfterMs: number };

/** The minimal repair packet a `conflict` verdict carries (docs/17 §14.2 step 5):
 *  per-key counterpart ops + prior human rulings on the same key (decision memory), so
 *  an agent can prepare a precedent-based decision proposal without re-reading the repo. */
export interface ConflictPacket {
  conflicts: {
    key: string;
    reason: string;
    /** The contending ops on this key (oid + who/why), for a targeted repair. */
    options: { op: string; actor: string; purpose: string }[];
    /** Overlapping line regions when this is a text-merge conflict (merge3 shape). */
    regions?: import("../merge/merge3.ts").ConflictRegion[];
    /** Prior rulings on the same key — reuse instead of re-litigating (docs/17 §14.2). */
    priorDecisions: { reason: string; futurePolicy?: string; decidedBy: string }[];
  }[];
}

/** The persisted needs_evidence reservation (`.avcs/queue/<view>.json`, docs/17 §14.3):
 *  survives a hub restart so an in-flight ticket keeps its slot until the TTL. */
interface IntegrationReservation {
  ticketId: string;
  submittedCheckpoint: string;
  integratedCheckpoint: string;
  treeHash: string;
  requiredChecks: EvidenceKind[];
  by: string;
  expiresAt: string;
}

/**
 * How AVCS history relates to a co-located git repo (docs/14). The git tree git tracks
 * is always the materialized *projection* — a derived artifact AVCS can recompute. What
 * differs by mode is whether the rich `.avcs/` history travels with it:
 *
 *  - `sidecar`  (default): `.avcs/` is fully git-ignored. git sees ONLY the clean
 *               projection, so a single developer adopts AVCS locally with zero team
 *               friction — no team decision required. History stays local (or syncs via
 *               the hub between adopters).
 *  - `committed`: `.avcs/objects` + `refs` are committed alongside the projection, so the
 *               full intent/decision history travels via `git push`. This is a team-wide
 *               adoption decision; flip to it with `setGitMode("committed")` once agreed.
 */
export type GitMode = "sidecar" | "committed";

/** The trunk branch assumed when `.avcs/config.json` records none (docs/20 §3.1). */
export const DEFAULT_TRUNK = "main";
/**
 * The branch names that count as trunk when none is configured. The pre-trunk bridge
 * special-cased exactly this pair, so keeping both is what makes an unconfigured repository
 * — including a `master`-default one — behave as it always did (docs/20 W7).
 */
export const LEGACY_TRUNK_BRANCHES = ["main", "master"] as const;

/**
 * A named hub URL persisted in `.avcs/remotes.json` (Phase 13.1). Per-replica
 * configuration — an aux file, never an object, never gossiped. `autoSync` +
 * `freshnessMs` are read by the live-convergence layer (Phase 15): a materialize
 * older than the freshness window fires a background sync.
 */
export interface RemoteConfig {
  url: string;
  autoSync?: boolean;
  freshnessMs?: number;
}

/**
 * One shared build-environment path (docs/21 §3.1), persisted in `.avcs/shared-paths.json`.
 *
 * The core treats `path` as a PATH RULE and nothing else — it does not know that
 * `node_modules` is a dependency tree, or that `pnpm-lock.yaml` is a lockfile, exactly as
 * `.avcsignore` (#10) knows nothing about what it excludes. That ignorance is docs/16 §2-2,
 * and it is what keeps the core out of every build ecosystem.
 *
 *  - `path`    — relative to the projection root, forward slashes, no `..`, not absolute.
 *  - `keyFrom` — the files whose PROJECTED content derives the cache key (§3.2). This is the
 *                declarative answer to docs/16 §10 question 1 ("who names the shared key"):
 *                the user declares *which files decide the environment*, and the core only
 *                hashes their content, never reads their meaning. `[]` means one cache for
 *                every workspace — allowed, because the user said so, and warned about.
 *  - `mode`    — `symlink` (default, cost 0) or `copy` for toolchains that refuse a symlinked
 *                dependency tree (§R1). `copy` is the DANGEROUS one for capture: it puts a
 *                real directory in the tree, so the ignore composition (§3.5) is its only
 *                defence.
 */
export interface SharedPathEntry {
  path: string;
  keyFrom?: string[];
  mode?: SharedPathMode;
}

export type SharedPathMode = "symlink" | "copy";

/**
 * What {@link Repo.linkSharedPaths} did for one entry (docs/21 §3.4).
 *
 * `populated` — whether the cache directory is non-empty — is the WHOLE interface for "does
 * this need an install?". The core creates the place and connects it; filling it belongs to
 * the caller (human/agent/CI). The moment the core knew how to install anything, docs/21 §2
 * principle 2 would be broken, so there is deliberately no hook, no command template and no
 * package-manager guess anywhere near this type.
 */
export interface SharedPathLink {
  path: string;
  key: string;
  /** Absolute path of the store-local cache directory (`<store>/shared/<key>/<slug>`). */
  cache: string;
  /** Absolute path inside the projection that should resolve to `cache`. */
  target: string;
  mode: SharedPathMode;
  /** Whether the projection now reaches the cache (false ⇒ `warning` says why not). */
  linked: boolean;
  /** Cache directory is non-empty. The caller's only signal for "an install is needed". */
  populated: boolean;
  warning?: string;
}

/** The `.avcs/shared-paths.json` aux file (docs/21 §3.1). Not an object: never gossiped. */
interface SharedPathsFile {
  version: number;
  shared: SharedPathEntry[];
}

/**
 * Early conflict warning for one contended entity key (Phase 15.3, docs/17 §15.3).
 * `theirs` are operations by OTHER actors that (a) are outside the caller's causal
 * closure — concurrent work the caller has not built on, (b) have not been rejected by
 * a decision, and (c) have not been built upon by any later op on the same key (i.e.
 * not superseded). `leaseHolders` are other actors holding an active lease whose scope
 * overlaps the key. Leases gossip as ordinary objects, so combined with the sync-watch
 * daemon this warning works ACROSS machines, not just across local processes.
 */
export interface ContentionWarning {
  key: string;
  /** `line` is populated for an `acrossLines` check, so the caller can name the branch. */
  theirs: { op: string; actor: string; lamport: number; purpose: string; createdAt: string; line?: string }[];
  leaseHolders: { actor: string; leaseOid: string; scope: string; expiresAt: string }[];
}

/**
 * What one {@link Repo.undo} call did (issue #91).
 *
 * `excluded` is what THIS call dropped from the view; `alreadyExcluded` is what a previous
 * undo had already dropped — reported rather than refused, so running undo twice converges
 * instead of erroring. `purged` are the blobs whose bytes were evicted, `retained` the
 * target blobs a still-selected op keeps alive (content-addressing means identical content
 * is one blob, so this is the normal, not the exotic, case).
 */
export interface UndoResult {
  /** The authored {@link Undo} record, or null when the call was a no-op. */
  undoOid: string | null;
  view: string;
  excluded: string[];
  alreadyExcluded: string[];
  purged: string[];
  retained: string[];
}

// Sidecar: ignore EVERYTHING under .avcs/ (the `*` also ignores this file itself), so the
// directory contributes nothing to git — the team's git history is untouched by AVCS.
const GITIGNORE_SIDECAR = `# AVCS — sidecar mode (default).
# AVCS history stays LOCAL; git tracks only the materialized projection, so adopting
# AVCS needs no team decision. To commit the history team-wide once agreed, run:
#   avcs git-mode committed
*
`;

// Committed: track objects/refs/HEAD/config; ignore only rebuildable caches & local locks.
// objects/ is immutable & content-addressed (distinct filenames ⇒ git unions cleanly).
const GITIGNORE_COMMITTED = `# AVCS — committed mode.
# objects/ and refs/ travel with the repo via git; only rebuildable caches & local
# working state are ignored (regenerated by \`avcs reindex\` / lazy backfill).
/indexes/
/snapshot/
/locks/
/packs/
/private/
/oplog
/objlog
/pending/
/shared/
*.lock
*.tmp*
`;

/** The committed-mode ignore entry for the shared-path cache tree (docs/21 §3.3). */
const SHARED_IGNORE_LINE = "/shared/";

/** Which of the two private keystores a key lives in (issue #98). `"repo"` is the
 *  per-checkout override, `"machine"` the default shared by every repo on the box. */
export type KeyScope = "repo" | "machine";

/** The actor kind an id implies, by the `kind:name` convention the CLI already uses. Key
 *  files written before #98 carry no kind, and `actorKind` is stored on a trust record but
 *  never consulted by a trust check (only `actorId` is), so a guess here cannot grant
 *  authority — it only keeps the record readable. */
export function kindOfActorId(id: string): Actor["kind"] {
  return id.startsWith("human:") ? "human" : id.startsWith("ci:") ? "ci_bot" : "ai_agent";
}

export class Repo {
  readonly dir: string;
  readonly store: ObjectStore;
  readonly keyring = new Keyring();
  readonly metrics = new Metrics();
  /**
   * One-line notices about the machine keystore (issue #98) — a key adopted out of a
   * repo-local store, or a repo-local key that differs from the machine one. Collected on
   * the instance rather than printed from here so the CLI/MCP decide how to surface them,
   * and so a test can assert the user was told without parsing stdout. Never contains key
   * material.
   */
  readonly keystoreNotices: string[] = [];
  /** Structured logger (silent by default; CLI/hub/MCP wire a console/OTel sink). */
  logger: Logger = silentLogger();
  #clock = new LamportClock();
  // Warm in-memory caches (docs/11 A6). Operations are tailed from the append-only op-log
  // (so a +1op materialize reads one new object, not every shard); blobs are content-
  // addressed and immutable except via redaction, so they cache by oid. Both are pure
  // optimizations over disk — correctness never depends on them, and they are cleared on
  // the rare mutations that can invalidate them (gc deletes; redaction overwrites bytes).
  #opCache = new Map<string, Operation>();
  #blobCache = new Map<string, Buffer>();
  // Last full reduction's snapshot, for incremental reduce (docs/11 A6b — DEFAULT ON since
  // Phase 13.3). Only the main materialize path updates it; reduceIncremental is correct for
  // ANY append-superset (harness-proven) and throws NonIncrementalError otherwise (→ fall
  // back to full reduce), so no filter key is needed. Opt OUT via AVCS_INCREMENTAL=0;
  // AVCS_VERIFY_INCREMENTAL=1 cross-checks every incremental result against a full reduce
  // (run as a dedicated CI job, not recommended on the hot path).
  #incSnap: ReduceSnapshot | null = null;
  #forceSnapshot = false; // set by compact() to capture a snapshot even when opted out
  // Op count of the last PERSISTED base per view (Phase 13.3 amortized auto-compaction):
  // once the live snapshot is ≥ AUTO_COMPACT_DELTA ops past it, materialize re-persists.
  #persistedBaseOps = new Map<string, number>();
  static readonly AUTO_COMPACT_DELTA = 256;

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
    const pol = await this.policy();
    const evidence = this.#verifiedEvidence(
      await this.store.collect<Evidence>("evidence"),
      pol.requireSignedEvidence === true,
    ).kept;
    const decisions = this.#verifiedDecisions(
      await this.store.collect<Decision>("decision"),
      pol.requireSignedDecisions === true,
    ).kept;
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

  // ── local private keystore (issue #15 Layer 2 / B2; machine-scoped since #98) ──────
  // Public keys live in `keys/` (trusted, shared, gossiped WITH the repo). PRIVATE keys
  // are never shared and never committed. The MCP server loads them to sign a decision on
  // the owner's behalf AFTER an elicitation confirmation, so an agent (which never sees
  // the key) cannot forge a human decision.
  //
  // There are TWO sources, read in this order (issue #98):
  //
  //   1. `<store>/private/` — repo-local. An OVERRIDE, for the deliberate case: a checkout
  //      that must sign as a different actor (a CI checkout, a second identity). Read first
  //      so every repo holding a key today keeps working byte-identically.
  //   2. the machine keystore (`~/.avcs/private/`, see ./keystore.ts) — the default. An
  //      actor identity belongs to a person and a machine, not to a checkout, which is what
  //      `key ls`'s "signable on this machine" always claimed.
  //
  // The repo-local directory stays gitignored in both modes (sidecar ignores all of .avcs/,
  // committed lists /private/ explicitly) — but a key that was never in the repo does not
  // need that line to hold, which is the point of moving the default out.
  #privateKeysDir(): string {
    return join(this.store.root, "private");
  }
  /**
   * Persist an actor's PRIVATE key, perms 0600.
   *
   * Defaults to the MACHINE keystore (issue #98): `key provision` mints an identity for a
   * person on a box, not for a checkout. `scope: "repo"` writes the repo-local override
   * instead — that is what `clone --key` uses, so importing a credential for one repo does
   * not silently install it machine-wide.
   */
  async saveLocalKey(actorId: string, privateKey: string, opts?: { scope?: KeyScope; actorKind?: Actor["kind"] }): Promise<void> {
    assertKeyFilename(actorId);
    const rec: KeyFile = { actorId, privateKey, ...(opts?.actorKind ? { actorKind: opts.actorKind } : {}) };
    if ((opts?.scope ?? "machine") === "machine") {
      await saveMachineKey(rec);
      return;
    }
    await mkdir(this.#privateKeysDir(), { recursive: true, mode: 0o700 });
    const p = join(this.#privateKeysDir(), `${actorId}.json`);
    await writeFile(p, JSON.stringify(rec), { encoding: "utf8", mode: 0o600 });
    await chmod(p, 0o600); // writeFile's mode applies only on create; rotation must not leave it looser
  }
  #note(msg: string): void {
    if (!this.keystoreNotices.includes(msg)) this.keystoreNotices.push(msg);
  }
  /**
   * Adopt an existing private key into THIS repo's keystore (issue #58).
   *
   * `clone` is the command that creates a repo, so a freshly init'd directory holds no key
   * and cannot sign the first read — which makes a private repository unreachable on a hub
   * that gates reads. The credential therefore has to come from outside, and be left behind
   * afterwards: a clone that worked once and whose later `sync` then 401s just moves the
   * problem somewhere less obvious.
   *
   * `source` is either a key file (the shape `saveLocalKey` writes) or a repo directory to
   * take one from. An ambiguous directory names the choice rather than picking silently —
   * signing as the wrong actor is worse than a stop, because the wrong identity ends up in
   * history where it cannot be quietly corrected.
   *
   * Defaults to `scope: "repo"` (issue #98): `clone --key` says "THIS repo signs as this
   * actor", and installing a credential machine-wide as a side effect of a clone flag would
   * be a surprising write to a shared resource that could also shadow the machine's default
   * identity. `avcs key import` passes `scope: "machine"` when that IS what the user asked
   * for. Either way the public half is registered as trusted here, or the import would leave
   * the actor able to sign and unable to be believed (issue #96).
   */
  async importLocalKey(source: string, actorId?: string, opts?: { scope?: KeyScope }): Promise<string> {
    const { readdir: rd } = await import("node:fs/promises");
    let file = source;
    const asRepoRoot = existsSync(join(ObjectStore.resolveStoreDir(source), "private"))
      ? join(ObjectStore.resolveStoreDir(source), "private")
      : existsSync(join(source, "private")) && existsSync(join(source, "objects"))
        ? join(source, "private")
        : null;
    if (asRepoRoot) {
      const held = (await rd(asRepoRoot)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
      if (held.length === 0) throw new Error(`no private key found in ${source}`);
      if (!actorId && held.length > 1) {
        throw new Error(`${source} holds ${held.length} keys (${held.join(", ")}) — say which one to import`);
      }
      const pick = actorId ?? held[0]!;
      if (!held.includes(pick)) throw new Error(`no private key for ${pick} in ${source}`);
      file = join(asRepoRoot, `${pick}.json`);
    }
    if (!existsSync(file)) throw new Error(`no such key file: ${file}`);
    let parsed: { actorId?: unknown; privateKey?: unknown; actorKind?: Actor["kind"] };
    try {
      parsed = JSON.parse(await readFile(file, "utf8")) as typeof parsed;
    } catch {
      throw new Error(`key file is not valid JSON: ${file}`);
    }
    const id = typeof parsed.actorId === "string" ? parsed.actorId : actorId;
    if (!id || typeof parsed.privateKey !== "string") {
      throw new Error(`not an avcs key file (expected { actorId, privateKey }): ${file}`);
    }
    const kind = kindOfActorId(id);
    await this.saveLocalKey(id, parsed.privateKey, { scope: opts?.scope ?? "repo", actorKind: parsed.actorKind ?? kind });
    // …and register the PUBLIC half as trusted (issue #96). Persisting only the private
    // half left the actor `signable 1 / trusted 0`: it could sign, and nothing it signed
    // was honored. The holder of a private key can already sign anything, so trusting the
    // key they explicitly handed over adds no authority — it just stops the import from
    // being useless.
    await this.#trustPrivateKeyOwner(id, parsed.privateKey, parsed.actorKind ?? kind);
    return id;
  }

  /**
   * Register the public half of a locally-held private key as trusted by this repo.
   *
   * The private half is machine-scoped; the trusted public record is per-repo (it is
   * gossiped with the repo). So a repo created AFTER the identity holds the key but does
   * not yet trust it, and nothing it signs is honored. Idempotent, and it never overwrites
   * a different public key already recorded for the id — a trust record is an assertion
   * other replicas may already have acted on.
   */
  async #trustPrivateKeyOwner(actorId: string, privateKey: string, actorKind: Actor["kind"]): Promise<void> {
    let publicKey: string;
    try {
      publicKey = publicKeyFromPrivate(privateKey);
    } catch {
      return; // not an ed25519 PEM (a test fixture, a placeholder) — nothing to trust
    }
    const existing = await this.#readTrustedRecord(actorId);
    if (existing) {
      if (existing.publicKey.trim() !== publicKey.trim()) {
        this.#note(`${actorId}: this repo already trusts a DIFFERENT public key for this actor — left as is; the local private key will not verify here`);
      }
      return;
    }
    await this.registerPublicKey({ keyId: actorId, publicKey, actorId, actorKind });
  }
  /** The trusted public-key record this repo holds for `keyId`, read from disk — the
   *  in-memory keyring is only warmed by `Repo.open`, and `Repo.init` skips it. */
  async #readTrustedRecord(keyId: string): Promise<KeyRecord | null> {
    const p = join(this.#keysDir(), `${keyId}.json`);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(await readFile(p, "utf8")) as KeyRecord;
    } catch {
      return null;
    }
  }

  /**
   * Actor ids this machine holds a PRIVATE key for — i.e. who it can sign as. Merged over
   * both sources (issue #98). Returns ids only: the key material must never travel with a
   * listing, or `key ls` becomes the disclosure it is meant to help avoid.
   */
  async listLocalKeys(): Promise<string[]> {
    return (await this.listLocalKeySources()).map((k) => k.actorId);
  }

  /**
   * The same listing, saying WHICH keystore each key would be read from — the winner under
   * repo → machine precedence. `key ls` needs this to stay honest: "signable on this
   * machine" and "signable only in this checkout" are different facts, and a user with a
   * repo override needs to be able to see it.
   *
   * `shadowed` marks a repo-local key that is hiding a machine key for the same actor id.
   * Present only when true, so an entry that shadows nothing keeps the plain shape. Without
   * it a listing cannot tell "this key exists only in this checkout" apart from "this
   * checkout is overriding your machine identity" — and after the #98 migration adopts a
   * key, every repo-local entry is the second kind.
   */
  async listLocalKeySources(): Promise<{ actorId: string; source: KeyScope; shadowed?: true }[]> {
    const repoIds = await this.#listKeyDir(this.#privateKeysDir());
    const machineIds = new Set(await listMachineKeys());
    const by = new Map<string, KeyScope>();
    for (const id of machineIds) by.set(id, "machine");
    for (const id of repoIds) by.set(id, "repo"); // repo wins, matching #findLocalKey
    return [...by.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([actorId, source]) => ({ actorId, source, ...(source === "repo" && machineIds.has(actorId) ? { shadowed: true as const } : {}) }));
  }
  async #listKeyDir(dir: string): Promise<string[]> {
    if (!existsSync(dir)) return [];
    try {
      return (await readdir(dir)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
    } catch {
      return [];
    }
  }

  /** Public keys this REPO trusts (shared/gossiped) — a different question from which
   *  keys this machine can sign with. Returns actor ids only. */
  async listTrustedKeys(): Promise<string[]> {
    const dir = join(this.store.root, "keys");
    if (!existsSync(dir)) return [];
    const { readdir } = await import("node:fs/promises");
    return (await readdir(dir))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  }

  /**
   * Mint a signing key for `actor` unless one is already held (issue #51).
   *
   * Idempotent on purpose: re-provisioning would orphan the previous key while any
   * signature already made with it stays in history, so a caller who runs this twice must
   * not silently lose the ability to be recognised as themselves.
   */
  async ensureOwnerKey(actor: Actor, keyId = actor.id): Promise<{ keyId: string; created: boolean }> {
    const held = await this.loadLocalKey(actor.id);
    if (held) {
      // The private half is machine-scoped now, the trusted public record is per-repo — so a
      // repo created after the identity holds the key but does not yet trust it, and every
      // signature it makes here is dropped by the trust gate. Register it, which is what the
      // user means by "provision me here". Still idempotent: no new key is minted.
      await this.#trustPrivateKeyOwner(actor.id, held, actor.kind);
      return { keyId, created: false };
    }
    return { keyId: await this.provisionOwnerKey(actor, keyId), created: true };
  }

  /**
   * Load a locally-held private key for `actorId`, or null if neither keystore holds one.
   *
   * Repo-local override first, then the machine keystore (issue #98). A key found ONLY in a
   * repo-local store is also ADOPTED into the machine keystore here — that is the migration:
   * every repo holding a key today keeps signing with exactly that key (precedence), and the
   * identity becomes usable in the next repo the user creates without a second provision.
   */
  async loadLocalKey(actorId: string): Promise<string | null> {
    const found = await this.#findLocalKey(actorId);
    if (!found) return null;
    if (found.source === "repo") await this.#adoptIntoMachineKeystore(actorId, found.privateKey);
    return found.privateKey;
  }

  /** Where a private key for `actorId` comes from, repo-local first. */
  async #findLocalKey(actorId: string): Promise<{ privateKey: string; source: KeyScope } | null> {
    try {
      assertKeyFilename(actorId);
    } catch {
      return null; // an id that cannot name a file has no key, rather than throwing on a read
    }
    const repoKey = await readKeyFile(join(this.#privateKeysDir(), `${actorId}.json`));
    if (repoKey) return { privateKey: repoKey.privateKey, source: "repo" };
    const machine = await loadMachineKey(actorId);
    return machine ? { privateKey: machine, source: "machine" } : null;
  }

  /**
   * Copy a repo-local key into the machine keystore, once, and say so (issue #98 migration).
   *
   * The conflicting case is the one that matters: if the machine keystore already holds a
   * DIFFERENT key for the same actor id, do nothing but warn.
   *   - Overwriting would destroy a credential whose signatures already exist in history and
   *     cannot be re-made — the same reason `ensureOwnerKey` is idempotent.
   *   - Erroring would break a repo that works today, for a migration the user did not ask
   *     for at this moment.
   *   - Keeping both costs nothing: repo → machine precedence means this repo goes on signing
   *     with exactly the key it signed with before, and the user is told there are two so
   *     they can reconcile deliberately.
   */
  async #adoptIntoMachineKeystore(actorId: string, privateKey: string): Promise<void> {
    if (!adoptionEnabled()) return;
    const existing = await loadMachineKey(actorId);
    if (existing === privateKey) return; // already adopted
    if (existing) {
      this.#note(
        `${actorId}: this checkout holds a private key that differs from the one in the machine keystore ` +
          `(${machineKeystoreDir()}) — keeping both; this repo keeps signing with its own. Remove one to reconcile.`,
      );
      return;
    }
    const kind = (await readKeyFile(join(this.#privateKeysDir(), `${actorId}.json`)))?.actorKind ?? kindOfActorId(actorId);
    try {
      await saveMachineKey({ actorId, privateKey, actorKind: kind });
    } catch (e) {
      // Adoption is a convenience on a READ path: `loadLocalKey` is what `#resolveHubSigner`
      // and the MCP decision signer call. A read-only home, a full disk or an odd
      // $XDG_CONFIG_HOME must not take away a repo's ability to sign with the key it already
      // has — that would turn a migration into an outage.
      this.#note(`${actorId}: could not adopt this checkout's key into the machine keystore (${(e as Error).message}); this repo still signs with its own copy`);
      return;
    }
    this.#note(
      `${actorId}: private key adopted from this checkout into the machine keystore (${machineKeyPath(actorId)}); ` +
        `other repos on this machine can now sign as ${actorId}. The copy in this repo still takes precedence.`,
    );
  }
  /**
   * Resolve the local actor key used to authenticate hub writes (SSH-style transport auth):
   * the avcs analogue of ssh picking `~/.ssh/id_*`. Resolution order, first hit wins:
   *   1. an explicit actorId (CLI `--as`),
   *   2. the `AVCS_ACTOR` env var,
   *   3. `actorId` in `.avcs/config.json`,
   *   4. the sole key across both keystores — repo-local override, then the machine
   *      keystore (issue #98) — as the unambiguous default identity.
   * Returns undefined when no local key resolves — an unsigned write still succeeds against
   * a no-auth/read-public hub, so signing is opt-in by having a key, not mandatory.
   */
  async #resolveHubSigner(explicitActorId?: string): Promise<{ keyId: string; privateKey: string } | undefined> {
    const actorId = await this.localActorId(explicitActorId);
    if (!actorId) return undefined;
    const privateKey = await this.loadLocalKey(actorId);
    return privateKey ? { keyId: actorId, privateKey } : undefined;
  }

  /** The replica's local actor identity, resolved by the same order #resolveHubSigner
   *  uses (explicit → AVCS_ACTOR → config.json → sole private key) but WITHOUT requiring
   *  a private key to exist — a contention check (Phase 15.3) needs a perspective, not a
   *  credential. Returns undefined when nothing resolves. */
  async localActorId(explicitActorId?: string): Promise<string | undefined> {
    let actorId = explicitActorId ?? process.env.AVCS_ACTOR;
    if (!actorId) {
      const cfg = await this.#readConfig();
      if (typeof cfg.actorId === "string") actorId = cfg.actorId;
    }
    if (!actorId) {
      // The sole key across BOTH keystores (issue #98) — so a repo freshly `init`'d on a
      // machine that already holds one identity resolves it without any configuration.
      const held = await this.listLocalKeySources();
      if (held.length === 1) actorId = held[0]!.actorId;
    }
    return actorId;
  }
  /**
   * Provision an owner key: mint a keypair, register the public half as trusted, and
   * store the private half in the LOCAL keystore so the MCP server can sign the
   * owner's elicitation-confirmed decisions (issue #15). Returns the keyId.
   */
  async provisionOwnerKey(actor: Actor, keyId = actor.id): Promise<string> {
    const { privateKey } = await this.generateActorKey(actor, keyId);
    // Machine scope (issue #98): `key provision` mints an identity for a person on a box.
    // The public half is registered as trusted in THIS repo by `generateActorKey`, because
    // trust is a per-repo, gossiped assertion; only the secret is machine-wide.
    await this.saveLocalKey(actor.id, privateKey, { scope: "machine", actorKind: actor.kind });
    return keyId;
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
    const cached = this.#blobCache.get(oid);
    if (cached) return cached;
    const blob = await this.store.get<Blob>(oid);
    const buf = blob.chunked && blob.chunks
      ? Buffer.concat(await Promise.all(blob.chunks.map((c) => this.readBlob(c))))
      : Buffer.from(blob.data, "base64");
    this.#blobCache.set(oid, buf);
    return buf;
  }

  /**
   * All operations, tailed from the op-log (docs/11 A6): read only oids not already in
   * the warm cache, in first-write order. Replaces a full `collect("operation")` shard
   * scan on every materialize — a +1op materialize touches one new object file. Tolerates
   * op-log entries whose object was GC'd (skips them; the store is the source of truth)
   * and backfills the log for a store created before A5.
   */
  async #allOpsTailed(): Promise<Operation[]> {
    let log = await this.store.readOpLog();
    if (log.length === 0) {
      // Pre-A5 store (no log yet) — scan once, backfill the log, warm the cache.
      const scanned = await this.store.collect<Operation>("operation");
      if (scanned.length === 0) return [];
      await this.store.rebuildOpLog();
      for (const o of scanned) this.#opCache.set(o.oid as string, o);
      log = await this.store.readOpLog();
    }
    const ops: Operation[] = [];
    for (const oid of log) {
      let op = this.#opCache.get(oid);
      if (!op) {
        if (!(await this.store.has(oid))) continue; // GC'd since logged — skip
        op = await this.store.get<Operation>(oid);
        this.#opCache.set(oid, op);
      }
      ops.push(op);
    }
    return ops;
  }

  /** Highest Lamport timestamp visible in the op-log (0 when empty) — the reseed source
   *  for multi-process authoring (Phase 13.2). Reads through the warm op cache. */
  async #maxLamportSeen(): Promise<number> {
    let max = 0;
    for (const op of await this.#allOpsTailed()) max = Math.max(max, op.lamport);
    return max;
  }

  /** Observe an imported history's max lamport (Phase 13.2 observe-on-import): after a
   *  pull, locally issued lamports must sort after everything just imported. No-op when
   *  our clock is already ahead. */
  #observeImported(maxLamport: number): void {
    if (maxLamport > this.#clock.value) this.#clock.observe(maxLamport);
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
    workspace?: string;
    derivedFrom?: string;
    revertOf?: string;
    coAuthors?: Actor[];
    private?: boolean;
    signWith?: { keyId: string; privateKey: string };
    /** Phase 15.3: after authoring, run a contention check on the op's keys and emit
     *  structured-log warnings + a metric. Additive only — the return type is unchanged
     *  (surfaces that want the warnings themselves call {@link contention} directly). */
    warnContention?: boolean;
    /** Make that check cross-line (see {@link contention}'s `acrossLines`). The capture
     *  path uses this: the git bridge puts every parallel session on its own line, so a
     *  line-scoped check is structurally blind to them. */
    contentionAcrossLines?: boolean;
    /** Receive the warnings the check produced, so a caller can surface them to a human
     *  without re-running the scan. Called only when `warnContention` is set. */
    onContention?: (warnings: ContentionWarning[]) => void;
  }): Promise<string> {
    // Multi-process reseed (Phase 13.2): two processes sharing one .avcs (e.g. CLI + MCP)
    // each hold their own in-memory clock, so both could issue the same lamport. Before
    // stamping, re-observe the highest lamport visible in the op-log tail (cached ops —
    // the log is the choke point every op enters through, whatever the process). This
    // improves ordering QUALITY only; correctness never depended on it (the reducer
    // tie-breaks by (lamport, oid), which is total regardless).
    const maxSeen = await this.#maxLamportSeen();
    const lamport = maxSeen >= this.#clock.value ? this.#clock.observe(maxSeen) : this.#clock.tick();
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
      lamport,
      createdAt: new Date().toISOString(),
      confidence: args.confidence,
      // Only store `line` when it is non-default, so existing (line-less) repos and
      // their oids stay byte-identical — backward compatibility with "main".
      ...(args.line && args.line !== "main" ? { line: args.line } : {}),
      ...(args.workspace ? { workspace: args.workspace } : {}),
      ...(args.derivedFrom ? { derivedFrom: args.derivedFrom } : {}),
      ...(args.revertOf ? { revertOf: args.revertOf } : {}),
      ...(args.coAuthors && args.coAuthors.length ? { coAuthors: args.coAuthors } : {}),
      ...(args.private ? { private: true } : {}),
    };
    op.sig = this.#sign("operation", op as unknown as Record<string, unknown>, args.signWith);
    const oid = await this.store.put(op);
    // Maintain the entity index (Phase 9): key → op oids for fast history/blame.
    for (const key of keysOf({ ...op, oid })) await this.store.appendEntityIndex(key, oid);
    if (args.warnContention) {
      const warnings = await this.contention({
        keys: [...keysOf({ ...op, oid })],
        actorId: op.actor.id,
        line: args.line,
        ...(args.contentionAcrossLines ? { acrossLines: true } : {}),
      });
      for (const w of warnings) {
        this.metrics.inc("contention.warnings");
        this.logger.warn("contention.warn", {
          key: w.key,
          op: oid,
          // `@line` appears only for a cross-line check (that is when `line` is populated).
          theirs: w.theirs.map((t) => `${t.actor}${t.line ? `@${t.line}` : ""}:${t.op.slice(0, 16)}`),
          leaseHolders: w.leaseHolders.map((l) => l.actor),
        });
      }
      args.onContention?.(warnings);
    }
    return oid;
  }

  /** Convenience: write file content as a blob + a put_file operation. */
  async proposeFileWrite(args: {
    sessionOid: string;
    intentOid: string;
    actor: Actor;
    path: string;
    content: string | Uint8Array;
    declaredPurpose: string;
    causalDeps?: string[];
    effects?: Operation["effects"];
    line?: string;
    workspace?: string;
    signWith?: { keyId: string; privateKey: string };
    warnContention?: boolean;
    contentionAcrossLines?: boolean;
    onContention?: (warnings: ContentionWarning[]) => void;
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
      workspace: args.workspace,
      signWith: args.signWith,
      warnContention: args.warnContention,
      contentionAcrossLines: args.contentionAcrossLines,
      onContention: args.onContention,
    });
  }

  /**
   * Language-neutral edit (docs/15): submit the FULL new content of a file together with
   * the base content it was derived from. Concurrent edit_file ops on the same file are
   * 3-way line-merged at materialization — disjoint hunks auto-merge, overlapping hunks
   * surface as a Conflict. No code-structure awareness: works for any text/language.
   *
   * `baseBlobOid`/`baseText` is the 3-way merge base (what the agent read before editing);
   * normally the content established by the causally-prior op. Omit ⇒ base is empty.
   */
  async proposeEdit(args: {
    sessionOid: string;
    intentOid: string;
    actor: Actor;
    path: string;
    newText: string;
    baseText?: string;
    baseBlobOid?: string;
    declaredPurpose: string;
    causalDeps?: string[];
    effects?: Operation["effects"];
    line?: string;
    workspace?: string;
    signWith?: { keyId: string; privateKey: string };
    warnContention?: boolean;
    contentionAcrossLines?: boolean;
    onContention?: (warnings: ContentionWarning[]) => void;
  }): Promise<string> {
    const blobOid = await this.putBlob(args.newText);
    const baseBlobOid =
      args.baseBlobOid ?? (args.baseText !== undefined ? await this.putBlob(args.baseText) : undefined);
    return this.proposeOperation({
      sessionOid: args.sessionOid,
      intentOid: args.intentOid,
      actor: args.actor,
      target: { entityKind: "file", entityId: args.path },
      body: { kind: "edit_file", path: args.path, blobOid, baseBlobOid },
      declaredPurpose: args.declaredPurpose,
      causalDeps: args.causalDeps,
      effects: args.effects,
      line: args.line,
      workspace: args.workspace,
      signWith: args.signWith,
      warnContention: args.warnContention,
      contentionAcrossLines: args.contentionAcrossLines,
      onContention: args.onContention,
    });
  }

  async attachEvidence(args: {
    forOps: string[];
    kind: EvidenceKind;
    result: EvidenceResult;
    producedBy: Actor;
    command?: string;
    detail?: string;
    /** The materialized treeHash this evidence was produced against (docs/16 §5). */
    treeHash?: string;
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
      ...(args.treeHash ? { treeHash: args.treeHash } : {}),
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

  // ── contention: early conflict warning (Phase 15.3, docs/17 §15.3) ──────────

  /**
   * Report contention on entity keys BEFORE finalize would discover it: for each key,
   * the operations by other actors that the caller has not built on (outside the
   * caller's causal closure) and are still live (neither decision-rejected nor built
   * upon by a later op on the key), plus other actors' active leases overlapping the
   * key. Discovery is via the entity index — O(ops-on-key), no reduce.
   *
   * Perspective resolution ("mine"), first hit wins:
   *  - `sessionOid`: that session's actor; its ops seed both the key set and the closure.
   *  - `actorId` (+ optional `keys`): that actor's ops on the resolved keys seed the
   *    closure; with no `keys` given, every key the actor has authored on is checked.
   *  - `keys` alone: no closure filter — everything live by anyone on the key reports.
   *
   * `acrossLines` (default false — existing callers are untouched) drops the line-equality
   * filter. The git bridge maps each git branch to its own line (`lineFor()` in the CLI), so
   * with N parallel sessions on N branches a line-scoped check cannot see ANY of them; the
   * cross-line check does, and reports each competing op's `line` so the caller can name the
   * branch. Lines are intentionally divergent by design, so this stays opt-in.
   */
  async contention(args: { keys?: string[]; sessionOid?: string; actorId?: string; line?: string; acrossLines?: boolean }): Promise<ContentionWarning[]> {
    const line = args.line ?? "main";
    let mine = args.actorId;
    const keys = new Set(args.keys ?? []);
    const myOpOids: string[] = [];

    if (args.sessionOid) {
      const sess = await this.store.get<Session>(args.sessionOid);
      mine ??= sess.actor.id;
      for (const op of await this.#allOpsTailed()) {
        if (op.sessionOid !== args.sessionOid) continue;
        myOpOids.push(op.oid as string);
        for (const k of keysOf(op)) keys.add(k);
      }
    } else if (mine) {
      for (const op of await this.#allOpsTailed()) {
        if (op.actor.id !== mine) continue;
        if (keys.size && ![...keysOf(op)].some((k) => keys.has(k))) continue;
        myOpOids.push(op.oid as string);
        if (!args.keys?.length) for (const k of keysOf(op)) keys.add(k);
      }
    }
    if (!keys.size) return [];

    // Ops I've already seen/built on are not surprises — they're my history.
    const myClosure = myOpOids.length ? await this.#closureOf(myOpOids) : new Set<string>();
    const rejected = new Set((await this.store.collect<Decision>("decision")).flatMap((d) => d.rejectedOps));
    const leases = await this.activeLeases();

    const out: ContentionWarning[] = [];
    for (const key of [...keys].sort()) {
      const ops: Operation[] = [];
      for (const oid of await this.store.readEntityIndex(key)) {
        if (!(await this.store.has(oid))) continue; // GC'd since indexed
        const op = await this.store.get<Operation>(oid);
        if (op.private) continue;
        if (!args.acrossLines && (op.line ?? "main") !== line) continue;
        ops.push({ ...op, oid } as Operation);
      }
      // An op some later op (on any key) causally builds on is superseded work, not
      // contention — one ancestry walk over the union of the key ops' deps finds them.
      const builtUpon = await this.#closureOf(ops.flatMap((o) => o.causalDeps));
      const theirs = ops
        .filter((o) => {
          const oid = o.oid as string;
          return o.actor.id !== mine && !myClosure.has(oid) && !rejected.has(oid) && !builtUpon.has(oid);
        })
        .sort((a, b) => a.lamport - b.lamport || String(a.oid).localeCompare(String(b.oid)))
        .map((o) => ({
          op: o.oid as string,
          actor: o.actor.id,
          lamport: o.lamport,
          purpose: o.declaredPurpose,
          createdAt: o.createdAt,
          // Only for a cross-line check: without it the field is redundant (always `line`),
          // and adding it unconditionally would change every existing caller's payload.
          ...(args.acrossLines ? { line: o.line ?? "main" } : {}),
        }));
      const leaseHolders = leases
        .filter((l) => l.actor.id !== mine && l.writeScopes.some((s) => scopesOverlap(key as ScopeRef, s)))
        .map((l) => ({
          actor: l.actor.id,
          leaseOid: l.oid as string,
          scope: l.writeScopes.find((s) => scopesOverlap(key as ScopeRef, s))!,
          expiresAt: l.expiresAt,
        }));
      if (theirs.length || leaseHolders.length) out.push({ key, theirs, leaseHolders });
    }
    return out;
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
  #verifiedEvidence(all: Evidence[], require: boolean): { kept: Evidence[]; dropped: number } {
    if (!require) return { kept: all, dropped: 0 };
    const kept = all.filter((e) => {
      if (e.producedBy.kind === "ai_agent") return true; // policy ignores these anyway
      return this.keyring.verifyFor(e.producedBy.id, e.oid as string, e.sig);
    });
    return { kept, dropped: all.length - kept.length };
  }

  /**
   * Decisions carry the same trust requirement as evidence (issue #15): a human/owner
   * decision only takes effect if it bears a valid signature from that actor's
   * registered key. Unsigned or forged decisions simply disappear, so the conflict
   * they claimed to resolve stays open — an agent cannot fabricate a human sign-off
   * (the MCP `kind === "human"` check is self-declared and not, by itself, a guarantee).
   * With no keyring configured, fall back to Phase-1 behavior (keep all). Unlike
   * evidence there is no ai_agent passthrough: a decision is an authority act, so every
   * decision must verify once a keyring exists. Mirrors #verifiedEvidence.
   */
  #verifiedDecisions(all: Decision[], require: boolean): { kept: Decision[]; dropped: number } {
    if (!require) return { kept: all, dropped: 0 };
    const kept = all.filter((d) =>
      this.keyring.verifyFor(d.decidedBy.id, d.oid as string, d.sig),
    );
    return { kept, dropped: all.length - kept.length };
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
   * frontier, with `derivedFrom` provenance. edit_file 3-way merges (against the target
   * line's content) at materialize; put_file replaces on the target line.
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
    const result = await this.store.withLock(`finalize:${args.view}`, async () => {
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
      // A workspace-scoped checkpoint (docs/20 §3.3) froze a tree containing ops that have
      // not landed on the base line. Advancing a protected head to it would publish
      // unlanded work under a verified head, so it is refused outright.
      if (cp.workspace) {
        return { finalized: false as const, reason: `checkpoint ${args.newCheckpoint.slice(0, 16)} is scoped to workspace ${cp.workspace} — land it first (\`avcs workspace land ${cp.workspace}\`)` };
      }
      const waived = await this.#activeWaivers(args.view);
      for (const k of prot?.requiredChecks ?? []) {
        if (waived.has(k)) continue;
        if (cp.evidence[k] !== "pass") {
          return { finalized: false as const, reason: `required check ${k} not pass` };
        }
        // Phase 13.4: a protection may insist the pass is PROVEN for this exact tree —
        // legacy (treeHash-less) evidence stops satisfying the gate once opted in.
        if (prot?.requireBoundEvidence && cp.evidenceBinding?.[k] !== "bound") {
          return { finalized: false as const, reason: `required check ${k} passed but its evidence is not bound to this tree (legacy) — re-run validation against treeHash ${cp.treeHash}` };
        }
      }
      // causal-complete gate (docs/08 C-3): never finalize a partially-synced tree —
      // every causalDep behind the checkpoint's frontier must be present locally.
      const missing = await this.#missingCausalDeps(cp.headOps);
      if (missing.length) {
        return { finalized: false as const, reason: `incomplete causal history: ${missing.length} object(s) missing — pull before finalizing` };
      }
      // required approvals (= PR approvals). A request_changes from any reviewer blocks.
      if (prot && (prot.requiredApprovals > 0 || prot.requireOwnerApproval)) {
        const verdict = await this.#approvalVerdicts(args.newCheckpoint);
        if ([...verdict.values()].includes("request_changes")) {
          return { finalized: false as const, reason: "changes requested by a reviewer" };
        }
        const approvers = [...verdict].filter(([, v]) => v === "approve").map(([id]) => id);
        if (approvers.length < prot.requiredApprovals) {
          return { finalized: false as const, reason: `needs ${prot.requiredApprovals} approval(s), have ${approvers.length}` };
        }
        if (prot.requireOwnerApproval) {
          let owner = false;
          for (const id of approvers) if (await this.hasRole(id, "maintainer")) { owner = true; break; }
          if (!owner) return { finalized: false as const, reason: "requires an owner (maintainer+) approval" };
        }
      }
      await this.store.setRef(`head:${args.view}`, args.newCheckpoint);
      return { finalized: true as const, head: args.newCheckpoint };
    });
    if (result.finalized) {
      this.logger.info("finalize.accepted", { view: args.view, head: result.head, parentHead: args.parentHead, by: args.by });
    } else {
      this.logger.warn("finalize.rejected", { view: args.view, by: args.by, reason: result.reason });
    }
    return result;
  }

  // ── integration queue (Phase 14, docs/17) ──────────────────────────────────
  // The end of "head moved — pull and re-reduce first": since ops are an append-only
  // union and reduce is deterministic, a stale submission is never rejected for
  // staleness — the queue re-reduces the frontier UNION on the submitter's behalf.
  // This is a repo API (not hub-only): it also kills the local multi-process funnel.

  /** Causal closure (op oids) of a frontier. Missing objects are skipped — callers gate
   *  completeness separately via #missingCausalDeps. */
  async #closureOf(heads: string[]): Promise<Set<string>> {
    const seen = new Set<string>();
    const stack = [...heads];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!(await this.store.has(id))) continue;
      const op = await this.store.get<Operation>(id);
      for (const d of op.causalDeps) if (!seen.has(d)) stack.push(d);
    }
    return seen;
  }

  #queueRel(view: string): string {
    return join("queue", `${view}.json`);
  }

  async #readReservation(view: string): Promise<IntegrationReservation | null> {
    const raw = await this.store.readAux(this.#queueRel(view));
    if (!raw) return null;
    try {
      const r = JSON.parse(raw.toString("utf8")) as IntegrationReservation | null;
      return r && typeof r.ticketId === "string" ? r : null;
    } catch {
      return null;
    }
  }

  async #writeReservation(view: string, resv: IntegrationReservation | null): Promise<void> {
    await this.store.writeAux(this.#queueRel(view), JSON.stringify(resv) + "\n");
  }

  /** Record an Integration verdict (append-only audit) and point the idempotency ref at it. */
  async #recordIntegration(fields: Omit<Integration, "type" | "createdAt">): Promise<string> {
    const integ: Integration = { type: "integration", ...fields, createdAt: new Date().toISOString() };
    const oid = await this.store.put(integ);
    await this.store.setRef(`integration:${fields.view}:${fields.ticketId}`, oid);
    return oid;
  }

  /** Author a checkpoint AT an integrated frontier (never `materialize(view)` — §1-(A):
   *  a view materialize would sweep in un-submitted third-party ops). */
  async #authorIntegratedCheckpoint(view: string, integrated: ReductionResult, evidence: Checkpoint["evidence"], evidenceBinding: Checkpoint["evidenceBinding"], summary: string): Promise<string> {
    const v = await this.getView(view);
    const cp: Checkpoint = {
      type: "checkpoint",
      viewOid: v.oid as string,
      headOps: integrated.headOps,
      treeHash: integrated.treeHash,
      policyOid: (await this.store.getRef("policy")) as string,
      materializerVersion: MATERIALIZER_VERSION,
      evidence,
      ...(evidenceBinding && Object.keys(evidenceBinding).length ? { evidenceBinding } : {}),
      status: integrated.conflicts.length === 0 ? "verified" : "draft",
      summary,
      createdAt: new Date().toISOString(),
    };
    return this.store.put(cp);
  }

  /** Verified (non-agent, canonically ordered) evidence bound to exactly `treeHash`. */
  async #boundEvidenceFor(treeHash: string): Promise<Partial<Record<EvidenceKind, EvidenceResult>>> {
    const out: Partial<Record<EvidenceKind, EvidenceResult>> = {};
    const boundPolicy = await this.policy();
    const all = this.#verifiedEvidence(
      await this.store.collect<Evidence>("evidence"),
      boundPolicy.requireSignedEvidence === true,
    ).kept.sort(
      (a, b) =>
        (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
        ((a.oid ?? "") < (b.oid ?? "") ? -1 : 1),
    );
    for (const ev of all) {
      if (ev.producedBy.kind === "ai_agent") continue;
      if (ev.treeHash === treeHash) out[ev.kind] = ev.result;
    }
    return out;
  }

  /** Keys touched by a set of op oids (contention surface of a delta). */
  async #keysOfOps(oids: Iterable<string>): Promise<Set<string>> {
    const keys = new Set<string>();
    for (const oid of oids) {
      if (!(await this.store.has(oid))) continue;
      const op = await this.store.get<Operation>(oid);
      for (const k of keysOf(op)) keys.add(k);
    }
    return keys;
  }

  /**
   * Submit a draft checkpoint to the integration queue (docs/17 §14.2). Runs under the
   * same `finalize:<view>` lock as finalize — the existing mkdir lock IS the serializer
   * (no separate queue structure in v1). The outcome is always one of the four verdicts;
   * "pull and redo" does not exist on any path.
   *
   * Idempotency: an `advanced` ticket replays its recorded verdict forever. Non-terminal
   * verdicts (conflict/needs_evidence/rejected/expired) re-evaluate on resubmission —
   * the world legitimately changes under them (a decision lands, evidence arrives, a
   * missing object syncs), and a frozen replay would wedge the ticket.
   */
  async submitIntegration(args: {
    view: string;
    checkpoint: string;
    by: string;
    ticketId?: string;
    signWith?: { keyId: string; privateKey: string };
  }): Promise<IntegrationResult> {
    const view = args.view;
    const ticketId = args.ticketId ?? sha256hex(`${view}:${args.checkpoint}`);
    const result = await this.store.withLock(`finalize:${view}`, async (): Promise<IntegrationResult> => {
      // 1. Idempotency — a terminal success replays as-is (safe resubmission).
      const priorRef = await this.store.getRef(`integration:${view}:${ticketId}`);
      if (priorRef && (await this.store.has(priorRef))) {
        const prior = await this.store.get<Integration>(priorRef);
        if (prior.verdict === "advanced") {
          return { verdict: "advanced", head: prior.resultCheckpoint!, integration: priorRef };
        }
      }

      // 2. Reservation — one in-flight needs_evidence ticket at a time (TTL-bounded).
      let resv = await this.#readReservation(view);
      if (resv && Date.parse(resv.expiresAt) <= Date.now()) {
        // Expired: audit it and let the queue move on (docs/17 §14 contract test).
        await this.#recordIntegration({
          view, ticketId: resv.ticketId, submittedCheckpoint: resv.submittedCheckpoint,
          baseHead: await this.protectedHead(view), resultCheckpoint: resv.integratedCheckpoint,
          verdict: "expired", reason: `needs_evidence reservation expired at ${resv.expiresAt}`, by: resv.by,
        });
        await this.#writeReservation(view, null);
        resv = null;
      }
      if (resv && resv.ticketId !== ticketId) {
        return { verdict: "queued", behindTicket: resv.ticketId, retryAfterMs: 1000 + Math.floor(Math.random() * 500) };
      }

      // 3. Causal completeness — never judge (or advance to) a partially-synced tree.
      const cp = await this.store.get<Checkpoint>(args.checkpoint);
      const missing = await this.#missingCausalDeps(cp.headOps);
      if (missing.length) {
        await this.#recordIntegration({ view, ticketId, submittedCheckpoint: args.checkpoint, baseHead: await this.protectedHead(view), verdict: "rejected", reason: `incomplete causal history: ${missing.length} object(s) missing`, by: args.by });
        return { verdict: "rejected", reason: `incomplete causal history: ${missing.length} object(s) missing — push them first (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""})` };
      }

      // Role gate (same as finalize).
      const prot = await this.getProtection(view);
      if (prot && !(await this.hasRole(args.by, prot.finalizeRole ?? "maintainer"))) {
        const reason = `${args.by} lacks role ${prot.finalizeRole ?? "maintainer"} to integrate ${view}`;
        await this.#recordIntegration({ view, ticketId, submittedCheckpoint: args.checkpoint, baseHead: await this.protectedHead(view), verdict: "rejected", reason, by: args.by });
        return { verdict: "rejected", reason };
      }

      // 4. Integration reduce — the frontier UNION via the materializeAt path (NEVER
      // materialize(view): §1-(A), un-submitted third-party ops must stay out).
      const baseHead = await this.protectedHead(view);
      const curHeads = baseHead ? (await this.store.get<Checkpoint>(baseHead)).headOps : [];
      const unionHeads = [...new Set([...curHeads, ...cp.headOps])];
      const integrated = await this.materializeAt(unionHeads);
      const subClosure = await this.#closureOf(cp.headOps);
      const fastForward = curHeads.every((h) => subClosure.has(h));

      // 5. Conflicts — the ONLY outcome that needs a human/agent decision, and it
      // arrives as a minimal repair packet with decision memory, not "pull and redo".
      if (integrated.conflicts.length > 0) {
        const packet: ConflictPacket = { conflicts: [] };
        for (const c of integrated.conflicts) {
          const fc = integrated.fileConflicts.find((f) => `file:${f.file}` === c.key);
          packet.conflicts.push({
            key: c.key,
            reason: c.reason,
            options: c.options.map((o) => ({ op: o.opOid, actor: o.actor, purpose: o.purpose })),
            ...(fc ? { regions: fc.regions } : {}),
            priorDecisions: await this.recallDecisions(c.key),
          });
        }
        const integration = await this.#recordIntegration({
          view, ticketId, submittedCheckpoint: args.checkpoint, baseHead,
          verdict: "conflict", conflictKeys: packet.conflicts.map((c) => c.key), by: args.by,
        });
        return { verdict: "conflict", packet, integration };
      }

      // 6. Gates: approvals carry from the SUBMITTED checkpoint to the integrated one
      // (GitHub counts PR approvals independently of the merge commit — same isomorphism).
      let carriedApprovals: string[] | undefined;
      if (prot && (prot.requiredApprovals > 0 || prot.requireOwnerApproval)) {
        const verdicts = await this.#approvalVerdicts(args.checkpoint);
        if ([...verdicts.values()].includes("request_changes")) {
          const reason = "changes requested by a reviewer";
          await this.#recordIntegration({ view, ticketId, submittedCheckpoint: args.checkpoint, baseHead, verdict: "rejected", reason, by: args.by });
          return { verdict: "rejected", reason };
        }
        const approvers = [...verdicts].filter(([, v]) => v === "approve").map(([id]) => id);
        if (approvers.length < prot.requiredApprovals) {
          const reason = `needs ${prot.requiredApprovals} approval(s), have ${approvers.length}`;
          await this.#recordIntegration({ view, ticketId, submittedCheckpoint: args.checkpoint, baseHead, verdict: "rejected", reason, by: args.by });
          return { verdict: "rejected", reason };
        }
        if (prot.requireOwnerApproval) {
          let owner = false;
          for (const id of approvers) if (await this.hasRole(id, "maintainer")) { owner = true; break; }
          if (!owner) {
            const reason = "requires an owner (maintainer+) approval";
            await this.#recordIntegration({ view, ticketId, submittedCheckpoint: args.checkpoint, baseHead, verdict: "rejected", reason, by: args.by });
            return { verdict: "rejected", reason };
          }
        }
        if (prot.integration?.carryApprovals !== false) {
          carriedApprovals = (await this.store.collect<Approval>("approval"))
            .filter((a) => a.checkpointOid === args.checkpoint)
            .map((a) => a.oid as string);
        }
      }

      const waived = await this.#activeWaivers(view);
      const required = (prot?.requiredChecks ?? []).filter((k) => !waived.has(k));
      const advance = async (headCp: string, evidenceBinding: Integration["evidenceBinding"], resultIsSubmitted = false): Promise<IntegrationResult> => {
        await this.store.setRef(`head:${view}`, headCp);
        const integration = await this.#recordIntegration({
          view, ticketId, submittedCheckpoint: args.checkpoint, baseHead,
          resultCheckpoint: resultIsSubmitted ? undefined : headCp,
          verdict: "advanced", evidenceBinding, ...(carriedApprovals ? { carriedApprovals } : {}), by: args.by,
        });
        if (resv?.ticketId === ticketId) await this.#writeReservation(view, null);
        this.logger.info("integrate.advanced", { view, ticketId, head: headCp, evidenceBinding });
        return { verdict: "advanced", head: headCp, integration };
      };

      // 7a. Fast-forward — the current head is inside the submission's causal closure:
      // classic finalize semantics, fresh binding, no re-authored checkpoint.
      if (fastForward) {
        for (const k of required) {
          if (cp.evidence[k] !== "pass") {
            const reason = `required check ${k} not pass`;
            await this.#recordIntegration({ view, ticketId, submittedCheckpoint: args.checkpoint, baseHead, verdict: "rejected", reason, by: args.by });
            return { verdict: "rejected", reason };
          }
          if (prot?.requireBoundEvidence && cp.evidenceBinding?.[k] !== "bound") {
            const reason = `required check ${k} passed but its evidence is not bound to this tree`;
            await this.#recordIntegration({ view, ticketId, submittedCheckpoint: args.checkpoint, baseHead, verdict: "rejected", reason, by: args.by });
            return { verdict: "rejected", reason };
          }
        }
        return advance(args.checkpoint, "fresh", true);
      }

      // 7b. Head moved: the integrated tree differs from the submitted one, so the
      // submitted evidence does NOT prove it (docs/17 §14.5). Decide by evidence mode.
      const T = integrated.treeHash;
      const needsEvidence = async (): Promise<IntegrationResult> => {
        const draft = resv?.ticketId === ticketId && resv.treeHash === T
          ? resv.integratedCheckpoint
          : await this.#authorIntegratedCheckpoint(view, integrated, {}, undefined, `integration ${ticketId.slice(0, 12)} (awaiting evidence)`);
        const ttl = prot?.integration?.reserveTtlMs ?? 10 * 60_000;
        await this.#writeReservation(view, {
          ticketId, submittedCheckpoint: args.checkpoint, integratedCheckpoint: draft,
          treeHash: T, requiredChecks: required, by: args.by,
          expiresAt: new Date(Date.now() + ttl).toISOString(),
        });
        // What the submitter is missing locally to reproduce T: the head-side delta ops
        // plus the blobs they reference (determinism does the rest — docs/17 §14.5 fresh).
        const headClosure = await this.#closureOf(curHeads);
        const missingLocally: string[] = [];
        for (const oid of headClosure) {
          if (subClosure.has(oid)) continue;
          missingLocally.push(oid);
          if (await this.store.has(oid)) {
            const op = await this.store.get<Operation>(oid);
            for (const b of [op.body.blobOid, op.body.baseBlobOid]) if (b) missingLocally.push(b);
          }
        }
        const integration = await this.#recordIntegration({
          view, ticketId, submittedCheckpoint: args.checkpoint, baseHead,
          resultCheckpoint: draft, verdict: "needs_evidence", by: args.by,
        });
        return { verdict: "needs_evidence", integratedCheckpoint: draft, treeHash: T, requiredChecks: required, missingLocally, ticketId, integration };
      };

      // Resubmission holding the reservation: accept iff fresh evidence bound to the
      // reserved tree now covers the required checks — exactly one validation run.
      if (resv && resv.ticketId === ticketId && resv.treeHash === T) {
        const bound = await this.#boundEvidenceFor(T);
        if (required.every((k) => bound[k] === "pass")) {
          const binding: Checkpoint["evidenceBinding"] = {};
          for (const k of Object.keys(bound) as EvidenceKind[]) binding[k] = "bound";
          const finalCp = await this.#authorIntegratedCheckpoint(view, integrated, bound, binding, `integration ${ticketId.slice(0, 12)}`);
          return advance(finalCp, "fresh");
        }
        return needsEvidence(); // reservation refreshed; still exactly one validation owed
      }

      if (required.length === 0) {
        // Nothing to prove — integrate directly (evidence-less views).
        const finalCp = await this.#authorIntegratedCheckpoint(view, integrated, {}, undefined, `integration ${ticketId.slice(0, 12)}`);
        return advance(finalCp, "fresh");
      }

      const mode = prot?.integration?.evidenceMode ?? "carry-disjoint";
      let carry = mode === "carry-always";
      if (mode === "carry-disjoint") {
        const headClosure = await this.#closureOf(curHeads);
        const oursOnly = [...subClosure].filter((o) => !headClosure.has(o));
        const theirsOnly = [...headClosure].filter((o) => !subClosure.has(o));
        const ourKeys = await this.#keysOfOps(oursOnly);
        const theirKeys = await this.#keysOfOps(theirsOnly);
        // Disjoint deltas + zero new conflicts (checked above) ⇒ the same risk a git
        // user already accepts when merging two independently-green branches — but
        // machine-checked, recorded, and opt-out-able (docs/17 §14.5).
        carry = [...ourKeys].every((k) => !theirKeys.has(k));
      }
      // Carried evidence is not tree-bound; a protection that demands bound evidence
      // therefore forces the fresh path whenever the head has moved.
      if (prot?.requireBoundEvidence) carry = false;

      if (carry) {
        for (const k of required) {
          if (cp.evidence[k] !== "pass") {
            const reason = `required check ${k} not pass`;
            await this.#recordIntegration({ view, ticketId, submittedCheckpoint: args.checkpoint, baseHead, verdict: "rejected", reason, by: args.by });
            return { verdict: "rejected", reason };
          }
        }
        // The carry is never silent: recorded on BOTH the checkpoint and the Integration.
        const binding: Checkpoint["evidenceBinding"] = {};
        for (const k of Object.keys(cp.evidence) as EvidenceKind[]) binding[k] = "carried";
        const finalCp = await this.#authorIntegratedCheckpoint(view, integrated, cp.evidence, binding, `integration ${ticketId.slice(0, 12)} (carried evidence)`);
        return advance(finalCp, "carried");
      }
      return needsEvidence();
    });
    if (result.verdict !== "advanced") {
      this.logger.info("integrate.verdict", { view, ticketId, verdict: result.verdict });
    }
    return result;
  }

  // ── security (Phase 12) ────────────────────────────────────────────────────
  /**
   * Redact (tombstone) a blob's bytes — for a leaked secret. Admin-only. The oid is
   * preserved so all references and the treeHash stay valid; the plaintext is evicted
   * from this store (and, once a real sync ships, propagated to every replica).
   */
  async redact(blobOid: string, reason: string, by: string, signWith?: { keyId: string; privateKey: string }): Promise<string> {
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
    // Sign so other replicas can verify it's a genuine admin redaction (not a forged
    // DoS). Required when governance is active (see applyRedactions).
    redaction.sig = this.#sign("redaction", redaction as unknown as Record<string, unknown>, signWith);
    const redactionOid = await this.store.put(redaction);
    // Evict the bytes: overwrite the blob in place with the (deterministic) stub.
    const { redactedStub } = await import("../store/applyRedactions.ts");
    await this.store.overwriteAt(blobOid, redactedStub(reason, redactionOid));
    this.#blobCache.delete(blobOid); // bytes changed under a stable oid — evict the cache
    // …and the derived copies: a merge result lives as bytes in the compaction snapshot, so
    // the object-store eviction alone would leave the plaintext readable there.
    await this.#scrubDerivedCaches();
    this.logger.warn("redact.applied", { blobOid, redactionOid, by, reason, length: original.length });
    return redactionOid;
  }

  // ── local undo (issue #91) ─────────────────────────────────────────────────
  /**
   * Undo local ops: drop them from a view's projection, and with `purge` evict the blob
   * bytes they uniquely reference.
   *
   * This is `redact`'s pre-share counterpart, and the split is the whole point. `redact`
   * is admin-gated because it evicts bytes from a repo other people hold — a governance
   * act. `undo` refuses the moment the ops have been pushed (see {@link pushedOps}),
   * so by construction it only ever operates on history no other holder has. Nothing to
   * co-ordinate ⇒ nobody's authority to ask for.
   *
   * Without `purge` this is fully reversible: the ops and their bytes stay in the store and
   * only the view's `excludeOps` grows. With `purge` the bytes go, which is why it is opt-in
   * and separately named. Both are append-only: the exclusion is a NEW view object and the
   * act itself is recorded as an {@link Undo}.
   */
  async undo(args: {
    /** Ops to undo. Mutually exclusive with `last`. */
    ops?: string[];
    /** Undo the ops of the most recent commit on this scope instead. */
    last?: boolean;
    /** The view (line) to undo on. Default "main". */
    view?: string;
    /** Resolve `last` inside a workspace's projection rather than the base view. */
    workspace?: string;
    /** Also evict the bytes the undone ops uniquely reference. Irreversible. */
    purge?: boolean;
    by: string;
    reason?: string;
  }): Promise<UndoResult> {
    const viewName = args.view ?? "main";
    if (args.last && args.ops?.length) throw new Error("undo: pass either --last or explicit op oids, not both");
    const targets = args.last ? await this.#lastCommitOps(viewName, args.workspace) : [...(args.ops ?? [])];
    if (!targets.length) throw new Error("undo: nothing to undo (name the op oids, or pass --last)");
    for (const oid of targets) {
      const obj = await this.store.get(oid).catch(() => null);
      if (obj?.type !== "operation") throw new Error(`undo: not an operation: ${oid}`);
    }
    // The boundary that keeps `undo` and `redact` from blurring into one another. Anything
    // replicated is somebody else's tree too, and only the governance plane may evict from it.
    const pushed = await this.pushedOps();
    const gone = targets.filter((o) => pushed.has(o));
    if (gone.length) {
      const where = [...new Set(gone.flatMap((o) => pushed.get(o) ?? []))].join(", ");
      throw new Error(
        `undo refuses: ${gone.length} of these op(s) have already been pushed (${gone[0]} → ${where}). ` +
          `Another holder's projection depends on them, so evicting them is a governance act, not a local one — ` +
          `use \`redact\` (admin-signed, propagates to every replica) instead.`,
      );
    }
    return this.store.withLock(`undo:${viewName}`, async () => {
      const view = await this.getView(viewName);
      const already = new Set(view.query.excludeOps ?? []);
      const fresh = targets.filter((o) => !already.has(o));
      const alreadyExcluded = targets.filter((o) => already.has(o));
      const { evictable, retained } = args.purge
        ? await this.#purgeableBlobs(targets)
        : { evictable: [], retained: [] };

      // A repeat of an undo that already happened converges instead of erroring: nothing
      // left to exclude AND nothing left to evict ⇒ no new view, no new record.
      if (!fresh.length && !evictable.length) {
        return { undoOid: null, view: viewName, excluded: [], alreadyExcluded, purged: [], retained };
      }
      const viewOid = fresh.length
        ? await this.createView(viewName, { ...view.query, excludeOps: [...already, ...fresh] }, (view.oid as string) ?? null)
        : (view.oid as string);
      const undo: Undo = {
        type: "undo",
        view: viewName,
        ops: fresh,
        viewOid,
        ...(evictable.length ? { purged: evictable } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
        by: args.by,
        createdAt: new Date().toISOString(),
      };
      // Record BEFORE evicting: a crash between the two leaves a record naming bytes that
      // are still there, and re-running finishes the job. The reverse order would evict
      // bytes nothing accounts for.
      const undoOid = await this.store.put(undo);
      if (evictable.length) {
        const { purgedStub } = await import("../store/applyRedactions.ts");
        const reason = args.reason ?? "local undo --purge";
        for (const blobOid of evictable) {
          await this.store.overwriteAt(blobOid, purgedStub(reason, undoOid));
          this.#blobCache.delete(blobOid); // bytes changed under a stable oid
        }
        await this.#scrubDerivedCaches();
      }
      this.logger.warn("undo.applied", { view: viewName, ops: fresh.length, purged: evictable.length, by: args.by, reason: args.reason });
      return { undoOid, view: viewName, excluded: fresh, alreadyExcluded, purged: evictable, retained };
    });
  }

  /**
   * The ops of the most recent commit on a scope (`undo --last`).
   *
   * "One commit" is already a first-class grouping: `commitWorkingTree` opens ONE session
   * and authors every op of that capture against it, so the session is the commit and no new
   * bookkeeping is needed. The newest op is picked in the reducer's own canonical order
   * (lamport, then oid), and its whole session comes with it — a two-file commit undoes as
   * two files, never half of one.
   *
   * Resolved against what the view currently SELECTS, so a repeat walks back one commit at a
   * time: the ops a previous undo excluded are no longer candidates.
   */
  async #lastCommitOps(viewName: string, workspace?: string): Promise<string[]> {
    const res = await this.materialize(viewName, workspace ? { workspace } : undefined);
    const ops: Operation[] = [];
    for (const oid of res.statuses.keys()) {
      const op = await this.store.get<Operation>(oid).catch(() => null);
      if (op?.type === "operation") ops.push(op);
    }
    if (!ops.length) throw new Error(`undo --last: ${viewName} has no ops left to undo`);
    ops.sort((a, b) => a.lamport - b.lamport || (a.oid as string).localeCompare(b.oid as string));
    const newest = ops[ops.length - 1] as Operation;
    return ops.filter((o) => o.sessionOid === newest.sessionOid).map((o) => o.oid as string);
  }

  /**
   * Split the blobs the undone ops reference into what `--purge` may evict and what it
   * must spare.
   *
   * "Uniquely referenced" is decided against EVERY operation in the store other than the
   * ones being undone — not merely the ops the target view currently selects. Content
   * addressing means identical content is one blob, and an op on another line (or in a
   * workspace, or one a previous undo excluded but did not purge) can hold the only other
   * reference to it. Both `blobOid` and `baseBlobOid` count: a remaining `edit_file` needs
   * its 3-way merge base as much as its content. Ref targets are spared too, since a ref
   * can point at a blob (the landed-workspace set) that no op mentions.
   *
   * The asymmetry is deliberate. Sparing one blob too many leaves bytes the user must undo
   * a second op to be rid of — annoying, and reported as `retained`. Evicting one too many
   * silently breaks a projection nobody asked to change, irreversibly.
   */
  async #purgeableBlobs(targets: string[]): Promise<{ evictable: string[]; retained: string[] }> {
    const withChunks = async (oid: string, into: Set<string>): Promise<void> => {
      into.add(oid);
      const blob = await this.store.get<Blob>(oid).catch(() => null);
      if (blob?.chunked && blob.chunks) for (const c of blob.chunks) into.add(c);
    };
    const targetSet = new Set(targets);
    const wanted = new Set<string>();
    const spared = new Set<string>();
    for (const op of await this.store.collect<Operation>("operation")) {
      const mine = targetSet.has(op.oid as string);
      // An undone op's own merge BASE is the previous content, which belongs to the op that
      // wrote it — undoing this op is no statement about that. Only its own content goes.
      if (mine) {
        if (op.body.blobOid) await withChunks(op.body.blobOid, wanted);
        continue;
      }
      for (const b of [op.body.blobOid, op.body.baseBlobOid]) if (b) await withChunks(b, spared);
    }
    for (const oid of (await this.store.listRefs()).values()) spared.add(oid);

    const evictable: string[] = [];
    const retained: string[] = [];
    for (const oid of [...wanted].sort()) {
      if (spared.has(oid)) { retained.push(oid); continue; }
      const blob = await this.store.get<Blob>(oid).catch(() => null);
      if (!blob || blob.redacted) continue; // already gone (gc) or already evicted — idempotent
      evictable.push(oid);
    }
    return { evictable, retained };
  }

  /**
   * Op oid → the hub URLs that accepted it (issue #91). Written by `pushToHub`; the record
   * of what has left this machine, which `undo` refuses to touch.
   *
   * It is a record of THIS replica's pushes, so it is honest about what it can see and no
   * more: a hub push (including the one inside `land`/`submit`) is recorded, while a peer
   * that ran `avcs pull <this-dir>` copied objects without this side ever being asked. See
   * docs/23 §5 for that boundary.
   */
  async pushedOps(): Promise<Map<string, string[]>> {
    const raw = await this.store.readAux("pushed-ops.json");
    if (!raw) return new Map();
    try {
      return new Map(Object.entries(JSON.parse(raw.toString("utf8")) as Record<string, string[]>));
    } catch {
      return new Map();
    }
  }

  /** Every recorded local undo, oldest first. */
  async listUndos(): Promise<Undo[]> {
    const undos = await this.store.collect<Undo>("undo");
    return undos.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Drop every DERIVED copy of blob bytes after an eviction (`redact` / `undo --purge`).
   *
   * A projection's content is not always a stored blob: a 3-way merge result is a SYNTHETIC
   * blob the reducer carries as bytes (`ReductionResult.synthBlobs`). Those bytes are held by
   * the warm reduce cache, by the in-memory incremental snapshot, and — the one that outlives
   * the process — by the persisted compaction snapshot at `.avcs/snapshot/<view>.cbor`. An
   * eviction that stopped at the object store would leave the plaintext readable there.
   *
   * All of it is rebuildable cache: the cost of dropping it is one full reduce, and the read
   * path never depends on it (`#loadPersistedSnapshot` treats an absent file as a cold start).
   */
  async #scrubDerivedCaches(): Promise<void> {
    this.#incSnap = null;
    this.#reduceCache.clear();
    this.#persistedBaseOps.clear();
    await rm(join(this.store.root, "snapshot"), { recursive: true, force: true });
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

  /** A reviewer approves (or requests changes on) a checkpoint. = PR approve. */
  async approve(
    checkpointOid: string,
    by: string,
    verdict: "approve" | "request_changes" = "approve",
    opts: { reason?: string; signWith?: { keyId: string; privateKey: string } } = {},
  ): Promise<string> {
    if (!(await this.hasRole(by, "reviewer"))) {
      throw new Error(`approve requires role >= reviewer; ${by} is ${await this.roleOf(by)}`);
    }
    const a: Approval = { type: "approval", checkpointOid, by, verdict, reason: opts.reason, createdAt: new Date().toISOString() };
    a.sig = this.#sign("approval", a as unknown as Record<string, unknown>, opts.signWith);
    return this.store.put(a);
  }

  /** Latest verdict per reviewer for a checkpoint (later canonical approval wins). */
  async #approvalVerdicts(checkpointOid: string): Promise<Map<string, "approve" | "request_changes">> {
    const all = (await this.store.collect<Approval>("approval"))
      .filter((a) => a.checkpointOid === checkpointOid)
      .sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0));
    const out = new Map<string, "approve" | "request_changes">();
    for (const a of all) if (await this.hasRole(a.by, "reviewer")) out.set(a.by, a.verdict);
    return out;
  }

  /**
   * Public read of the effective approval verdicts on a checkpoint (Phase 16 M4, docs/18
   * §3): the same trust-gated view finalize uses, so a review surface cannot show an
   * approval the gate would not count — only actors who still hold the reviewer role are
   * included, and a later verdict from the same reviewer supersedes an earlier one.
   */
  async approvalsFor(checkpointOid: string): Promise<{ by: string; verdict: "approve" | "request_changes" }[]> {
    return [...(await this.#approvalVerdicts(checkpointOid))]
      .map(([by, verdict]) => ({ by, verdict }))
      .sort((a, b) => a.by.localeCompare(b.by));
  }

  /** Objects missing from the causal closure of a frontier (incomplete sync). */
  async #missingCausalDeps(headOps: string[]): Promise<string[]> {
    const seen = new Set<string>();
    const missing: string[] = [];
    const stack = [...headOps];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!(await this.store.has(id))) {
        missing.push(id);
        continue;
      }
      const op = await this.store.get<Operation>(id);
      for (const d of op.causalDeps) if (!seen.has(d)) stack.push(d);
    }
    return missing;
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
    let maxLamport = 0;
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
      if (obj.type === "operation") {
        for (const k of keysOf(obj as Operation)) await this.store.appendEntityIndex(k, oid);
        maxLamport = Math.max(maxLamport, (obj as Operation).lamport);
      }
      copied++;
    }
    this.#observeImported(maxLamport);
    // Propagate redactions: evict plaintext for any blob we already had before a peer
    // redacted it (pull skips already-present oids, so the redaction must be applied).
    await this.applyRedactions();
    return { copied, rejected };
  }

  /** Apply all known redaction tombstones locally (evict bytes; oids preserved). */
  async applyRedactions(): Promise<number> {
    const { applyRedactions } = await import("../store/applyRedactions.ts");
    const n = await applyRedactions(this.store);
    if (n > 0) this.#blobCache.clear(); // bytes changed under stable oids — evict the cache
    return n;
  }

  /** Push objects this repo holds that a network hub lacks (M2 / docs/10 WS-B). */
  async pushHub(hubUrl: string, opts?: { as?: string }): Promise<{ pushed: number; rejected: number }> {
    const { pushToHub } = await import("../hub/hubClient.ts");
    const signWith = await this.#resolveHubSigner(opts?.as);
    return pushToHub(this.dir, hubUrl, signWith);
  }
  /** Request a finalize (= PR merge) on a network hub via its CAS endpoint (E6). */
  async finalizeHub(hubUrl: string, args: { view: string; newCheckpoint: string; parentHead: string | null; by: string; signWith?: { keyId: string; privateKey: string } }): Promise<{ status: number; finalized: boolean; head?: string; reason?: string }> {
    const { finalizeOnHub } = await import("../hub/hubClient.ts");
    const signWith = args.signWith ?? await this.#resolveHubSigner(args.by);
    return finalizeOnHub(hubUrl, { ...args, signWith });
  }
  /** Pull objects a network hub holds that this repo lacks. */
  async pullHub(hubUrl: string, opts?: { as?: string }): Promise<{ pulled: number }> {
    const { pullFromHub } = await import("../hub/hubClient.ts");
    // Sign reads when this replica holds a key (issue #50): a hub that gates reads refuses
    // an unsigned GET, and a read-public hub ignores the header, so this is additive.
    const r = await pullFromHub(this.dir, hubUrl, await this.#resolveHubSigner(opts?.as));
    // pull may have applied redactions (blob bytes overwritten under stable oids) and
    // wrote through a separate ObjectStore; drop the warm blob cache so reads re-hit disk.
    this.#blobCache.clear();
    this.#observeImported(r.maxLamport); // Phase 13.2: sort after the imported history
    return { pulled: r.pulled };
  }

  // ── remotes (Phase 13.1) ────────────────────────────────────────────────────
  // Named hub URLs persisted in `.avcs/remotes.json` — an aux file, NOT an object:
  // where you sync from is per-replica configuration, not shared history, so it is
  // never gossiped (an old replica simply ignores the file). `sync-cursors.json`
  // stays keyed by URL (transport optimization; renaming a remote loses no state).

  async #readRemotes(): Promise<Record<string, RemoteConfig>> {
    const raw = await this.store.readAux("remotes.json");
    if (!raw) return {};
    try { return JSON.parse(raw.toString("utf8")) as Record<string, RemoteConfig>; } catch { return {}; }
  }

  async #writeRemotes(remotes: Record<string, RemoteConfig>): Promise<void> {
    await this.store.writeAux("remotes.json", JSON.stringify(remotes, null, 2) + "\n");
  }

  /** Register (or update) a named remote hub. */
  async addRemote(name: string, url: string, opts: { autoSync?: boolean; freshnessMs?: number } = {}): Promise<void> {
    if (!/^https?:\/\//.test(url)) throw new Error(`remote url must be http(s): ${url}`);
    const remotes = await this.#readRemotes();
    remotes[name] = { url: url.replace(/\/$/, ""), ...(opts.autoSync ? { autoSync: true } : {}), ...(opts.freshnessMs !== undefined ? { freshnessMs: opts.freshnessMs } : {}) };
    await this.#writeRemotes(remotes);
  }

  /** Remove a named remote. Returns whether it existed. */
  async removeRemote(name: string): Promise<boolean> {
    const remotes = await this.#readRemotes();
    if (!(name in remotes)) return false;
    delete remotes[name];
    await this.#writeRemotes(remotes);
    return true;
  }

  /** All configured remotes, name → config. */
  async listRemotes(): Promise<Record<string, RemoteConfig>> {
    return this.#readRemotes();
  }

  /** Resolve a remote name (or a literal URL, for one-off syncs) to a hub URL. */
  async #resolveRemote(nameOrUrl: string): Promise<string> {
    if (/^https?:\/\//.test(nameOrUrl)) return nameOrUrl.replace(/\/$/, "");
    const remotes = await this.#readRemotes();
    const r = remotes[nameOrUrl];
    if (!r) throw new Error(`unknown remote: ${nameOrUrl} (run \`avcs remote add ${nameOrUrl} <url>\`)`);
    return r.url;
  }

  /** Public remote-name → hub-URL resolution (a literal URL passes through). */
  async remoteUrl(nameOrUrl: string): Promise<string> {
    return this.#resolveRemote(nameOrUrl);
  }

  /**
   * Submit a draft checkpoint to a REMOTE hub's integration queue (Phase 14, docs/17
   * §14.4), with capability detection: a hub advertising `integrate` on GET /version
   * gets the queue path (one judgment, no redo); an older hub falls back to the legacy
   * finalize + pull retry funnel (bounded) — the exact loop the queue exists to kill,
   * kept only for backward compatibility.
   */
  async integrateHub(
    remoteOrUrl: string,
    args: { view: string; checkpoint: string; by?: string; ticketId?: string; signWith?: { keyId: string; privateKey: string } },
  ): Promise<{ verdict: IntegrationResult["verdict"]; legacy?: boolean } & Record<string, unknown>> {
    const url = await this.#resolveRemote(remoteOrUrl);
    // Resolve the actor ONCE, here (issue #95). `by` is two things at once — who signs the
    // request, and who the integration ticket records — so the two must not be allowed to
    // disagree, and neither may be `undefined` on the wire (a missing `by` reaches the hub
    // as a malformed body and comes back 400).
    //
    // Callers may omit it: `localActorId` already knows the order
    // (explicit → AVCS_ACTOR → config.json → the sole private key). The CLI used to
    // duplicate the first two steps and then substitute the literal "human:cli", which has
    // no key and no membership, so an authenticating hub refused the credential outright.
    const by = await this.localActorId(args.by);
    if (!by) {
      throw new Error(
        "no actor identity to integrate as — pass --as <actor-id>, set AVCS_ACTOR, " +
          "record `actorId` in .avcs/config.json, or run `avcs key provision <actor-id>`",
      );
    }
    const signWith = args.signWith ?? (await this.#resolveHubSigner(by));
    let hasIntegrate = false;
    try {
      const v = (await (await fetch(`${url}/version`)).json()) as { integrate?: boolean };
      hasIntegrate = v.integrate === true;
    } catch { /* unreachable /version → treat as legacy */ }

    if (hasIntegrate) {
      const { integrateWithHub } = await import("../hub/hubClient.ts");
      const r = await integrateWithHub(this.dir, url, { ...args, by, signWith });
      // needs_evidence pulled delta objects through a separate store — refresh caches.
      this.#blobCache.clear();
      return r as { verdict: IntegrationResult["verdict"] } & Record<string, unknown>;
    }

    // Legacy fallback (old hub): finalize CAS + pull, bounded retries. This CAN lose
    // races (that is exactly the funnel Phase 14 removes) — surfaced honestly.
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.pullHub(url, { as: by });
      const parentHead = await this.protectedHead(args.view);
      await this.pushHub(url, { as: by });
      const r = await this.finalizeHub(url, { view: args.view, newCheckpoint: args.checkpoint, parentHead, by, signWith });
      if (r.finalized) return { verdict: "advanced", head: r.head ?? args.checkpoint, legacy: true };
      if (!/head moved/.test(r.reason ?? "")) return { verdict: "rejected", reason: r.reason ?? `finalize failed (${r.status})`, legacy: true };
    }
    return { verdict: "rejected", reason: "legacy hub: lost the finalize CAS race 3 times — retry, or upgrade the hub for queue semantics", legacy: true };
  }

  /**
   * Bidirectional convergence with a named remote (default "origin"): pull what the hub
   * has that we lack, then push what we have that it lacks. Pure object gossip — union
   * semantics, no rebase, no working-tree mutation beyond redaction propagation.
   */
  async sync(remote = "origin", opts?: { as?: string }): Promise<{ pulled: number; pushed: number; rejected: number }> {
    const url = await this.#resolveRemote(remote);
    // Both halves carry the identity: a hub that gates reads refuses an unsigned pull, so
    // passing `as` only to the push leg would leave sync broken there (issue #50).
    const { pulled } = await this.pullHub(url, opts);
    const { pushed, rejected } = await this.pushHub(url, opts);
    await this.#recordSyncAt(remote); // Phase 15.2: the freshness window keys off this stamp
    this.logger.info("sync.completed", { remote, url, pulled, pushed, rejected });
    return { pulled, pushed, rejected };
  }

  // ── live convergence: freshness window (Phase 15.2, docs/17 §15.2) ─────────
  // `.avcs/last-sync.json` — remote name → ISO timestamp of the last successful sync.
  // An aux file like remotes.json: per-replica state, never an object, never gossiped.

  /** Freshness window applied to an `autoSync` remote that doesn't set `freshnessMs`. */
  static readonly DEFAULT_FRESHNESS_MS = 30_000;

  async #readLastSync(): Promise<Record<string, string>> {
    const raw = await this.store.readAux("last-sync.json");
    if (!raw) return {};
    try { return JSON.parse(raw.toString("utf8")) as Record<string, string>; } catch { return {}; }
  }

  async #recordSyncAt(remote: string): Promise<void> {
    const last = await this.#readLastSync();
    last[remote] = new Date().toISOString();
    await this.store.writeAux("last-sync.json", JSON.stringify(last, null, 2) + "\n");
  }

  /** Milliseconds since the last successful sync with `remote` (Infinity when never). */
  async syncAgeMs(remote = "origin"): Promise<number> {
    const at = Date.parse((await this.#readLastSync())[remote] ?? "");
    return Number.isFinite(at) ? Date.now() - at : Infinity;
  }

  /**
   * BLOCKING freshness sync (Phase 15.2): sync each named remote (default: every
   * `autoSync` remote) whose last successful sync is older than its freshness window.
   * For callers that must not read stale state (e.g. just before a submit). The read
   * path itself never calls this — materialize only ever fires a BACKGROUND revalidate.
   */
  async syncIfStale(remote?: string, opts?: { as?: string }): Promise<{ synced: string[] }> {
    const remotes = await this.#readRemotes();
    const names = remote !== undefined ? [remote] : Object.keys(remotes).filter((n) => remotes[n]!.autoSync);
    const synced: string[] = [];
    for (const name of names) {
      const cfg = remotes[name];
      if (!cfg && !/^https?:\/\//.test(name)) throw new Error(`unknown remote: ${name}`);
      const freshnessMs = cfg?.freshnessMs ?? Repo.DEFAULT_FRESHNESS_MS;
      if ((await this.syncAgeMs(name)) < freshnessMs) continue;
      await this.sync(name, opts);
      synced.push(name);
    }
    return { synced };
  }

  // Stale-while-revalidate on materialize: when an autoSync remote's window has lapsed,
  // fire a background sync and return immediately — the read path is the throughput-
  // critical path and is NEVER blocked on the network. In-flight + a 1s re-check
  // throttle keep the hot loop to at most one aux read per second.
  //
  // The in-flight run is KEPT as a promise rather than a boolean: "fire and forget" with
  // no handle is unobservable from outside, and a revalidate outlives the observable
  // effect that a caller would naturally wait on (pull lands the objects, but push and
  // the last-sync stamp write still follow). Whoever tears the repo down next — a test's
  // rm, a daemon shutdown — would otherwise race those writes. See settleBackgroundSync.
  #bgSync: Promise<void> | null = null;
  #lastFreshnessCheck = 0;

  /**
   * Await any in-flight background revalidation, resolving immediately when idle. The
   * quiesce handle for the fire-and-forget path, mirroring the promise `runSyncWatch`
   * returns for the daemon: call it before tearing a repo down (shutdown, teardown) so
   * no `.avcs` write is still outstanding. Never rejects — a failed revalidate is logged
   * and swallowed, exactly as it is on the read path.
   */
  async settleBackgroundSync(): Promise<void> {
    // Loop rather than a single await: a materialize concurrent with the settle can start
    // the next run while we're waiting on this one.
    for (let inFlight = this.#bgSync; inFlight; inFlight = this.#bgSync) await inFlight;
  }

  #maybeBackgroundSync(): void {
    const now = Date.now();
    if (this.#bgSync || now - this.#lastFreshnessCheck < 1_000) return;
    this.#lastFreshnessCheck = now;
    // Publish the handle BEFORE arranging its clear, and clear by identity: a body that
    // ever settles without suspending would otherwise null the field first and be
    // resurrected by this assignment, wedging the guard above at "always in flight".
    const run = this.#revalidateStaleRemotes();
    this.#bgSync = run;
    void run.finally(() => { if (this.#bgSync === run) this.#bgSync = null; });
  }

  /** One revalidation pass: sync every autoSync remote past its freshness window.
   *  Never rejects — see the catch. */
  async #revalidateStaleRemotes(): Promise<void> {
    try {
      const remotes = await this.#readRemotes();
      for (const [name, cfg] of Object.entries(remotes)) {
        if (!cfg.autoSync) continue;
        const freshnessMs = cfg.freshnessMs ?? Repo.DEFAULT_FRESHNESS_MS;
        const age = await this.syncAgeMs(name);
        if (age < freshnessMs) continue;
        this.logger.info("sync.freshness.revalidate", { remote: name, ageMs: age === Infinity ? null : Math.round(age) });
        await this.sync(name);
      }
    } catch (e) {
      // Background revalidation failing (hub down, network) must never surface into
      // the read path — log and try again after the next materialize + throttle.
      this.logger.warn("sync.freshness.fail", { error: String((e as Error).message) });
    }
  }

  /** Resolve a view's query into the candidate operation set, then reduce. */
  /**
   * Workspaces that have LANDED onto their base line (docs/16). A landed workspace's ops
   * are included in the base view and merge with base/other-landed ops via the normal
   * reduce 3-way merge; before landing they stay isolated. Stored as a single ref → JSON
   * array of names, so the set rides the object store with no schema change. Changing it
   * shifts the `kept` op-set, which already keys the reduce cache — no extra invalidation.
   */
  async #landedWorkspaces(): Promise<Set<string>> {
    const ref = await this.store.getRef("workspaces.landed");
    if (!ref) return new Set();
    try {
      return new Set(JSON.parse((await this.readBlob(ref)).toString("utf8")) as string[]);
    } catch {
      return new Set();
    }
  }

  /** List the workspaces that have landed onto their base line. */
  async landedWorkspaces(): Promise<string[]> {
    return [...(await this.#landedWorkspaces())].sort();
  }

  /**
   * Every workspace that actually carries operations. A workspace is not a stored object —
   * it exists exactly as a tag on ops — so this is the only way to ask whether a NAME names
   * anything. The `post-merge` land seam uses it as a guard: landing is append-only and
   * irreversible, so a name it cannot corroborate is not landed (docs/20 §3.4, R1).
   */
  async workspaceNames(): Promise<string[]> {
    const names = new Set<string>();
    for (const op of await this.#allOpsTailed()) if (op.workspace) names.add(op.workspace);
    return [...names].sort();
  }

  /**
   * Land a workspace onto its base line (docs/16): its ops join the base view and merge
   * there. There is no "rebase" — reduce always 3-way-merges the full op set, and any
   * overlap surfaces as a Conflict via the normal materialize path. Idempotent.
   */
  async landWorkspace(name: string): Promise<void> {
    const cur = await this.#landedWorkspaces();
    if (cur.has(name)) return;
    cur.add(name);
    const oid = await this.putBlob(JSON.stringify([...cur]));
    await this.store.setRef("workspaces.landed", oid);
  }

  async materialize(viewName = "main", opts?: { includeStatuses?: ViewQuery["includeStatuses"]; workspace?: string }): Promise<ReductionResult> {
    this.metrics.inc("materialize.calls");
    // Phase 15.2 stale-while-revalidate: an autoSync remote past its freshness window
    // triggers a BACKGROUND sync. Fire-and-forget — this read never waits on the network.
    this.#maybeBackgroundSync();
    // Compaction (B3, default since 13.3): on a cold instance, seed the incremental base
    // from the persisted snapshot so this materialize re-reduces only ops added since it,
    // not all history. A corrupt/stale/version-mismatched snapshot is discarded (→ full
    // reduce), so correctness never depends on the file.
    if (process.env.AVCS_INCREMENTAL !== "0" && !this.#incSnap) await this.#loadPersistedSnapshot(viewName);
    const view = await this.getView(viewName);
    const q = view.query;
    const exclude = new Set(q.excludeOps ?? []);
    const intentFilter = q.intentOids && q.intentOids.length ? new Set(q.intentOids) : null;
    const sessionFilter = q.sessionOids && q.sessionOids.length ? new Set(q.sessionOids) : null;

    // Lineage (Phase 8): a line materializes its own ops + everything inherited from
    // its fork checkpoint (the base line's frozen frontier). Ops authored on the base
    // line AFTER the fork are excluded, which is what keeps lines divergent.
    const lineName = q.line ?? "main";
    const allOps = await this.#allOpsTailed();
    const inherited = await this.#inheritedOps(lineName, allOps);

    const wsName = opts?.workspace;
    // Landing makes a workspace's ops BASE-ACCEPTED (docs/16 §4.3), so the landed set is
    // read for EVERY view, not only base ones. A workspace view that ignored it would keep
    // a sibling's already-landed work invisible and rediscover the conflict at land time
    // (docs/20 §1.3).
    const landed = await this.#landedWorkspaces();
    const ops: Operation[] = [];
    for (const op of allOps) {
      const onLine = (op.line ?? "main") === lineName || inherited.has(op.oid as string);
      if (!onLine) continue;
      // Workspace isolation (docs/16): a view excludes a workspace-tagged op unless that
      // workspace has landed, or it is this view's OWN workspace. With `wsName` undefined
      // the middle clause is vacuously true, so a BASE view's op set is exactly what it was
      // — exclude tagged-and-unlanded, keep everything else.
      const opWs = op.workspace;
      if (opWs && opWs !== wsName && !landed.has(opWs)) continue;
      if (exclude.has(op.oid as string)) continue;
      if (intentFilter && !intentFilter.has(op.intentOid)) continue;
      if (sessionFilter && !sessionFilter.has(op.sessionOid)) continue;
      ops.push(op);
    }
    // E4 (docs/13): hold back causally-incomplete ops. A push is N independent POSTs,
    // so an op can arrive before its causalDeps (partial/out-of-order sync). Projecting
    // it without its ancestor yields a transient WRONG tree (the reducer would otherwise
    // treat the missing dep as an absent edge and apply the op anyway). We exclude any op
    // a dep of which is absent from the store entirely, transitively. For a complete op
    // set nothing is held back, so determinism for settled history is unchanged.
    const present = new Set(allOps.map((o) => o.oid as string));
    const { complete, pending } = this.#causallyComplete(ops, present);
    if (pending.length) {
      this.metrics.inc("materialize.causallyPending", pending.length);
      this.logger.info("materialize.pending", { view: viewName, pending: pending.length });
    }
    // Phase 11: in a governed repo, ops authored by non-members (outsiders) are
    // quarantined — excluded from the materialized tree until a reviewer promotes them.
    const { kept, quarantined } = await this.#partitionQuarantine(complete);
    // A caller may override the view's default status filter (e.g. to project pending/gated
    // ops so their computed 3-way merge can be inspected before acceptance — issue #13).
    const includeStatuses = opts?.includeStatuses ?? q.includeStatuses;
    const res = await this.#reduceOpSet(kept, includeStatuses, true); // main path: incremental by default
    for (const oid of quarantined) res.statuses.set(oid, "quarantined");
    await this.#maybeAutoCompact(viewName, res);
    return res;
  }

  /**
   * Amortized compaction (Phase 13.3): after a main-path materialize, re-persist the base
   * snapshot once the live snapshot is ≥ AUTO_COMPACT_DELTA ops past the last persisted
   * base, so a cold start never replays an unbounded history. The treeHash guard ties the
   * in-memory snapshot to THIS view's result (a reduce-cache hit may have left #incSnap
   * pointing at another view's reduction). Best-effort: a persist failure only logs — the
   * read path never depends on it.
   */
  async #maybeAutoCompact(viewName: string, res: ReductionResult): Promise<void> {
    if (process.env.AVCS_INCREMENTAL === "0") return;
    const snap = this.#incSnap;
    if (!snap || snap.result.treeHash !== res.treeHash) return;
    const base = this.#persistedBaseOps.get(viewName) ?? 0;
    if (snap.input.ops.length - base < Repo.AUTO_COMPACT_DELTA) return;
    try {
      await this.store.withLock(`snapshot:${viewName}`, () => this.#persistSnapshot(viewName, snap));
      this.metrics.inc("snapshot.auto.persisted");
    } catch (e) {
      this.logger.warn("snapshot.auto.failed", { view: viewName, error: (e as Error).message });
    }
  }

  /**
   * Partition candidate ops into those whose transitive causalDeps are all PRESENT in
   * the store vs those still waiting on a missing dep (E4). A dep absent from the store
   * entirely (`!present.has`) makes its dependents incomplete; incompleteness propagates.
   * A dep that exists in the store but isn't a candidate here (e.g. another line) counts
   * as satisfied — only genuinely-unsynced deps hold an op back, so no false holdback.
   */
  #causallyComplete(candidates: Operation[], present: Set<string>): { complete: Operation[]; pending: Operation[] } {
    const byId = new Map(candidates.map((o) => [o.oid as string, o]));
    const memo = new Map<string, boolean>();
    const ok = (oid: string): boolean => {
      const cached = memo.get(oid);
      if (cached !== undefined) return cached;
      if (!present.has(oid)) return false; // dep never arrived
      const op = byId.get(oid);
      if (!op) return true; // present in the store but not a candidate (other line) — satisfied
      memo.set(oid, true); // cycle guard (an append-only DAG has none)
      for (const d of op.causalDeps) if (!ok(d)) { memo.set(oid, false); return false; }
      memo.set(oid, true);
      return true;
    };
    const complete: Operation[] = [];
    const pending: Operation[] = [];
    for (const op of candidates) (ok(op.oid as string) ? complete : pending).push(op);
    return { complete, pending };
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
    const oid = await this.store.put(p);
    this.logger.info("promote", { promotionOid: oid, ops: opOids.length, by: byActor, reason });
    return oid;
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

  /**
   * Minimum line similarity for the capture path to call a removed × added pair a MOVE
   * rather than an unrelated delete + create (docs/19 §3.1, and §6 R3 asks for exactly one
   * place to tune it). 0.5 is git's `-M` default, so a tree avcs captures and the same tree
   * `git diff -M` describes agree about what moved. Raising it makes capture more
   * conservative (more moves recorded as delete + create, which is the pre-Stage-0
   * behaviour); lowering it risks attaching a wrong merge base, which is worse than none.
   */
  static readonly RENAME_SIMILARITY = 0.5;

  #cloneResult(r: ReductionResult): ReductionResult {
    return {
      tree: new Map(r.tree),
      treeHash: r.treeHash,
      statuses: new Map(r.statuses),
      conflicts: r.conflicts.map((c) => ({ ...c })),
      autoDecisions: r.autoDecisions.map((a) => ({ ...a })),
      blockedReasons: new Map(r.blockedReasons),
      untrustedEvidence: r.untrustedEvidence,
      fileConflicts: r.fileConflicts.map((s) => ({ ...s })),
      headOps: [...r.headOps],
      synthBlobs: new Map(r.synthBlobs),
    };
  }

  /**
   * Pass-1 reduce (docs/11 A6b — incremental is the DEFAULT since Phase 13.3). With a prior
   * snapshot, re-reduce only the delta via `reduceIncremental` (falling back to a full
   * `snapshotReduce` if the preconditions don't hold — e.g. policy changed, or `base` is not
   * an append-superset of the snapshot). Opt OUT with AVCS_INCREMENTAL=0 (plain full
   * `reduce`, the pre-13.3 default). Only the main materialize path passes `useInc`, so
   * subset reducers (materializeAt/history/bisect) never read or pollute the snapshot.
   * AVCS_VERIFY_INCREMENTAL=1 cross-checks each incremental result against a full reduce
   * and throws on any divergence (runs as a dedicated CI job).
   */
  #pass1Reduce(base: ReduceInput, useInc: boolean): ReductionResult {
    const on = useInc && (process.env.AVCS_INCREMENTAL !== "0" || this.#forceSnapshot);
    if (!on) return reduce(base);
    let snap: ReduceSnapshot;
    if (this.#incSnap) {
      try {
        snap = reduceIncremental(this.#incSnap, base);
      } catch (e) {
        if (!(e instanceof NonIncrementalError)) throw e;
        snap = snapshotReduce(base);
        this.metrics.inc("reduce.incremental.fallback");
      }
    } else {
      snap = snapshotReduce(base);
    }
    if (process.env.AVCS_VERIFY_INCREMENTAL === "1") {
      this.#assertReduceEqual(snap.result, snapshotReduce(base).result);
    }
    this.#incSnap = snap;
    return snap.result;
  }

  /** Throw if an incremental reduction diverges from the full one (treeHash/statuses/
   *  conflicts/headOps) — incremental reduce must NEVER break the determinism invariant. */
  #assertReduceEqual(inc: ReductionResult, full: ReductionResult): void {
    // canonicalize (recursive key-sort) so the compare is key-order-insensitive — a
    // CBOR-deserialized base (B3) yields sorted-key objects vs freshly-built insertion
    // order, which are logically identical.
    const norm = (r: ReductionResult) => canonicalize({
      treeHash: r.treeHash,
      statuses: [...r.statuses].sort(),
      conflicts: r.conflicts,
      autoDecisions: r.autoDecisions,
      headOps: [...r.headOps].sort(),
      synth: [...r.synthBlobs.keys()].sort(),
    });
    if (norm(inc) !== norm(full)) {
      throw new Error(`incremental reduce diverged from full reduce (treeHash inc=${inc.treeHash} full=${full.treeHash}) — determinism invariant violated`);
    }
  }

  async #reduceOpSet(ops: Operation[], includeStatuses: ViewQuery["includeStatuses"], useInc = false): Promise<ReductionResult> {
    const reducePolicy = await this.policy();
    const ev = this.#verifiedEvidence(
      await this.store.collect<Evidence>("evidence"),
      reducePolicy.requireSignedEvidence === true,
    );
    const dec = this.#verifiedDecisions(
      await this.store.collect<Decision>("decision"),
      reducePolicy.requireSignedDecisions === true,
    );
    const evidence = ev.kept;
    const decisions = dec.kept;
    // Evidence/decisions discarded by the signature gate (issue #66): reported on
    // the result so a projection can never lose files silently.
    const untrustedEvidence = ev.dropped + dec.dropped;

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

    const reduced = await this.metrics.time("reduce.ms", () =>
      this.#reduceOpSetUncached(ops, includeStatuses, evidence, decisions, useInc),
    );
    // Report what the signature gate discarded (issue #66): a file must never
    // leave the projection without the caller being able to see why.
    const result: ReductionResult = { ...reduced, untrustedEvidence };
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
    useInc = false,
  ): Promise<ReductionResult> {
    const intents = new Map<string, Intent>();
    for await (const it of this.store.list<Intent>("intent")) intents.set(it.oid as string, it);

    // Preload blob content needed by edit_file's 3-way merge (base + new content).
    const blobContent = new Map<string, Buffer>();
    for (const op of ops) {
      for (const oid of [op.body.blobOid, op.body.baseBlobOid]) {
        if (oid && !blobContent.has(oid)) blobContent.set(oid, await this.readBlob(oid));
      }
    }

    const policy = await this.policy();
    const reliability = computeReliability(ops, evidence, decisions);
    const authority = await this.#authorityMap();
    const base: ReduceInput = { ops, evidence, decisions, intents, policy, materializeStatuses: includeStatuses, blobContent, reliability, authority };
    const pass1 = this.#pass1Reduce(base, useInc);

    // Post-reduce text-merge pass (docs/15 §5): the grouping accepts all concurrent
    // edit_file ops because their disjoint line hunks compose. This authoritative N-way
    // merge3 over the file's concurrent frontier finds the ones whose hunks OVERLAP.
    // Disjoint changes stay merged in the tree (the design goal); the contested region
    // defaults to the deterministic incumbent (applyOp onConflict:"first") and is
    // surfaced as a Conflict so the release gate blocks until policy/human resolves it.
    // …unless POLICY can decide the region (docs/22 §3.4): a region whose winner the trust
    // ladder / evidence / owner rules pick is not a question for a human, so it drops out of
    // the conflict set and is recorded as an AutoDecision instead.
    const { remaining: fileConflicts, decisions: regionDecisions } = arbitrateFileConflicts(
      detectFileConflicts(ops, pass1, blobContent),
      base,
    );
    if (fileConflicts.length === 0 && regionDecisions.length === 0) return pass1;

    // Clone before annotating — pass1 may be a cached snapshot result.
    const result: ReductionResult = {
      ...pass1,
      conflicts: [...pass1.conflicts],
      autoDecisions: [...pass1.autoDecisions, ...regionDecisions],
      fileConflicts,
    };
    for (const fc of fileConflicts) {
      result.conflicts.push({
        id: conflictIdFor(`file:${fc.file}`),
        key: `file:${fc.file}`,
        kind: "needs_human",
        reason: `concurrent edits to ${fc.file} overlap on ${fc.regions.length} line range(s) — a human/policy must choose`,
        recommendedOp: null,
        options: fc.ops.map((oid) => ({
          opOid: oid, actor: "", purpose: "overlapping concurrent edit",
          evidence: [], score: 0, blocked: false, requiresHuman: true,
        })),
      });
    }
    return result;
  }

  // ── git-like working tree (checkout / commit) ─────────────────────────────
  /**
   * Read a working directory's files (relative paths → bytes), skipping .avcs/ and honoring
   * ignore rules (issue #10): the core's own `.avcsignore` (git-independent), plus an optional
   * predicate the CLI bridge injects from `git check-ignore` so `.gitignore` is respected too.
   * Walks manually and PRUNES ignored directories — an ignored dir is never descended into, so
   * `node_modules/` etc. cost neither op-graph entries nor a recursive walk.
   */
  async #readWorkTree(workDir: string, ignorePredicate?: (rel: string) => boolean): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    if (!existsSync(workDir)) return out;
    // Resolve the root and derive each path RELATIVE to it, rather than slicing a fixed
    // prefix length off a joined path (issue #48). `join` normalises — `join(".", "src")`
    // is "src", not "./src" — so with workDir "." a length-based slice removed two real
    // characters and stored `src/a.ts` as `c/a.ts`. A trailing slash shifted them by one.
    //
    // Nothing errored: the op count looked right and the damage only surfaced later, when
    // `file:src/a.ts` had no history. It also defeated the exclusion guards below, since
    // `.git/HEAD` shifted to `it/HEAD` and stopped matching — which is how avcs came to
    // capture git's directory, and its own store, into the history it was writing.
    const root = resolve(workDir);
    const out2 = out; // keep the closure below reading naturally
    const avcsIgnore = await this.#loadAvcsIgnore(root);
    // Shared paths are folded in HERE, in the core, and not left to the user's `.avcsignore`
    // (docs/21 §3.5). If listing `node_modules` in an ignore file were the defence, forgetting
    // to list it would capture 50k files — so contamination is made structurally impossible
    // instead of merely configurable. Listing a shared path in `.avcsignore` too is harmless.
    //
    // A symlinked shared path is already safe without this: the walk below branches on
    // `Dirent`, whose predicates are lstat-based, so a symlink is neither isDirectory() nor
    // isFile() and is never entered or read (pinned by docs/21 S8). `mode: "copy"` is the
    // dangerous one — a real directory the walk CAN descend — and this composition is its
    // only defence (S8b).
    const sharedIgnore = await this.#loadSharedIgnore();
    const ignored = (rel: string): boolean => avcsIgnore(rel) || sharedIgnore(rel) || (ignorePredicate?.(rel) ?? false);
    const walk = async (dir: string): Promise<void> => {
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        const rel = relative(root, join(dir, ent.name)).split("\\").join("/");
        // Skip AVCS's own state and git's OWN directory — but not `.github/`/`.gitignore`/
        // `.gitattributes`: those are code (CI workflows, ignore rules) and must be captured,
        // or verify-git can never match a real repo's committed tree (they'd be "+git only").
        if (rel.startsWith(".avcs") || rel === ".avcs-workspace" || rel === ".git" || rel.startsWith(".git/")) continue;
        if (ignored(rel)) continue; // prune: skip an ignored file, and never descend an ignored dir
        if (ent.isDirectory()) await walk(join(dir, ent.name));
        else if (ent.isFile()) out2.set(rel, await readFile(join(dir, ent.name)));
      }
    };
    await walk(root);
    return out;
  }

  /**
   * Build an ignore predicate from the configured shared paths (docs/21 §3.5).
   *
   * A shared path matches itself and everything under it, and nothing else — it is a path
   * PREFIX rule, deliberately narrower than `.avcsignore`'s basename and `*.ext` matching,
   * because a shared path names one place in the projection rather than a family of files.
   *
   * Unconfigured ⇒ `() => false`, the same object shape `#loadAvcsIgnore` returns for a
   * missing file, so capture is byte-identical to before this existed (S1).
   */
  async #loadSharedIgnore(): Promise<(rel: string) => boolean> {
    const entries = await this.readSharedPaths();
    if (!entries.length) return () => false;
    const paths = entries.map((e) => e.path);
    return (rel: string): boolean => paths.some((p) => rel === p || rel.startsWith(p + "/"));
  }

  /**
   * Build an ignore predicate from a repo-root `.avcsignore`, kept git-independent so the core
   * stays standalone (issue #10). Pragmatic subset of .gitignore: blank/`#` lines ignored; a
   * `dir`/`path` matches itself and everything under it; a bare name matches any basename; and
   * `*.ext` matches by suffix. Full .gitignore semantics are layered on by the CLI's git bridge.
   */
  async #loadAvcsIgnore(workDir: string): Promise<(rel: string) => boolean> {
    const file = join(workDir, ".avcsignore");
    if (!existsSync(file)) return () => false;
    const patterns = (await readFile(file, "utf8"))
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.replace(/^\/+/, "").replace(/\/+$/, ""));
    if (!patterns.length) return () => false;
    return (rel: string): boolean => {
      const base = rel.slice(rel.lastIndexOf("/") + 1);
      return patterns.some((p) =>
        p.startsWith("*")
          ? rel.endsWith(p.slice(1)) || base.endsWith(p.slice(1))
          : rel === p || rel.startsWith(p + "/") || base === p,
      );
    };
  }

  // ── shared paths (docs/21) ─────────────────────────────────────────────────
  // The other half of "ignore". `.avcsignore` says "do not record this as an op";
  // a shared path says "do not record it AND still have it in the directory". Without
  // the second half a projected workspace has no dependency tree, so it cannot build,
  // so real projects keep git worktrees for physical isolation — and docs/16 §2-1
  // ("물리 격리도 avcs가 제공한다") does not hold where it matters.
  //
  // Persisted in `.avcs/shared-paths.json`: an aux file like `remotes.json`, not an
  // object — where your build cache lives is per-replica configuration, not shared
  // history, and being under `.avcs/` keeps sidecar mode from exposing it to git.

  /**
   * Reject a `path` that could not be resolved under a projection root, or slugged into a
   * store-local directory name, without ambiguity or escape. Called on WRITE so a bad entry
   * never reaches the file, and again on USE so a hand-edited file cannot escape either.
   */
  static #assertSharedPath(path: string): void {
    const bad =
      !path ||
      path !== path.trim() ||
      isAbsolute(path) ||
      path.startsWith("/") ||
      /(^|\/)\.\.(\/|$)/.test(path) ||
      path.split("/").some((seg) => seg === "" || seg === ".") ||
      path.startsWith(".avcs");
    if (bad) throw new Error(`shared path must be a relative path inside the projection, with no '..': ${JSON.stringify(path)}`);
  }

  /** Normalize one entry: forward slashes, no trailing slash, mode defaulted, keyFrom copied. */
  static #normalizeSharedEntry(entry: SharedPathEntry): SharedPathEntry {
    const path = entry.path.replace(/\\/g, "/").replace(/\/+$/, "");
    Repo.#assertSharedPath(path);
    const mode: SharedPathMode = entry.mode === "copy" ? "copy" : "symlink";
    return { path, keyFrom: [...(entry.keyFrom ?? [])], mode };
  }

  /**
   * The configured shared paths, or `[]` when nothing is configured. A torn/undecodable
   * file reads as empty, exactly like `remotes.json` and `config.json`: an unreadable
   * cache configuration must never make a projection fail.
   *
   * Reading must not CREATE the file — "no `shared-paths.json`" is the backward-compatible
   * state (docs/21 S1) and the absence of the file is itself the signal.
   */
  async readSharedPaths(): Promise<SharedPathEntry[]> {
    const raw = await this.store.readAux("shared-paths.json");
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw.toString("utf8")) as SharedPathsFile;
      if (!Array.isArray(parsed?.shared)) return [];
      const out: SharedPathEntry[] = [];
      for (const e of parsed.shared) {
        if (!e || typeof e.path !== "string") continue;
        try { out.push(Repo.#normalizeSharedEntry(e)); } catch { /* a hand-edited escape: drop it, never honour it */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Replace the shared-path configuration wholesale. */
  async setSharedPaths(entries: SharedPathEntry[]): Promise<void> {
    const shared = entries.map((e) => Repo.#normalizeSharedEntry(e));
    const file: SharedPathsFile = { version: 1, shared };
    await this.store.writeAux("shared-paths.json", JSON.stringify(file, null, 2) + "\n");
    this.logger.info("shared.set", { count: shared.length });
  }

  /** Add (or replace, by `path`) one shared path. Read-modify-write, like `setTrunk`. */
  async addSharedPath(entry: SharedPathEntry): Promise<void> {
    const normalized = Repo.#normalizeSharedEntry(entry);
    const entries = (await this.readSharedPaths()).filter((e) => e.path !== normalized.path);
    entries.push(normalized);
    await this.setSharedPaths(entries);
  }

  /** Remove one shared path. Returns whether it existed. The CACHE is left alone — that is
   *  `gc --shared`'s call to make, because re-installing is expensive (docs/21 §3.6). */
  async removeSharedPath(path: string): Promise<boolean> {
    const want = path.replace(/\\/g, "/").replace(/\/+$/, "");
    const entries = await this.readSharedPaths();
    const kept = entries.filter((e) => e.path !== want);
    if (kept.length === entries.length) return false;
    await this.setSharedPaths(kept);
    return true;
  }

  /**
   * Derive a cache key from the PROJECTED content of the declared files (docs/21 §3.2):
   *
   *   key = sha256( canonical( [[path, blobOidOfProjectedContent] for path in sorted(keyFrom)] ) )[:32]
   *
   * Projected content, not what is on disk. A tree entry is `path → blobOid`, and a blob
   * object is `{type,data,encoding}` — content and nothing else — so the oid IS the content
   * hash. Two workspaces that project the same view therefore get the SAME key by
   * construction, with no disk read and no clock in the way: determinism buys cache
   * correctness for free (S15). Conversely a declared file whose content changes moves the
   * key (S4), and an undeclared file cannot move it however much it changes.
   *
   * Pure and static: a key that decides which cache a workspace links to must be checkable
   * without a store, a projection, or a filesystem.
   *
   *  - A declared file ABSENT from the view (a lockfile nobody has written yet) participates
   *    as EMPTY content and is reported in `missing` — never silently keyed differently,
   *    which would split the cache and leave nobody able to explain the extra install (S9).
   *  - `keyFrom: []` (or absent) is the named constant `"unkeyed"`: the explicit choice that
   *    every workspace shares one cache. Dangerous, and the user's to make (S10).
   */
  static deriveSharedKey(
    keyFrom: string[] | undefined,
    tree: Map<string, string>,
  ): { key: string; missing: string[]; unkeyed: boolean } {
    const declared = [...new Set(keyFrom ?? [])].sort();
    if (!declared.length) return { key: "unkeyed", missing: [], unkeyed: true };
    const missing: string[] = [];
    const entries = declared.map((p) => {
      const oid = tree.get(p);
      if (oid === undefined) missing.push(p);
      return [p, oid ?? ""];
    });
    return { key: sha256hex(canonicalize(entries)).slice(0, 32), missing, unkeyed: false };
  }

  /**
   * Keep the cache tree out of git in COMMITTED mode.
   *
   * Sidecar mode ignores all of `.avcs/` (its `*` covers this), but committed mode
   * deliberately TRACKS `.avcs/` except for a named list of rebuildable caches — and a build
   * environment is emphatically one of those. Without the entry, `git add` would sweep tens
   * of thousands of dependency files into the history AVCS exists to keep clean.
   *
   * A repo that flipped to committed mode before shared paths existed has the older file, so
   * this repairs it at the moment the cache tree first comes into being. Cheap: it reads the
   * small ignore file and writes only when the entry is genuinely missing, and it never
   * touches a sidecar repo (nothing there needs it).
   */
  async #ensureSharedCacheIgnored(): Promise<void> {
    if ((await this.getGitMode()) !== "committed") return;
    const raw = (await this.store.readAux(".gitignore"))?.toString("utf8") ?? "";
    if (raw.split(/\r?\n/).some((l) => l.trim() === SHARED_IGNORE_LINE)) return;
    await this.#writeGitignore("committed");
  }

  /**
   * Root of the store-local shared-cache tree (docs/21 §3.3).
   *
   * Store-local, not `$HOME`: cleanup is then one `.avcs` away, the home directory stays
   * clean, and two unrelated projects can never collide on a lock hash. `store.root` already
   * follows a linked working tree's `.avcs` POINTER file, so a linked worktree shares the
   * MAIN store's caches for free — which is exactly where sharing across workspaces starts
   * to pay (docs/21 S12, homomorphic to docs/14's one-store model).
   */
  #sharedRoot(): string {
    return join(this.store.root, "shared");
  }

  /**
   * Throw away one cache directory by key (docs/21 R2). The core reports only "non-empty",
   * so a cache left broken by a half-finished install is not something it can detect — this
   * is the escape hatch for the caller who can.
   */
  async dropSharedCache(key: string): Promise<boolean> {
    if (!/^[a-z0-9]{1,64}$/.test(key)) throw new Error(`not a shared cache key: ${JSON.stringify(key)}`);
    const dir = join(this.#sharedRoot(), key);
    if (!existsSync(dir)) return false;
    await rm(dir, { recursive: true, force: true });
    this.logger.info("shared.cache.dropped", { key });
    return true;
  }

  /**
   * Connect every configured shared path to its store-local cache (docs/21 §3.4). Runs
   * AFTER the tree has been written, because writing the tree can create directories.
   *
   * What the core does: derive the key, create the cache directory, connect it, and report
   * `populated`. What the core does NOT do: run an install. It does not know what
   * `node_modules` is, which package manager owns it, or whether the network is up — and the
   * moment it did, docs/21 §2 principle 1 would be gone. `populated` is the entire interface
   * between "the core made a place" and "somebody has to fill it".
   *
   * Existing content at a shared path is never destroyed. A real directory there is the
   * user's data and the core cannot recreate it (it does not know how to install), so it is
   * left alone with a warning. The one thing that IS re-pointed is a symlink the core itself
   * put inside this store's own cache tree, which is how a key change (S4) takes effect
   * instead of leaving the workspace wired to a stale environment.
   *
   * With `mode: "copy"`, a directory already at the target counts as materialized and is not
   * copied over — local edits inside it survive (S11). Re-materializing after a key change
   * therefore means removing that directory by hand; the core will not delete user data to
   * refresh a cache.
   */
  async linkSharedPaths(workDir: string, tree: Map<string, string>): Promise<SharedPathLink[]> {
    const entries = await this.readSharedPaths();
    if (!entries.length) return []; // S1: unconfigured ⇒ not even a mkdir
    const root = resolve(workDir);
    const sharedRoot = resolve(this.#sharedRoot());
    await this.#ensureSharedCacheIgnored(); // the cache tree is about to exist
    const out: SharedPathLink[] = [];
    for (const entry of entries) {
      const mode: SharedPathMode = entry.mode === "copy" ? "copy" : "symlink";
      const { key, missing, unkeyed } = Repo.deriveSharedKey(entry.keyFrom, tree);
      // One key may hold several shared paths, so the leaf is the path slugged `/`→`__`.
      const cache = join(sharedRoot, key, entry.path.split("/").join("__"));
      const target = join(root, entry.path);
      const notes: string[] = [];
      if (unkeyed) notes.push("no keyFrom, so every workspace shares this one cache");
      if (missing.length) notes.push(`keyFrom absent from the view, hashed as empty: ${missing.join(", ")}`);

      // R4: the LOCK covers only creating the directory, so two concurrent projections cannot
      // race it. Coordinating concurrent INSTALLS is outside the core's reach by construction
      // — it does not run them.
      await this.store.withLock(`shared:${key}`, async () => { await mkdir(cache, { recursive: true }); });
      const populated = (await readdir(cache)).length > 0;

      let linked = false;
      const st = await lstat(target).catch(() => null);
      if (st?.isSymbolicLink()) {
        const dest = resolve(dirname(target), await readlink(target));
        if (dest === cache) {
          linked = true; // S5: already correct — no-op, and nothing to say about it
        } else if (dest === sharedRoot || dest.startsWith(sharedRoot + sep)) {
          await rm(target, { force: true }); // our own cache tree: the key moved (S4)
          await symlink(cache, target, "dir");
          linked = true;
        } else {
          notes.push(`${entry.path} is a symlink to ${dest}, outside this store's cache — left alone`);
        }
      } else if (st) {
        if (mode === "copy" && st.isDirectory()) linked = true; // already materialized (S11)
        else notes.push(`${entry.path} exists and is not a link to the cache — left alone (your data)`);
      } else {
        await mkdir(dirname(target), { recursive: true });
        if (mode === "copy") await cp(cache, target, { recursive: true });
        else await symlink(cache, target, "dir");
        linked = true;
      }

      const link: SharedPathLink = { path: entry.path, key, cache, target, mode, linked, populated };
      if (notes.length) link.warning = notes.join("; ");
      if (link.warning) this.logger.warn("shared.link", { path: entry.path, key, warning: link.warning });
      out.push(link);
    }
    return out;
  }

  /**
   * Project a view into `workDir` AND connect its shared paths (docs/21 §3.4) — the full
   * physical checkout `avcs workspace project` performs. `checkoutInto` is this without the
   * shared report, kept as-is for every existing caller.
   *
   * `skipped` are tree entries that live INSIDE a shared path. Normally there are none —
   * capture cannot produce them (§3.5) — but a history contaminated before shared paths
   * existed can still be opened, and writing those files would spill recorded content over a
   * live build environment. So they are skipped and named rather than written.
   */
  async projectInto(
    workDir: string,
    view = "main",
    opts?: { workspace?: string },
  ): Promise<{ written: string[]; shared: SharedPathLink[]; skipped: string[] }> {
    const res = await this.materialize(view, opts?.workspace ? { workspace: opts.workspace } : undefined);
    const shared = await this.readSharedPaths();
    const inShared = (rel: string): boolean => shared.some((e) => rel === e.path || rel.startsWith(e.path + "/"));
    const written: string[] = [];
    const skipped: string[] = [];
    for (const [path, blobOid] of res.tree) {
      if (shared.length && inShared(path)) { skipped.push(path); continue; }
      const full = join(workDir, path);
      const synth = res.synthBlobs.get(blobOid);
      const want = synth ?? (await this.readBlob(blobOid));
      // Skip a file whose bytes already match (issue #64). Rewriting the whole
      // projection on every hook was the bulk of a git-sync's I/O, and it churned
      // mtimes — which makes build tools and `git status` see phantom changes. The
      // return value still lists the view's files, not just the ones touched: callers
      // (git-sync's re-stage, tests) treat it as "what the view projects here".
      let same = false;
      try {
        same = (await readFile(full)).equals(Buffer.from(want));
      } catch {
        /* absent or unreadable → write it */
      }
      if (!same) {
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, want);
      }
      written.push(path);
    }
    if (skipped.length) this.logger.warn("shared.projection.skipped", { count: skipped.length, sample: skipped.slice(0, 5) });
    return { written: written.sort(), shared: await this.linkSharedPaths(workDir, res.tree), skipped: skipped.sort() };
  }

  /** Write a view's materialized files into `workDir` (alongside .avcs, like git). */
  async checkoutInto(workDir: string, view = "main", opts?: { workspace?: string }): Promise<string[]> {
    return (await this.projectInto(workDir, view, opts)).written;
  }

  /**
   * Whether `buf` may travel the `edit_file` (text 3-way merge) path. `proposeEdit` takes
   * a `string`, so anything that is not LOSSLESSLY UTF-8 would be silently corrupted by the
   * Buffer→string→Buffer round trip (invalid sequences become U+FFFD). The NUL check keeps
   * the classification identical to `merge3`/`reducer`'s binary route (`core/bytes.isBinary`,
   * git's heuristic), so a file the merger would refuse to line-merge is never captured as
   * if it could be. Everything rejected here falls back to `put_file`, which is byte-exact.
   */
  #isMergeableText(buf: Buffer): boolean {
    if (isBinary(buf)) return false;
    return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
  }

  /**
   * Pair `removed` paths against `added` ones to recover MOVES from a path-set diff
   * (docs/19 §3.1, Stage 0).
   *
   * `commitWorkingTree` compares path sets, so a move arrives as a removal plus an
   * unrelated-looking addition — which the reducer then sees as a delete racing an edit,
   * plus a create with no merge base. Recovering the move here is what makes Stage 1's
   * commutativity reachable from actual usage.
   *
   * Two tiers, both deterministic and language-blind:
   *
   *   1. EXACT content match. Content is hashed, so this is an O(n) bucket join and a pure
   *      relocation — the common case, and the whole of the binary case — never pays for a
   *      line diff at all.
   *   2. LINE SIMILARITY `2·LCS / (linesP + linesQ)` over the leftovers, using merge3's own
   *      LCS. Binary content (a NUL byte) is excluded: a line diff over bytes is noise, so
   *      binary is exact-match-only.
   *
   * A pair is only accepted when it is UNAMBIGUOUS in both directions — one candidate for
   * the source and one for the destination. Anything else stays a delete + create rather
   * than a guess: naming the wrong file as "the same file" invents history, and a wrong
   * merge base is worse than no merge base. That is also why there is no tie-breaking to
   * get wrong; ambiguity is not resolved, it is declined.
   */
  #detectRenames(
    removed: string[],
    added: string[],
    before: Map<string, Buffer>,
    after: Map<string, Buffer>,
  ): { from: string; to: string }[] {
    if (!removed.length || !added.length) return [];
    const sources = [...removed].sort();
    const destinations = [...added].sort();

    /** Accept only pairs that are the single candidate on BOTH sides. */
    const unambiguous = (links: Map<string, Set<string>>): { from: string; to: string }[] => {
      const inverse = new Map<string, Set<string>>();
      for (const [from, tos] of links) for (const to of tos) (inverse.get(to) ?? inverse.set(to, new Set()).get(to)!).add(from);
      const out: { from: string; to: string }[] = [];
      for (const from of [...links.keys()].sort()) {
        const tos = links.get(from)!;
        if (tos.size !== 1) continue;
        const to = [...tos][0]!;
        if (inverse.get(to)!.size !== 1) continue;
        out.push({ from, to });
      }
      return out;
    };

    // ── Tier 1: exact content ──
    const byContent = new Map<string, string[]>();
    for (const to of destinations) {
      const h = sha256hex(after.get(to)!);
      (byContent.get(h) ?? byContent.set(h, []).get(h)!).push(to);
    }
    const exact = new Map<string, Set<string>>();
    for (const from of sources) {
      const hits = byContent.get(sha256hex(before.get(from)!));
      if (hits) exact.set(from, new Set(hits));
    }
    const pairs = unambiguous(exact);

    // ── Tier 2: line similarity over what tier 1 left ──
    const takenFrom = new Set(pairs.map((p) => p.from));
    const takenTo = new Set(pairs.map((p) => p.to));
    const similar = new Map<string, Set<string>>();
    const linesCache = new Map<string, string[] | null>();
    const linesOf = (path: string, buf: Buffer): string[] | null => {
      if (!linesCache.has(path)) linesCache.set(path, isBinary(buf) ? null : buf.toString("utf8").split("\n"));
      return linesCache.get(path)!;
    };
    for (const from of sources) {
      if (takenFrom.has(from)) continue;
      const fromLines = linesOf(`-${from}`, before.get(from)!);
      if (!fromLines) continue; // binary: exact match only (rule 4)
      for (const to of destinations) {
        if (takenTo.has(to)) continue;
        const toLines = linesOf(`+${to}`, after.get(to)!);
        if (!toLines) continue;
        const n = fromLines.length;
        const m = toLines.length;
        // Sound pre-filter (docs/19 R4): LCS ≤ min(n, m), so this is an upper bound on the
        // similarity and can never skip a pair that would have passed. It keeps a large
        // relocation from running an O(n·m) line DP against every unrelated candidate.
        if ((2 * Math.min(n, m)) / (n + m) < Repo.RENAME_SIMILARITY) continue;
        if ((2 * lcsLineLength(fromLines, toLines)) / (n + m) < Repo.RENAME_SIMILARITY) continue;
        (similar.get(from) ?? similar.set(from, new Set()).get(from)!).add(to);
      }
    }
    return [...pairs, ...unambiguous(similar)].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  }

  /**
   * Commit a working tree: diff `workDir`'s files against the materialized view and
   * author edit_file / put_file / delete_file ops for the changes (the git `add`+`commit`
   * step, which agents do via operation.propose). Causally builds on the current frontier.
   *
   * A MODIFIED file is captured as `edit_file` with the previously projected content as its
   * 3-way merge base — that base is already in hand here, and blobs are content-addressed so
   * re-putting it is free (dedup). This is what lets two sessions editing disjoint regions of
   * one file auto-merge (L1) instead of colliding as two base-less `put_file`s (docs/15 §3).
   * ADDED files keep `put_file` (a create genuinely has no base), and so does any content that
   * is not losslessly UTF-8 text (see `#isMergeableText`).
   *
   * A MOVED file is recovered from the removed × added pair (`#detectRenames`, docs/19 §3.1)
   * and captured as `rename_file` — plus an `edit_file` at the NEW path, based on the content
   * from BEFORE the move, when it was edited on the way. Without this the reducer's whole
   * rename × edit commutativity is unreachable from real usage: a path-set diff turns every
   * move into a delete racing an edit and a create with nothing to merge against. Recovered
   * moves are reported in `renamed` and are NOT double-counted in `added`/`removed`.
   *
   * `workspace` scopes the capture to a converging workspace (docs/20 §3.3) — the git bridge
   * maps a topic branch to one. It has to reach BOTH ends: the authored ops carry the tag, and
   * the projection this diffs against is the WORKSPACE's view. Diffing disk against the base
   * view instead would re-capture the workspace's own earlier edits as brand-new changes on
   * every commit, and — since a move is recovered from a removal paired with an addition —
   * those stale removals could pair into renames that never happened.
   *
   * Capture also runs the early conflict warning with CROSS-LINE visibility: a competing
   * session may be on a different line, and a line-scoped check would never see it. The
   * warnings are returned (`contention`) so the CLI can put them in front of the human
   * running `git commit`.
   */
  async commitWorkingTree(
    workDir: string,
    opts: { message: string; actor: Actor; line?: string; workspace?: string; ignorePredicate?: (rel: string) => boolean },
  ): Promise<{
    ops: string[];
    added: string[];
    modified: string[];
    removed: string[];
    /** Moves recovered from the removed × added pairing (docs/19 §3.1). These paths do NOT
     *  also appear in `added`/`removed`. */
    renamed: { from: string; to: string }[];
    intent: string;
    contention: ContentionWarning[];
  }> {
    const view = opts.line ?? "main";
    const ws = opts.workspace ? { workspace: opts.workspace } : {};
    // The base to diff disk against is THIS scope's projection, workspace included.
    const res = await this.materialize(view, ws);
    const current = new Map((await this.materializedBytes(res)).map((f) => [f.path, f.bytes]));
    const disk = await this.#readWorkTree(workDir, opts.ignorePredicate);
    let added: string[] = [];
    const modified: string[] = [];
    let removed: string[] = [];
    for (const [path, content] of disk) {
      if (!current.has(path)) added.push(path);
      else if (!current.get(path)!.equals(content)) modified.push(path);
    }
    for (const path of current.keys()) if (!disk.has(path)) removed.push(path);

    // Recover moves before deciding op kinds: a paired path is a move, not an unrelated
    // delete + create, and must not be counted as both.
    const renamed = this.#detectRenames(removed, added, current, disk);
    if (renamed.length) {
      const movedFrom = new Set(renamed.map((r) => r.from));
      const movedTo = new Set(renamed.map((r) => r.to));
      removed = removed.filter((p) => !movedFrom.has(p));
      added = added.filter((p) => !movedTo.has(p));
    }

    const ops: string[] = [];
    const contention: ContentionWarning[] = [];
    if (!added.length && !modified.length && !removed.length && !renamed.length)
      return { ops, added, modified, removed, renamed, intent: "", contention };

    const intent = await this.createIntent({ title: opts.message, owner: opts.actor.id });
    const sess = await this.startSession({ intentOid: intent, actor: opts.actor });
    const deps = res.headOps;
    // Collect the early warnings each propose raises, de-duplicated per entity key.
    const seenKeys = new Set<string>();
    const collect = (warnings: ContentionWarning[]): void => {
      for (const w of warnings) {
        if (seenKeys.has(w.key)) continue;
        seenKeys.add(w.key);
        contention.push(w);
      }
    };
    const warn = { warnContention: true, contentionAcrossLines: true, onContention: collect } as const;
    // Moves first, sorted by source. The paired `edit_file` must causally FOLLOW its own
    // rename: it names the destination path, so if the two were concurrent the reducer would
    // read them as a move and an unrelated edit fighting over that path (docs/19 §3.2 leaves
    // rename-vs-destination a genuine contest, and rightly so). Depending on the rename also
    // states the truth — the author moved the file, then wrote to where it now lives.
    for (const { from, to } of renamed) {
      const rn = await this.proposeOperation({
        sessionOid: sess, intentOid: intent, actor: opts.actor,
        target: { entityKind: "file", entityId: from },
        body: { kind: "rename_file", fromPath: from, path: to },
        declaredPurpose: `move ${from} → ${to}`, causalDeps: deps, line: opts.line, ...ws, ...warn,
      });
      ops.push(rn);
      const base = current.get(from)!;
      const content = disk.get(to)!;
      if (base.equals(content)) continue; // a pure move needs no second op
      // Content changed on the way. Only mergeable text can say so as an edit; otherwise the
      // move stands and the new bytes go in byte-exact as a `put_file` at the new path.
      const common = { sessionOid: sess, intentOid: intent, actor: opts.actor, path: to, declaredPurpose: opts.message, causalDeps: [...deps, rn], line: opts.line, ...ws, ...warn };
      ops.push(
        this.#isMergeableText(base) && this.#isMergeableText(content)
          ? await this.proposeEdit({ ...common, newText: content.toString("utf8"), baseBlobOid: await this.putBlob(base) })
          : await this.proposeFileWrite({ ...common, content }),
      );
    }
    const isModified = new Set(modified);
    // One sorted pass over both categories keeps op authoring order (and therefore lamport
    // assignment) exactly as before; only the op KIND differs per category.
    for (const path of [...added, ...modified].sort()) {
      const content = disk.get(path)!;
      const base = isModified.has(path) ? current.get(path)! : undefined;
      const common = { sessionOid: sess, intentOid: intent, actor: opts.actor, path, declaredPurpose: opts.message, causalDeps: deps, line: opts.line, ...ws, ...warn };
      ops.push(
        base !== undefined && this.#isMergeableText(base) && this.#isMergeableText(content)
          ? await this.proposeEdit({ ...common, newText: content.toString("utf8"), baseBlobOid: await this.putBlob(base) })
          : await this.proposeFileWrite({ ...common, content }),
      );
    }
    for (const path of removed.sort()) {
      ops.push(await this.proposeOperation({ sessionOid: sess, intentOid: intent, actor: opts.actor, target: { entityKind: "file", entityId: path }, body: { kind: "delete_file", path }, declaredPurpose: `delete ${path}`, causalDeps: deps, line: opts.line, ...ws, ...warn }));
    }
    return { ops, added: added.sort(), modified: modified.sort(), removed: removed.sort(), renamed, intent, contention };
  }

  // ── git bridge (docs/14) ───────────────────────────────────────────────────
  /** Read `.avcs/config.json` (a torn/absent file is treated as empty). */
  async #readConfig(): Promise<Record<string, unknown>> {
    const p = join(this.store.root, "config.json");
    if (!existsSync(p)) return {};
    try { return JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>; } catch { return {}; }
  }

  /** Read the repo-local git-bridge mode (default `sidecar` for pre-existing repos). */
  async getGitMode(): Promise<GitMode> {
    return (await this.#readConfig()).gitMode === "committed" ? "committed" : "sidecar";
  }

  /** Whether `git-sync --commit` injects AVCS provenance trailers (default on). */
  async gitTrailerEnabled(): Promise<boolean> {
    return (await this.#readConfig()).trailer !== false;
  }

  /** Persist the git-bridge mode and (re)write `.avcs/.gitignore` to match it. */
  async setGitMode(mode: GitMode): Promise<void> {
    const cfg = await this.#readConfig();
    cfg.gitMode = mode;
    await this.store.writeAux("config.json", JSON.stringify(cfg, null, 2) + "\n");
    await this.#writeGitignore(mode);
    this.logger.info("git.mode", { mode });
  }

  /**
   * The git branch that carries the base view (docs/20 §3.1). The core stays git-agnostic:
   * this is a recorded NAME, and only the bridge ever compares it against a real branch.
   * Unset ⇒ `main`, which is what the bridge assumed before trunk existed.
   */
  async getTrunk(): Promise<string> {
    const t = (await this.#readConfig()).trunk;
    return typeof t === "string" && t.length ? t : DEFAULT_TRUNK;
  }

  /**
   * Every branch name that counts as trunk. With `trunk` configured it is the single
   * answer; with nothing configured BOTH `main` and `master` are trunk — exactly the pair
   * the pre-trunk bridge special-cased, so an unconfigured repository (a `master`-default
   * one included) keeps behaving as it always did (docs/20 W7).
   */
  async trunkBranches(): Promise<string[]> {
    const t = (await this.#readConfig()).trunk;
    return typeof t === "string" && t.length ? [t] : [...LEGACY_TRUNK_BRANCHES];
  }

  /** Record the trunk branch. Shares `config.json` with the git mode, so read-modify-write. */
  async setTrunk(branch: string): Promise<void> {
    const cfg = await this.#readConfig();
    cfg.trunk = branch;
    await this.store.writeAux("config.json", JSON.stringify(cfg, null, 2) + "\n");
    this.logger.info("git.trunk", { trunk: branch });
  }

  /**
   * Build the commit-message trailer block that links a git commit to its AVCS provenance
   * (the git→avcs half). A reader with the `.avcs/` history can resolve the checkpoint;
   * for a teammate without AVCS it is a harmless annotation (like `Co-authored-by`).
   */
  gitTrailer(info: { checkpoint: string; treeHash: string; intent?: string }): string {
    const lines = [`AVCS-Checkpoint: ${info.checkpoint}`, `AVCS-TreeHash: ${info.treeHash}`];
    if (info.intent) lines.push(`AVCS-Intent: ${info.intent}`);
    return lines.join("\n");
  }

  /** Record the git commit ↔ AVCS checkpoint back-link (the avcs→git half of provenance). */
  async recordGitCommit(sha: string, checkpointOid: string): Promise<void> {
    await this.store.setRef(`git:${sha}`, checkpointOid);
    this.logger.info("git.link", { sha, checkpoint: checkpointOid });
  }

  /** The checkpoint a git commit was synced from, if a back-link was recorded locally. */
  async gitCheckpoint(sha: string): Promise<string | null> {
    return this.store.getRef(`git:${sha}`);
  }

  /**
   * Resolve the canonical projection (path→content) a checkpoint froze, for provenance
   * verification. `treeHashOk` re-confirms the checkpoint's recorded treeHash still
   * reproduces from its frontier (internal integrity); `files` is what git's committed
   * tree at the linked SHA must match exactly for the commit to be a faithful projection.
   */
  async checkpointFiles(checkpointOid: string): Promise<{ treeHash: string; treeHashOk: boolean; files: { path: string; content: string }[] }> {
    const cp = await this.store.get<Checkpoint>(checkpointOid);
    const res = await this.materializeAt(cp.headOps);
    return { treeHash: cp.treeHash, treeHashOk: res.treeHash === cp.treeHash, files: await this.materializedFiles(res) };
  }

  /** Write `.avcs/.gitignore` for `mode`. Idempotent; safe to call on every sync. */
  async #writeGitignore(mode: GitMode): Promise<void> {
    await this.store.writeAux(".gitignore", mode === "committed" ? GITIGNORE_COMMITTED : GITIGNORE_SIDECAR);
    // In committed mode, a `.avcs/.gitattributes` (scoped to this dir — never the repo
    // root) keeps immutable object files out of diffs and off git's text-merge path; they
    // are content-addressed so distinct oids never collide, and identical oids are
    // byte-identical (no conflict). Mutable refs CAN still conflict — resolved by the
    // post-merge reindex+checkout, see docs/14.
    if (mode === "committed") {
      await this.store.writeAux(".gitattributes", "objects/** -diff -merge\noplog -diff\nobjlog -diff\n");
    }
  }

  /**
   * Relative store path for a working tree's provenance handoff. Keyed by the working
   * directory so concurrent `git commit`s from different git worktrees (which all share
   * this single store) don't clobber each other's pending handoff. `workDir` defaults to
   * the store dir, so a plain (non-worktree) repo keeps a single, stable pending slot.
   */
  #pendingRel(workDir: string): string {
    return join("pending", `${sha256hex(workDir).slice(0, 16)}.json`);
  }

  /**
   * Persist the provenance handoff for the git-hook trio (pre-commit writes it; the
   * prepare-commit-msg and post-commit hooks consume it). Local working state, git-ignored.
   * `workDir` is the working tree being committed (the git worktree dir), defaulting to
   * the store dir for a plain repo.
   */
  async writeGitPending(info: { checkpoint: string; treeHash: string; intent?: string }, workDir = this.dir): Promise<void> {
    await this.store.writeAux(this.#pendingRel(workDir), JSON.stringify(info) + "\n");
  }

  /** Read the pending provenance handoff for `workDir`, or null if none is staged. */
  async readGitPending(workDir = this.dir): Promise<{ checkpoint: string; treeHash: string; intent?: string } | null> {
    const p = join(this.store.root, this.#pendingRel(workDir));
    if (!existsSync(p)) return null;
    try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; }
  }

  /** Clear the pending provenance handoff for `workDir` (post-commit, after recording the back-link). */
  async clearGitPending(workDir = this.dir): Promise<void> {
    await rm(join(this.store.root, this.#pendingRel(workDir)), { force: true });
  }

  /**
   * Rebuild every rebuildable cache from the object store: the entity index AND the
   * op-log/obj-log. This is the recovery path after objects arrive OUTSIDE the normal
   * authoring code path — e.g. a `git pull`/`merge` that unions committed-mode
   * `.avcs/objects` straight onto disk. Those logs are git-ignored, so without this the
   * op-LOG (which `materialize` reads its op SET from) would stay stale and silently miss
   * the pulled ops. Rebuilding the op-log is therefore essential, not just cosmetic.
   * Idempotent.
   */
  async reindex(): Promise<{ ops: number }> {
    await rm(join(this.store.root, "indexes"), { recursive: true, force: true });
    let ops = 0;
    for await (const op of this.store.list<Operation>("operation")) {
      const oid = op.oid as string;
      for (const k of keysOf(op)) await this.store.appendEntityIndex(k, oid);
      ops++;
    }
    // Rebuild the op-log (materialize's op-set source) and refresh the obj-log (hub sync
    // cursor) so both reflect objects that arrived via git rather than the store's writes.
    await this.store.rebuildOpLog();
    this.#opCache.clear();
    await rm(join(this.store.root, "objlog"), { force: true }); // lazily backfilled on next read
    this.logger.info("reindex", { ops });
    return { ops };
  }

  /**
   * One-shot "prepare the working tree for `git commit`" (docs/14). The bridge between
   * AVCS development and a `git add`/`commit`/`push`:
   *   1. capture any direct working-tree edits as ops (so nothing a human/agent typed is
   *      lost — direct edits and agent-proposed ops converge into one history),
   *   2. gate: if the view has open (needs-human) conflicts, REFUSE — never let a
   *      conflicted tree be committed; the caller routes the human to `avcs conflicts`,
   *   3. checkpoint the verified state vector (the git "commit unit"), and
   *   4. re-project so the working tree is EXACTLY reduce()'s output (folding in any
   *      auto-merged concurrent ops), making git track the deterministic projection.
   * Git invocation (`git add`) is intentionally left to the caller/CLI so this core stays
   * git-agnostic; `.avcs/.gitignore` (ensured here) makes a plain `git add -A` mode-correct.
   */
  async gitSync(opts: { message: string; actor: Actor; line?: string; workspace?: string; workDir?: string; ignorePredicate?: (rel: string) => boolean }): Promise<{
    mode: GitMode;
    captured: { ops: string[]; added: string[]; modified: string[]; removed: string[]; renamed: { from: string; to: string }[]; intent: string };
    /** Cross-line early warnings the capture raised (docs/17 §15.3): another branch/session
     *  has live concurrent work on a file this commit touches. Advisory — never blocking. */
    contention: ContentionWarning[];
    conflicts: ReductionResult["conflicts"];
    checkpoint?: string;
    treeHash?: string;
    reprojected?: number;
  }> {
    // The STORE is single (`this.dir`); the working tree projected/captured may be a
    // separate git worktree (`workDir`). They coincide for a plain, non-worktree repo.
    const workDir = opts.workDir ?? this.dir;
    const view = opts.line ?? "main";
    const lineOpt = opts.line ? { line: opts.line } : {};
    // A workspace scope (docs/20 §3.3) has to travel the WHOLE round trip: the capture tags
    // its ops and diffs against the workspace's projection, the conflict gate reads the same
    // view, and the re-projection writes it back. Any one of them left on base would make
    // this working tree oscillate between two different trees.
    const wsOpt = opts.workspace ? { workspace: opts.workspace } : undefined;
    // 1. Capture direct working-tree edits as ops before anything else.
    const cap = await this.commitWorkingTree(workDir, { message: opts.message, actor: opts.actor, ...lineOpt, ...(wsOpt ?? {}), ...(opts.ignorePredicate ? { ignorePredicate: opts.ignorePredicate } : {}) });
    const captured = { ops: cap.ops, added: cap.added, modified: cap.modified, removed: cap.removed, renamed: cap.renamed, intent: cap.intent };
    // Ensure the gitignore reflects the current mode (pre-existing repos never wrote one).
    const mode = await this.getGitMode();
    await this.#writeGitignore(mode);
    // 2. Conflict gate.
    const res = await this.materialize(view, wsOpt);
    if (res.conflicts.length > 0) return { mode, captured, contention: cap.contention, conflicts: res.conflicts };
    // 3. Checkpoint the verified state. 4. Re-project the working tree.
    const checkpoint = await this.createCheckpoint(view, opts.message, wsOpt);
    const written = await this.checkoutInto(workDir, view, wsOpt);
    this.logger.info("git.sync", { view, mode, workspace: opts.workspace, capturedOps: captured.ops.length, checkpoint, treeHash: res.treeHash });
    return { mode, captured, contention: cap.contention, conflicts: [], checkpoint, treeHash: res.treeHash, reprojected: written.length };
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
   * Pack loose objects into a packfile (docs/11 B2) — a maintenance op that reduces inode
   * count and speeds full scans. Reads stay correct throughout (loose-first, then packs);
   * blobs are intentionally left loose so redaction can always scrub their bytes.
   */
  async pack(): Promise<{ packed: number }> {
    const r = await this.store.pack();
    this.logger.info("pack", { packed: r.packed });
    return r;
  }

  /**
   * Compaction (docs/11 B3): persist the current reduction of `view` as a durable base
   * snapshot. A COLD materialize loads it BY DEFAULT (Phase 13.3) and `reduceIncremental`s
   * only the ops added since — folding settled history into the base instead of replaying
   * it — while the original ops stay on disk (append-only audit preserved). Correctness is
   * the same invariant as Track A: reduceIncremental(base, current) ≡ full reduce, gated by
   * the property harness and (with AVCS_VERIFY_INCREMENTAL=1) a per-call self-check.
   */
  async compact(view = "main"): Promise<{ baseOps: number }> {
    this.#forceSnapshot = true;
    try {
      await this.materialize(view); // produces & stores #incSnap via #pass1Reduce
    } finally {
      this.#forceSnapshot = false;
    }
    if (!this.#incSnap) return { baseOps: 0 };
    await this.#persistSnapshot(view, this.#incSnap);
    const baseOps = this.#incSnap.input.ops.length;
    this.logger.info("compact", { view, baseOps });
    return { baseOps };
  }

  /**
   * Persist a snapshot as the view's durable compaction base, stamped with the
   * materializer version + active policy oid (Phase 13.3): a cold load rejects the file
   * when either changed, so a merge-algorithm or policy update silently invalidates stale
   * bases (the warm path's invalidation is NonIncrementalError, handled in #pass1Reduce).
   * Atomic write (D2): writeAux routes through the store's temp→fsync→rename→fsync-dir
   * path, so a reader sees old-or-complete — never a torn CBOR file.
   */
  async #persistSnapshot(view: string, snap: ReduceSnapshot): Promise<void> {
    const header = { materializerVersion: MATERIALIZER_VERSION, policyOid: (await this.store.getRef("policy")) ?? "default" };
    await this.store.writeAux(join("snapshot", `${view}.cbor`), encodeCbor({ header, snapshot: serializeSnapshot(snap) }));
    this.#persistedBaseOps.set(view, snap.input.ops.length);
  }

  /** Load a persisted compaction base into the in-memory incremental snapshot (B3).
   *  Rejects (and ignores) a corrupt file, a pre-13.3 headerless file, or a header whose
   *  materializer version / policy oid no longer matches — full reduce is always correct. */
  async #loadPersistedSnapshot(view: string): Promise<void> {
    const p = join(this.store.root, "snapshot", `${view}.cbor`);
    if (!existsSync(p)) return;
    try {
      const raw = decodeCbor(await readFile(p)) as { header?: { materializerVersion?: string; policyOid?: string }; snapshot?: unknown };
      const policyOid = (await this.store.getRef("policy")) ?? "default";
      if (raw.header?.materializerVersion !== MATERIALIZER_VERSION || raw.header?.policyOid !== policyOid || raw.snapshot === undefined) {
        this.metrics.inc("snapshot.cold.rejected");
        return; // stale/incompatible base → full reduce
      }
      this.#incSnap = deserializeSnapshot(raw.snapshot);
      this.#persistedBaseOps.set(view, this.#incSnap.input.ops.length);
      this.metrics.inc("snapshot.cold.loaded");
    } catch {
      this.#incSnap = null; // corrupt snapshot → full reduce (always correct)
      this.metrics.inc("snapshot.cold.rejected");
    }
  }

  /**
   * Garbage-collect (docs/10 WS-C). Reclaims only objects UNREACHABLE from the
   * authoritative graph — never the append-only audit history of accepted ops:
   *  - orphan blobs: stored blobs no remaining op references (incl. chunk blobs whose
   *    manifest is gone);
   *  - expired quarantine: outsider ops still quarantined (non-member, never promoted),
   *    past `quarantineTtlMs`, that nothing else builds on — the one place append-only
   *    yields (abandoned/spam contributions, docs/09 G5).
   * `dryRun` reports without deleting.
   *
   * `shared` opts IN to collecting shared-path caches (docs/21 §3.6). Plain `gc` never
   * touches them: re-installing a build environment is expensive, so the routine reclaim of
   * orphan blobs must not be able to cost somebody an install.
   */
  async gc(opts: { quarantineTtlMs?: number; dryRun?: boolean; shared?: boolean } = {}): Promise<{ blobs: string[]; quarantinedOps: string[]; sharedKeys: string[] }> {
    const ops = await this.store.collect<Operation>("operation");
    const ttl = opts.quarantineTtlMs ?? 7 * 24 * 3600_000;
    const now = Date.now();
    const memberships = await this.store.collect<Membership>("membership");
    const governanceActive = memberships.length > 0;
    const members = new Set(memberships.filter((m) => !m.revokedAt).map((m) => m.actorId));
    const promoted = new Set((await this.store.collect<Promotion>("promotion")).flatMap((p) => p.ops));
    const dependedOn = new Set(ops.flatMap((o) => o.causalDeps));

    const quarantinedOps: string[] = [];
    const removed = new Set<string>();
    if (governanceActive) {
      for (const o of ops) {
        const oid = o.oid as string;
        const quarantined = !members.has(o.actor.id) && !promoted.has(oid);
        if (!quarantined || dependedOn.has(oid)) continue;
        if (now - Date.parse(o.createdAt) < ttl) continue;
        quarantinedOps.push(oid);
        removed.add(oid);
      }
    }

    // Blobs referenced by REMAINING ops (+ chunks of referenced chunked manifests).
    const referenced = new Set<string>();
    for (const o of ops) {
      if (removed.has(o.oid as string)) continue;
      const b = o.body.blobOid;
      if (!b) continue;
      referenced.add(b);
      const blob = await this.store.get<Blob>(b).catch(() => null);
      if (blob?.chunked && blob.chunks) for (const c of blob.chunks) referenced.add(c);
    }
    const blobs = (await this.store.collect<Blob>("blob"))
      .map((b) => b.oid as string)
      .filter((oid) => !referenced.has(oid));

    if (!opts.dryRun) {
      for (const oid of quarantinedOps) await this.store.deleteObject(oid);
      for (const oid of blobs) await this.store.deleteObject(oid);
      // Objects were deleted from under the warm caches — drop them so the next
      // materialize re-tails from disk (GC'd op-log entries are then skipped).
      for (const oid of quarantinedOps) this.#opCache.delete(oid);
      for (const oid of blobs) this.#blobCache.delete(oid);
    }
    const sharedKeys = opts.shared ? await this.#collectSharedCaches(opts.dryRun ?? false) : [];
    this.logger.info("gc", { dryRun: opts.dryRun ?? false, blobs: blobs.length, quarantinedOps: quarantinedOps.length, sharedKeys: sharedKeys.length });
    return { blobs, quarantinedOps, sharedKeys };
  }

  /**
   * Every shared cache key that some current scope still derives (docs/21 §3.6).
   *
   * "Some current scope" is deliberately generous — the base view, every line, and every one
   * of those crossed with every known workspace. Deriving a key extra times only costs a
   * reduce; failing to derive one costs a re-install, so over-approximating live keys is the
   * cheap mistake and the one to make.
   */
  async #derivedSharedKeys(): Promise<Set<string>> {
    const entries = await this.readSharedPaths();
    const keys = new Set<string>();
    if (!entries.length) return keys;
    const views = ["main", ...(await this.listLines()).map((l) => l.name).filter((n) => n !== "main")];
    const workspaces = [undefined, ...(await this.workspaceNames())];
    for (const view of views) {
      for (const ws of workspaces) {
        const res = await this.materialize(view, ws ? { workspace: ws } : undefined);
        for (const e of entries) keys.add(Repo.deriveSharedKey(e.keyFrom, res.tree).key);
      }
    }
    return keys;
  }

  /** Delete the shared caches no scope derives any more. Returns the keys (sorted). */
  async #collectSharedCaches(dryRun: boolean): Promise<string[]> {
    const root = this.#sharedRoot();
    if (!existsSync(root)) return [];
    const live = await this.#derivedSharedKeys();
    const dead: string[] = [];
    for (const ent of await readdir(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || live.has(ent.name)) continue;
      dead.push(ent.name);
    }
    dead.sort();
    if (!dryRun) for (const key of dead) await rm(join(root, key), { recursive: true, force: true });
    return dead;
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
    const ops: Operation[] = [];
    for (const o of oids) if (await this.store.has(o)) ops.push(await this.store.get<Operation>(o)); // skip GC'd
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

  /**
   * Per-line provenance (`blame`, but for lines): who wrote each line of a file
   * and WHY. Entity-level {@link blame} answers "who owns this file now"; this
   * answers "why is THIS line here" — the operation that last wrote it, with
   * its actor, intent title and declared purpose.
   *
   * Derived, not stored: the entity's causal history is replayed and each op's
   * before→after line diff re-attributes the lines it changed (an insertion is
   * attributed to the inserting op, untouched lines keep their earlier owner).
   * No new object kind, no determinism impact.
   */
  async blameLines(
    entityKey: string,
    filePath: string,
    line = "main",
  ): Promise<
    Array<{
      line: number;
      text: string;
      op: string;
      actor: Actor;
      purpose: string;
      intentTitle?: string;
      at: string;
    }>
  > {
    const { diffHunks } = await import("../merge/merge3.ts");
    const res = await this.materialize(line);
    const final = (await this.materializedFiles(res)).find((f) => f.path === filePath);
    if (!final) return [];

    const split = (s: string): string[] =>
      s === "" ? [] : s.split("\n").slice(0, s.endsWith("\n") ? -1 : undefined);

    // Replay the history that actually shaped the file, carrying an owning op
    // per surviving line. `superseded` counts: a later put_file supersedes an
    // earlier one, but the earlier op still authored the lines it introduced —
    // dropping it would credit every line to the last write. Ops that never
    // landed (rejected / needs_decision / quarantined / still proposed) do not
    // contribute lines to the projection, so they are excluded.
    const LANDED = new Set(["accepted", "superseded"]);
    const hist = (await this.historyOf(entityKey)).filter((o) =>
      LANDED.has(res.statuses.get(o.oid as string) ?? ""),
    );
    let lines: string[] = [];
    let owners: string[] = [];
    const opsByOid = new Map<string, (typeof hist)[number]>();
    for (const op of hist) {
      opsByOid.set(op.oid as string, op);
      const after = split(
        (await this.materializedFiles(await this.materializeAt([op.oid as string]))).find(
          (f) => f.path === filePath,
        )?.content ?? "",
      );
      const nextOwners = new Array<string>(after.length);
      let cursor = 0; // index into `after` consumed so far
      let baseCursor = 0; // index into `lines` consumed so far
      for (const h of diffHunks(lines, after)) {
        // Unchanged run before this hunk keeps its previous owner.
        for (let k = 0; k < h.start - baseCursor; k++) {
          nextOwners[cursor + k] = owners[baseCursor + k]!;
        }
        cursor += h.start - baseCursor;
        baseCursor = h.start;
        // The hunk's replacement lines belong to this op.
        for (let k = 0; k < h.lines.length; k++) nextOwners[cursor + k] = op.oid as string;
        cursor += h.lines.length;
        baseCursor = h.end;
      }
      for (let k = 0; baseCursor + k < lines.length && cursor + k < after.length; k++) {
        nextOwners[cursor + k] = owners[baseCursor + k]!;
      }
      // Anything still unassigned (e.g. a fresh file) is this op's.
      for (let k = 0; k < after.length; k++) nextOwners[k] ??= op.oid as string;
      lines = after;
      owners = nextOwners;
    }

    const intentCache = new Map<string, string | undefined>();
    const out: Array<{
      line: number;
      text: string;
      op: string;
      actor: Actor;
      purpose: string;
      intentTitle?: string;
      at: string;
    }> = [];
    const finalLines = split(final.content);
    for (let i = 0; i < finalLines.length; i++) {
      const oid = owners[i] ?? owners[owners.length - 1];
      const op = oid ? opsByOid.get(oid) : undefined;
      if (!op) continue;
      if (!intentCache.has(op.intentOid)) {
        const intent = await this.readIntent(op.intentOid).catch(() => null);
        intentCache.set(op.intentOid, intent?.title);
      }
      const intentTitle = intentCache.get(op.intentOid);
      out.push({
        line: i + 1,
        text: finalLines[i]!,
        op: op.oid as string,
        actor: op.actor,
        purpose: op.declaredPurpose,
        ...(intentTitle ? { intentTitle } : {}),
        at: op.createdAt,
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
      await writeFile(full, synth ?? await this.readBlob(blobOid));
    }
  }

  /**
   * Freeze a view's verified state. `workspace` freezes that WORKSPACE's projection instead
   * of the bare base view (docs/20 §3.3): a commit on a topic branch contains the workspace's
   * tree, so a checkpoint of the base view would describe a tree git does not hold and
   * `avcs verify-git` would report every such commit as a mismatch. The scope is recorded on
   * the checkpoint so it can never be mistaken for a base-view one (`finalize` refuses it).
   */
  async createCheckpoint(viewName: string, summary: string, opts?: { workspace?: string }): Promise<string> {
    const view = await this.getView(viewName);
    const result = await this.materialize(viewName, opts?.workspace ? { workspace: opts.workspace } : undefined);
    const evidence: Checkpoint["evidence"] = {};
    const evidenceBinding: NonNullable<Checkpoint["evidenceBinding"]> = {};
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
      if (!ev.forOps.some((o) => result.statuses.get(o) === "accepted")) continue;
      // treeHash binding (Phase 13.4): evidence stamped against a DIFFERENT tree proves
      // that tree, not this one — exclude it. Stamped-and-matching evidence is "bound";
      // unstamped (legacy) evidence is accepted but recorded as such, so a protection
      // with requireBoundEvidence can refuse it at the finalize gate.
      if (ev.treeHash && ev.treeHash !== result.treeHash) continue;
      const binding = ev.treeHash ? "bound" : "legacy";
      // Bound evidence outranks legacy for the same kind; within a rank, last wins.
      if (evidenceBinding[ev.kind] === "bound" && binding === "legacy") continue;
      evidence[ev.kind] = ev.result;
      evidenceBinding[ev.kind] = binding;
    }
    const cp: Checkpoint = {
      type: "checkpoint",
      viewOid: view.oid as string,
      headOps: result.headOps,
      treeHash: result.treeHash,
      policyOid: (await this.store.getRef("policy")) as string,
      materializerVersion: MATERIALIZER_VERSION,
      evidence,
      // Only present when some evidence aggregated — an evidence-less checkpoint's
      // bytes (and oid) are identical to pre-13.4.
      ...(Object.keys(evidenceBinding).length ? { evidenceBinding } : {}),
      ...(opts?.workspace ? { workspace: opts.workspace } : {}),
      status: result.conflicts.length === 0 ? "verified" : "draft",
      summary,
      createdAt: new Date().toISOString(),
    };
    const oid = await this.store.put(cp);
    // `checkpoint:<view>:latest` names the view's own latest state; a workspace checkpoint is
    // a different tree, so it gets its own ref rather than displacing the base view's.
    await this.store.setRef(opts?.workspace ? `checkpoint:${viewName}:workspace:${opts.workspace}:latest` : `checkpoint:${viewName}:latest`, oid);
    return oid;
  }

  /** Resolve the materialized tree into {path, bytes} entries (byte-preserving). */
  async materializedBytes(result: ReductionResult): Promise<{ path: string; bytes: Buffer }[]> {
    const out: { path: string; bytes: Buffer }[] = [];
    for (const [path, blobOid] of result.tree) {
      const synth = result.synthBlobs.get(blobOid);
      out.push({ path, bytes: synth ?? (await this.readBlob(blobOid)) });
    }
    return out;
  }

  /** Resolve the materialized tree into {path, content} entries (utf8 text view). */
  async materializedFiles(result: ReductionResult): Promise<{ path: string; content: string }[]> {
    return (await this.materializedBytes(result)).map(({ path, bytes }) => ({ path, content: bytes.toString("utf8") }));
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
    if (result.conflicts.length || result.fileConflicts.length) {
      return {
        released: false,
        reason: `view has ${result.conflicts.length} open conflict(s) and ${result.fileConflicts.length} text merge conflict(s); resolve them before releasing`,
      };
    }
    const checkpointOid = await this.createCheckpoint(viewName, opts.summary ?? `release of ${viewName}`);
    const checkpoint = await this.store.get<Checkpoint>(checkpointOid);
    const { generateSbom } = await import("../release/sbom.ts");
    const sbom = generateSbom(await this.materializedBytes(result));

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
