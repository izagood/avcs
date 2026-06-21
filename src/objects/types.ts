// The AVCS object model.
//
// Everything that matters is a content-addressed, append-only object. Code is NOT
// stored as commits; it is a *projection* computed from the operation graph. The
// seven first-class object kinds:
//
//   intent     — why a change is being made (goal + constraints + scope)
//   session    — an agent/human work episode against an intent
//   operation  — a single semantic change unit (the real history)
//   evidence   — machine-checkable proof attached to operations
//   decision   — a recorded resolution of a conflict / design choice
//   checkpoint — a verified (ops + policy + materializer) state vector
//   view       — a query over the operation graph (replaces branches)
//
// Plus `blob` for raw content and `policy` for the merge rules.

export type ObjectType =
  | "blob"
  | "intent"
  | "session"
  | "operation"
  | "evidence"
  | "decision"
  | "checkpoint"
  | "view"
  | "policy"
  | "lease"
  | "release"
  | "line"
  | "membership"
  | "protection"
  | "promotion"
  | "redaction"
  | "override"
  | "approval";

/** ed25519 signature over an object's oid. Excluded from the oid hash. */
export interface Signature {
  keyId: string;
  alg: "ed25519";
  sig: string; // base64
}

export interface BaseObject {
  type: ObjectType;
  /** Content address. Filled in by the store on write; absent while building. */
  oid?: string;
  /** Optional signature by the producing actor over this object's oid (Phase 3). */
  sig?: Signature;
}

// ── Actors ──────────────────────────────────────────────────────────────────
export type ActorKind = "human" | "ai_agent" | "ci_bot";
export interface Actor {
  kind: ActorKind;
  /** Stable id, e.g. "human:jinbin" or "ai:claude-code". */
  id: string;
  /** For ai_agent: model identifier. */
  model?: string;
}

// ── blob ────────────────────────────────────────────────────────────────────
export interface Blob extends BaseObject {
  type: "blob";
  /** Base64 of the raw bytes (empty for a chunked manifest). */
  data: string;
  encoding: "base64";
  /**
   * Phase 9b: a large blob is split into chunk blobs and stored as a manifest
   * (data="", chunked=true, chunks=[oids]). Identical chunks dedup by oid, and
   * reads stream chunk-by-chunk instead of inflating one huge JSON object.
   */
  chunked?: boolean;
  chunks?: string[];
  /** Phase 12: set once a Redaction evicted the original bytes (oid preserved). */
  redacted?: boolean;
  redactionOid?: string;
}

// ── intent ──────────────────────────────────────────────────────────────────
export type IntentKind = "feature" | "bugfix" | "refactor" | "formatting" | "generated";
/** A file/glob scope the intent is allowed to touch. */
export type ScopeRef = string; // e.g. "file:src/cache/a.ts", "file:src/cache/*"
/** Machine-checkable invariants. `constraints` (NL) is human prose; these are enforced. */
export type ConstraintKind =
  | "forbid_public_api_break"
  | "forbid_behavior_change"
  | "require_tests";

export interface Intent extends BaseObject {
  type: "intent";
  title: string;
  owner: string; // actor id, usually a human
  kind: IntentKind;
  priority: "low" | "normal" | "high" | "critical";
  constraints: string[]; // natural-language invariants the change must preserve
  /** Structured, enforced invariants. Take precedence over NL `constraints`. */
  constraintKinds?: ConstraintKind[];
  successCriteria: string[];
  allowedScopes: ScopeRef[];
  createdAt: string;
}

// ── session ─────────────────────────────────────────────────────────────────
export interface Session extends BaseObject {
  type: "session";
  intentOid: string;
  actor: Actor;
  baseViewOid: string | null;
  /** Distilled, redaction-safe context. Raw transcripts live out of band. */
  summary: string;
  openedEntities: ScopeRef[];
  toolCalls: string[];
  startedAt: string;
}

// ── operation ───────────────────────────────────────────────────────────────
// Operations carry the full semantic envelope. The merge substrate is LANGUAGE-NEUTRAL
// (docs/15): a file is text, merged by line-level 3-way merge. `put_file` writes whole
// content; `edit_file` carries the content an agent produced together with the base it
// was derived from, so concurrent disjoint edits to the same file auto-merge (merge3)
// and only overlapping line ranges conflict. NO code-structure (symbol/AST) awareness.
// The reducer keys contention on `keysOf(op)` — every file op keys on `file:<path>`.
export type OperationKind =
  | "put_file" // create or replace whole file content (no base → not 3-way mergeable)
  | "edit_file" // new full content derived from a known base → line-level 3-way merge
  | "delete_file"
  | "rename_file" // identity-preserving move
  | "note"; // metadata-only op (e.g. record an effect), never mutates the tree

export interface OperationTarget {
  /** What conceptual entity this op changes. */
  entityKind: "file" | "contract" | "config" | "test";
  /** Stable entity id — for files, the path. */
  entityId: string;
}

export interface OperationBody {
  kind: OperationKind;
  /** put_file / edit_file / rename_file destination path. */
  path?: string;
  /** rename_file source path. */
  fromPath?: string;
  /** put_file / edit_file new full file content (blob oid). */
  blobOid?: string;
  /** edit_file: the blob this edit was derived from — the 3-way merge base.
   *  Empty/absent ⇒ base is the empty file. */
  baseBlobOid?: string;
}

export interface Operation extends BaseObject {
  type: "operation";
  sessionOid: string;
  intentOid: string;
  actor: Actor;
  target: OperationTarget;
  body: OperationBody;
  /** Direct causal predecessors (this op was authored "after" seeing these). */
  causalDeps: string[];
  /** Human/agent statement of purpose for this single op. */
  declaredPurpose: string;
  /** Declared reads/effects — used by the semantic-conflict detector. */
  effects?: {
    reads?: ScopeRef[];
    changesBehavior?: boolean;
    breaksPublicApi?: boolean;
  };
  /** Lamport time for deterministic tie-break of concurrent ops. */
  lamport: number;
  createdAt: string;
  /** Self-reported confidence; advisory, never authoritative. */
  confidence?: number;
  /**
   * Lineage (Phase 8). Which line this op was authored on; absent ⇒ "main". A line
   * materializes only its own ops + everything inherited from its fork checkpoint, so
   * two lines can hold intentionally different content on the same entity without
   * contending. See docs/09 G1.
   */
  line?: string;
  /**
   * Workspace scope (docs/16). Isolates an op to a converging build/verify workspace:
   * a base-line view EXCLUDES workspace-tagged ops, while that workspace's own view sees
   * base + its ops. Absent ⇒ the op belongs directly to its line. Distinct from `line`
   * (which diverges long-term); a workspace converges and is meant to `land` onto its base.
   */
  workspace?: string;
  /** Provenance for a ported/backported/cherry-picked op: the source op's oid. */
  derivedFrom?: string;
  /** The op this one reverts (forward-only inverse). */
  revertOf?: string;
  /** Additional authors (git Co-authored-by). The signing `actor` stays single. */
  coAuthors?: Actor[];
  /** Stash: kept local — excluded from gossip/pull until promoted to shared. */
  private?: boolean;
}

// Operation lifecycle status is *not* stored on the immutable op. It is derived
// from the presence of evidence/decision objects + policy at materialization time.
export type OperationStatus =
  | "proposed"
  | "validating"
  | "accepted"
  | "rejected"
  | "superseded"
  | "needs_decision"
  | "quarantined";

// ── evidence ────────────────────────────────────────────────────────────────
export type EvidenceKind =
  | "parse"
  | "typecheck"
  | "lint"
  | "unit_test"
  | "integration_test"
  | "benchmark"
  | "security_scan"
  | "api_compat";
export type EvidenceResult = "pass" | "fail" | "partial" | "not_run";

export interface Evidence extends BaseObject {
  type: "evidence";
  forOps: string[];
  kind: EvidenceKind;
  result: EvidenceResult;
  command?: string;
  detail?: string;
  producedBy: Actor;
  createdAt: string;
  /**
   * Phase 11: produced by a secret-less, network-isolated runner over untrusted code.
   * Such evidence is NOT trusted for the policy gate (you must re-run in the trusted
   * lane after promotion) — it's the pull_request_target hazard guard.
   */
  fromUntrustedRunner?: boolean;
}

// ── decision ────────────────────────────────────────────────────────────────
export interface Decision extends BaseObject {
  type: "decision";
  conflictId: string;
  chosenOps: string[];
  rejectedOps: string[];
  reason: string;
  decidedBy: Actor;
  /** Optional reusable rule distilled from this decision. */
  futurePolicy?: string;
  createdAt: string;
}

// ── view ────────────────────────────────────────────────────────────────────
// A branch replacement: a declarative query over the operation graph.
export interface ViewQuery {
  /** Only ops in these statuses are candidates (post-reduction). */
  includeStatuses: OperationStatus[];
  /** Restrict to these intents (empty = all). */
  intentOids?: string[];
  /** Restrict to these sessions (empty = all). */
  sessionOids?: string[];
  /** Hard-exclude specific ops. */
  excludeOps?: string[];
  /** Lineage (Phase 8): which line to materialize. Absent ⇒ "main". */
  line?: string;
}

export interface View extends BaseObject {
  type: "view";
  name: string;
  baseViewOid: string | null;
  query: ViewQuery;
  createdAt: string;
}

// ── checkpoint ──────────────────────────────────────────────────────────────
export interface Checkpoint extends BaseObject {
  type: "checkpoint";
  viewOid: string;
  /** Frontier operation ids that define this state. */
  headOps: string[];
  treeHash: string;
  policyOid: string;
  materializerVersion: string;
  evidence: Partial<Record<EvidenceKind, EvidenceResult>>;
  status: "draft" | "verified" | "released";
  summary: string;
  createdAt: string;
}

// ── policy ──────────────────────────────────────────────────────────────────
// The reducer is parameterized by a policy object so that materialization is a pure
// function of (ops, decisions, policy, materializer). Changing policy yields a new,
// distinguishable checkpoint.
export interface PolicyRule {
  name: string;
  /** Coarse trigger; the engine matches these against each conflict/op. */
  when: {
    opKind?: OperationKind;
    breaksPublicApi?: boolean;
    changesBehavior?: boolean;
    onConflict?: boolean;
  };
  /** Effect on priority/decision. */
  effect:
    | { type: "require_human" }
    | { type: "require_evidence"; evidence: EvidenceKind; result: EvidenceResult }
    | { type: "priority"; weight: number }
    | { type: "prefer_actor"; kind: ActorKind };
}

/** Maps a scope pattern to the actor ids that must approve changes there (Phase 5). */
export interface OwnerRule {
  scope: ScopeRef;
  owners: string[];
}

export interface Policy extends BaseObject {
  type: "policy";
  version: string;
  /** Ordered actor trust ladder (higher index = more trusted). */
  actorTrust: ActorKind[];
  rules: PolicyRule[];
  /** Code ownership: who must sign off on changes to which scopes. */
  owners?: OwnerRule[];
  createdAt: string;
}

// ── lease (Phase 3) ───────────────────────────────────────────────────────────
// A soft, optimistic reservation over entity scopes. Reduces conflicts at the START
// of work instead of resolving them after: an exclusive write-lease on a scope warns
// the next writer before they duplicate effort. Not a hard lock — leases expire.
export interface WorkLease extends BaseObject {
  type: "lease";
  intentOid: string;
  sessionOid: string;
  actor: Actor;
  /** Scopes this lease reserves for writing, e.g. "symbol:mod.ts#alpha", "file:a.ts". */
  writeScopes: ScopeRef[];
  mode: "exclusive" | "shared";
  acquiredAt: string;
  expiresAt: string;
  /** Set when explicitly released before expiry. */
  releasedAt?: string;
}

// ── release (Phase 6) ─────────────────────────────────────────────────────────
// A Release is not a name tag (git's lightweight tag). It is a *verified checkpoint*
// + the evidence that verified it + the SBOM of what shipped + signed-off artifacts.
// This makes "what is in production and why is it trustworthy" answerable.
export interface SbomComponent {
  type: "file" | "library";
  name: string;
  version?: string;
  /** sha256 of the file content, for "file" components. */
  hash?: string;
}
export interface Sbom {
  bomFormat: "CycloneDX";
  specVersion: string;
  components: SbomComponent[];
}
/** A built artifact tied to this release (container image, bundle, firmware…). */
export interface ArtifactRef {
  type: string; // e.g. "container_image", "npm_tarball"
  ref: string; // e.g. "registry/app:1.2.3"
  digest?: string; // e.g. "sha256:…"
}

export interface Release extends BaseObject {
  type: "release";
  checkpointOid: string;
  treeHash: string;
  sbom: Sbom;
  artifacts: ArtifactRef[];
  /** Aggregated evidence of the verified checkpoint. */
  evidence: Partial<Record<EvidenceKind, EvidenceResult>>;
  /** Actor ids that signed off on this release. */
  signedBy: string[];
  status: "draft" | "released";
  /** Semantic version + support lifecycle (Phase 6 follow-up). */
  version?: string;
  supportStatus?: "supported" | "maintenance" | "eol";
  createdAt: string;
}

// ── line (Phase 8) ────────────────────────────────────────────────────────────
// A long-lived lineage (e.g. "v1.x") that forked from a base line at a checkpoint.
// It inherits the base's history up to the fork (the checkpoint's frontier) and then
// diverges: ops authored on the base AFTER the fork are not part of this line.
export interface Line extends BaseObject {
  type: "line";
  name: string;
  baseLine: string | null; // the line it forked from; null for the root ("main")
  forkCheckpointOid: string | null; // base line's frozen frontier at fork time
  createdAt: string;
}

// ── governance (Phase 7) ──────────────────────────────────────────────────────
export type RoleName = "reader" | "proposer" | "reviewer" | "maintainer" | "admin";

/** Root-signed membership: federates trust and grants a role. See docs/08. */
export interface Membership extends BaseObject {
  type: "membership";
  actorId: string;
  publicKey: string;
  role: RoleName;
  scopes?: ScopeRef[]; // empty ⇒ org-wide; else a scoped maintainer/reviewer
  issuedBy: string; // root keyId
  createdAt: string;
  revokedAt?: string;
}

/** Branch-protection-equivalent rule on a protected view. */
export interface Protection extends BaseObject {
  type: "protection";
  view: string;
  requiredApprovals: number;
  requireOwnerApproval: boolean;
  requiredChecks: EvidenceKind[];
  finalizeRole: "maintainer" | "admin";
  requireSignedOps: boolean;
  requireUpToDate: boolean; // reject stale (non-fast-forward) finalize
  allowForcePush: boolean; // even admins can't roll the head back unless true
  createdAt: string;
}

/**
 * Phase 11: a reviewer's promotion of quarantined (outsider) ops into the normal
 * accepted flow — the GitHub "maintainer accepts a fork PR" moment.
 */
export interface Promotion extends BaseObject {
  type: "promotion";
  ops: string[];
  by: string; // actor id (role ≥ reviewer)
  reason?: string;
  createdAt: string;
}

// ── security (Phase 12) ───────────────────────────────────────────────────────
/**
 * Admin-signed tombstone that evicts a blob's bytes (e.g. a leaked secret) while
 * preserving its oid — so the Merkle DAG, causalDeps, and treeHash references stay
 * valid and verifiable, but the plaintext is gone from every replica. GitHub's
 * secret-purge/BFG analog for an append-only, content-addressed store.
 */
export interface Redaction extends BaseObject {
  type: "redaction";
  blobOid: string;
  sha256: string; // of the original bytes (provenance; the bytes themselves are gone)
  length: number;
  reason: string;
  by: string; // actor id (role admin)
  createdAt: string;
}

/** A reviewer's sign-off on a checkpoint (= PR approve). Gates finalize. */
export interface Approval extends BaseObject {
  type: "approval";
  checkpointOid: string;
  by: string; // actor id (role ≥ reviewer)
  verdict: "approve" | "request_changes";
  reason?: string;
  createdAt: string;
}

/** Break-glass: a signed, EXPIRING waiver of specific required checks for a view. */
export interface Override extends BaseObject {
  type: "override";
  view: string;
  waiveChecks: EvidenceKind[];
  reason: string;
  by: string;
  expiresAt: string;
  createdAt: string;
}

export type AnyObject =
  | Blob
  | Intent
  | Session
  | Operation
  | Evidence
  | Decision
  | View
  | Checkpoint
  | Policy
  | WorkLease
  | Release
  | Line
  | Membership
  | Protection
  | Promotion
  | Redaction
  | Override
  | Approval;
