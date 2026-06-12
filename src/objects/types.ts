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
  | "lease";

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
  /** Base64 of the raw bytes. (MVP keeps it simple; large blobs get chunked later.) */
  data: string;
  encoding: "base64";
}

// ── intent ──────────────────────────────────────────────────────────────────
export type IntentKind = "feature" | "bugfix" | "refactor" | "formatting" | "generated";
/** A symbol/file/glob scope the intent is allowed to touch. */
export type ScopeRef = string; // e.g. "file:src/cache/*", "symbol:UserService.findById"
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
// Operations carry the full semantic envelope. `put_file` is whole-file (Phase 1);
// `set_symbol` (Phase 2) edits one named top-level symbol so disjoint-symbol edits to
// the same file auto-merge. The reducer keys contention on `keysOf(op)`.
export type OperationKind =
  | "put_file" // create or replace whole file content
  | "delete_file"
  | "rename_file" // identity-preserving move
  | "set_symbol" // replace one named top-level symbol's text within a file
  | "note"; // metadata-only op (e.g. record an effect), never mutates the tree

export interface OperationTarget {
  /** What conceptual entity this op changes. */
  entityKind: "file" | "symbol" | "contract" | "config" | "test";
  /** Stable entity id. file: the path. symbol: `<path>#<symbolName>`. */
  entityId: string;
}

export interface OperationBody {
  kind: OperationKind;
  /** put_file / rename_file / set_symbol destination path. */
  path?: string;
  /** rename_file source path. */
  fromPath?: string;
  /** put_file content, or set_symbol's new symbol text. */
  blobOid?: string;
  /** set_symbol: the top-level symbol name being replaced. */
  symbolName?: string;
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
  | WorkLease;
