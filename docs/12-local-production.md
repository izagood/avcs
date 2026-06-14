# docs/12 — Local production hardening (Track D)

The determinism engine (`reduce`) is already production-grade: same op set ⇒ same
`treeHash`, enforced by the property harness. What stands between AVCS and a
*local* production VCS — "in an agent environment the final code stays stable,
correct, and recoverable" — is the durability and integrity skin around that
engine. Track D closes those gaps. Each stage is opt-in-safe (no default-on
behaviour change that could break determinism) and ships as a merged PR.

## Termination condition

Local production is "possible" when a normal local workflow
(init → propose → materialize → checkout/commit) is:

1. **Durable** — an object/ref/op-log entry that a call reported as written
   survives a hard crash (power loss), not just a clean process exit.
2. **Recoverable & self-checking** — corruption or drift (a bit-flipped object,
   an op-log shorter than the object set) is *detectable* and *repairable*
   without a full re-clone.
3. **Correct under symbol merges** — symbol-granular ops never silently
   materialize wrong code; an unparseable splice degrades to a safe, flagged
   path instead of corrupting content.

## Stages

| Stage | Gap (from the audit) | Fix | Severity |
|---|---|---|---|
| D1 | `#writeAtomic` fsyncs the file but not the containing directory; `appendFile` (oplog, entity index) isn't fsynced — a hard crash can drop a just-written object/ref/HEAD/op-log line | fsync the directory after every rename, fsync the file+dir after every append. `AVCS_NO_FSYNC=1` escape hatch for bulk import. | Med |
| D2 | `compact()` writes the snapshot with a plain `writeFile` (torn CBOR on crash) | route it through `#writeAtomic` | Low |
| D3 | no integrity check: nothing re-hashes objects (bit-rot) or detects op-log drift | `avcs fsck` — re-hash loose objects (oid==content), validate pack idx offsets, report op-log drift, `--rebuild` to repair the op-log | Med |
| D5 | the symbol parser is an approximate brace/regex scanner; a `set_symbol` on code it can't parse can splice wrong content — deterministic but incorrect | round-trip / safe-fallback guard: a splice that doesn't verifiably round-trip degrades to whole-file replace (or is flagged), never silent corruption | Med |

(D4 — automatic op-log reconciliation — is folded into D3's `fsck --rebuild`.)

## Invariants Track D must not break

- **Determinism**: no stage may change `reduce`'s output for a given op set. D1/D2
  are pure I/O durability; D3 is read-only (except `--rebuild`, which only
  rewrites the op-log *cache* to match the object set — the source of truth);
  D5 changes only the materialized content of *unparseable* symbol splices, and
  its equivalence with the old behaviour on parseable input is property-tested.
- **Append-only**: no stage deletes or mutates an object except the existing
  redaction/GC exceptions.
- **Default-safe**: durability is default-on (correct by default); the only flag
  is the `AVCS_NO_FSYNC` *opt-out* for throughput-bound bulk loads.
