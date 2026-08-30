// Public API surface for `@izagood/avcs` consumers (e.g. the avcshub hosting server).
//
// This is the package root export. Subpath exports (`@izagood/avcs/hub`, `/store`,
// `/identity`, `/types`, …) are declared in package.json#exports for callers that want a
// single module. Development and tests still run the raw `.ts` via type-stripping; only
// the published build (tsconfig.build.json → dist/) compiles this to JS + .d.ts.

// Repository / materialization
export { Repo } from "./api/repo.ts";
export type { GitMode, RemoteConfig, ContentionWarning, UndoResult, SharedPathEntry, SharedPathMode, SharedPathLink } from "./api/repo.ts";

// Content-addressing — the sacrosanct interop invariant. A consumer (e.g. avcshub)
// that stores objects MUST address them with THESE functions, not a re-implementation:
// any byte-level divergence in canonicalize/computeOid splits oids and treeHashes and
// silently breaks interop with avcs clients. Exposed so the canonical implementation is
// importable instead of copied. Also available as `@izagood/avcs/canonical`.
export { canonicalize, computeOid, sha256hex } from "./core/canonical.ts";

// Deterministic reduce/materialize core (also `@izagood/avcs/reducer`)
export { reduce, snapshotReduce, reduceIncremental, keysOf, conflictIdFor, detectFileConflicts, arbitrateFileConflicts, buildOpScorer } from "./reducer/reducer.ts";
export type { ReduceInput, ReductionResult, ReduceSnapshot, Conflict, AutoDecision } from "./reducer/reducer.ts";

// Policy engine + materializer algorithm identity (also `@izagood/avcs/policy`).
// MATERIALIZER_VERSION changes iff the merge algorithm changes — consumers can pin /
// detect determinism boundaries off it. See RELEASES.md.
export { defaultPolicy, evaluateOp, MATERIALIZER_VERSION } from "./reducer/policy.ts";

// Object storage + integrity
export { ObjectStore, CorruptObjectError } from "./store/objectStore.ts";
export type { FsckReport } from "./store/objectStore.ts";
// Raised when an `undo --purge` tombstone would be treated as file content (issue #97) —
// exported for the same reason CorruptObjectError is: a caller has to be able to catch it.
export { PurgedBlobError } from "./store/applyRedactions.ts";
export { MassDeleteError } from "./api/repo.ts";
// A consumer narrowing `catch (e)` needs the constructor, so it must be reachable from HERE —
// exporting it from `api/repo.ts` alone does not put it on the package surface. Methods ride
// along on `Repo`; standalone symbols do not. `RepoNotFoundError` shipped without this line
// and was unreachable from a consumer despite every core gate being green.
export { RepoNotFoundError } from "./api/repo.ts";
// The queue's own vocabulary, for a consumer that has to persist a reservation somewhere
// other than the local aux file (a multi-instance hub) and translate it back.
export type { IntegrationReservation } from "./api/repo.ts";

// Hub (server + client) — the replication / trust boundary avcshub productionizes
export { startHub, HUB_PROTOCOL_VERSION } from "./hub/hubServer.ts";
export type { HubHandle } from "./hub/hubServer.ts";
export { pushToHub, pullFromHub, finalizeOnHub } from "./hub/hubClient.ts";
export type { HubSigner } from "./hub/hubClient.ts";
// Live convergence (Phase 15): the sync-watch daemon behind `avcs sync --watch`.
export { runSyncWatch } from "./hub/syncWatch.ts";
export type { SyncWatchEvent, SyncWatchOpts } from "./hub/syncWatch.ts";
// SSH-style transport auth: embedders (e.g. a hosted hub) inject `resolvePublicKey` into
// startHub({ auth }); these helpers also let a client build/verify the credential directly.
export { buildAuthHeader, parseAuthHeader, verifyAuth, canonicalRequest, NonceCache, AUTH_SCHEME, DEFAULT_AUTH_WINDOW_MS } from "./hub/transportAuth.ts";
export type { AuthCredential, AuthResult, PublicKeyResolver } from "./hub/transportAuth.ts";

// Cryptographic actor identity (the app-layer authz backbone)
export { Keyring, generateKeypair, signMessage, verifyMessage } from "./core/identity.ts";
export type { Keypair, KeyRecord, Signature } from "./core/identity.ts";

// Observability seams (avcshub wires these to OTel / a real collector)
export { Logger, consoleLogger, silentLogger } from "./observe/logger.ts";
export type { LogEntry, LogLevel } from "./observe/logger.ts";
export { Metrics } from "./observe/metrics.ts";
export type { Timing } from "./observe/metrics.ts";

// Programmatic git-history import (issue #63) — also at `@izagood/avcs/importer`.
export {
  importGitHistory,
  gitCliSource,
  type GitHistorySource,
  type GitCommitRecord,
  type GitFileChange,
  type GitCliTarget,
  type ImportGitHistoryOptions,
  type ImportGitHistoryResult,
} from "./importer/gitHistory.ts";
