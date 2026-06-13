// Incremental reduce (docs/11 Track A, stage A0).
//
// Public entry points for O(Δ) re-reduce. The implementation lives in reducer.ts so it
// can reuse the file-private decision/materialization helpers without widening the
// module's API surface (determinism-critical code stays encapsulated). This module is
// the stable boundary the rest of the system imports.
//
// Contract: `reduceIncremental(snapshotReduce(base), next)` is structurally identical to
// `reduce(next)` whenever `next` is an append-superset of `base` (same policy/authority/
// materializeStatuses). The differential property harness (test/incremental-equivalence)
// enforces this. When the preconditions don't hold it throws NonIncrementalError and the
// caller falls back to a full reduce — never a silent divergence.
export {
  reduceIncremental,
  snapshotReduce,
  NonIncrementalError,
  type ReduceSnapshot,
  type PerKeyDecision,
  type IncrementalStats,
} from "./reducer.ts";
