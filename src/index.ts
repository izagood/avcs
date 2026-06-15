// Public API surface for `@izagood/avcs` consumers (e.g. the avcshub hosting server).
//
// This is the package root export. Subpath exports (`@izagood/avcs/hub`, `/store`,
// `/identity`, `/types`, …) are declared in package.json#exports for callers that want a
// single module. Development and tests still run the raw `.ts` via type-stripping; only
// the published build (tsconfig.build.json → dist/) compiles this to JS + .d.ts.

// Repository / materialization
export { Repo } from "./api/repo.ts";

// Object storage + integrity
export { ObjectStore, CorruptObjectError } from "./store/objectStore.ts";
export type { FsckReport } from "./store/objectStore.ts";

// Hub (server + client) — the replication / trust boundary avcshub productionizes
export { startHub, HUB_PROTOCOL_VERSION } from "./hub/hubServer.ts";
export type { HubHandle } from "./hub/hubServer.ts";
export { pushToHub, pullFromHub, finalizeOnHub } from "./hub/hubClient.ts";

// Cryptographic actor identity (the app-layer authz backbone)
export { Keyring, generateKeypair, signMessage, verifyMessage } from "./core/identity.ts";
export type { Keypair, KeyRecord, Signature } from "./core/identity.ts";

// Observability seams (avcshub wires these to OTel / a real collector)
export { Logger, consoleLogger, silentLogger } from "./observe/logger.ts";
export type { LogEntry, LogLevel } from "./observe/logger.ts";
export { Metrics } from "./observe/metrics.ts";
export type { Timing } from "./observe/metrics.ts";
