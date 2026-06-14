# docs/13 — Hub multi-user production hardening (Track E)

The convergence engine (`reduce`) is already production-grade: any node holding the
same op SET reduces to the same `treeHash`, independent of arrival order
(reducer.ts canonical sort + Kahn topo-sort), with content-addressing as the
integrity backbone. Track E does **not** touch that engine. It hardens the
*replication + trust boundary* around it — the layer that (a) delivers the correct
op set to every replica, (b) stops unauthorized mutation of the inputs that feed
`reduce`, and (c) prevents data destruction.

The leverage: AVCS already has cryptographic actor identity (ed25519-signed
operations and memberships, `core/identity.ts`). So authorization can be enforced
**cryptographically at the application layer** — no transport-level identity
provider required for the in-repo stages. Transport security (TLS/OIDC/replicated
storage) is deployment infrastructure and is documented-only (see "Infra" below).

## Termination condition

Hub multi-user production is "possible" when, for independently-developed work
pushed by multiple users and pulled by others:

1. **Convergent** — everyone who has the same ops ends at the same final code, and
   sync always *can* deliver the same op set (completeness + scale).
2. **Authorized** — no unauthenticated party can change a replica's materialized
   result (no decision/membership/redaction injection) or read what they shouldn't.
3. **Non-destructive** — no party can irrecoverably destroy or corrupt history;
   side-effects (redaction) are isolated and admin-gated.
4. **No silent divergence** — an object the hub accepts verifies identically on
   every replica; a partial/causally-incomplete push never materializes wrong code.

## Stages (dependency-ordered)

The security chain **E1 → E2 → E3** is the critical path (highest severity).
E4/E5/E6 are independent and can land in parallel. E7 is operability.

| Stage | Blocker (from the audit) | Fix | Severity | Depends |
|---|---|---|---|---|
| **E1** | gated hub verifies a signature over the client-*claimed* `op.oid`, but `put()` stores under the *recomputed* content oid → an op the hub accepts can be rejected by pulling replicas → divergence (hubServer.ts:44 vs 212) | verify the signature over the **recomputed content oid** (`computeOid`), so hub-accept ⟹ replica-accept | High | — |
| **E2** | only `type==="operation"` is gated; `decision`/`membership`/`redaction` are waved through unauthenticated, yet a pushed `decision` changes `verdictMap` on every replica (hubServer.ts:204) | authenticate & authorize **all governance object types** by signature + membership role; reject unsigned/under-privileged governance pushes | High | E1 |
| **E3** | open hub trusts ALL redactions and runs `applyRedactions` inline, unlocked → any client can irrecoverably evict any blob (DoS), and concurrent redactions race (applyRedactions.ts:37-39, hubServer.ts:215) | require an admin-signed redaction even on an ungated hub; serialize the side-effect under `store.withLock` | High | E2 |
| **E4** | a push is N independent POSTs (non-atomic); an op whose `causalDeps` haven't arrived materializes without its ancestor → transient wrong tree (hubClient.ts:37-53) | accept ops but **hold causally-incomplete ones** (quarantine) until their deps arrive; never project an op missing a dep | Med | — |
| **E5** | `GET /have` serializes every oid every sync → O(total history) per sync, no cursor (hubServer.ts:153-158) | **since-cursor incremental sync**: a general append-only `objlog` + `GET /sync?since=N` + a persisted per-hub pull cursor (full `/have` fallback). Incremental **pull** done; incremental **push** (idempotent re-POST of the local objlog delta) is a documented follow-up | Med (scale) | — |
| **E6** | protected-head CAS runs only on the central repo; `setRef` is a plain write with no compare-and-swap (objectStore.ts setRef) | server-side **CAS finalize endpoint** + ref lock so authority never overwrites fresher history | Med | — |
| **E7** | no provenance/audit of who pushed what; no app-layer rate-limit/quota | push audit log + per-actor quota; extend `fsck` to hub-held objects | Low–Med | E2 |

## Infra-dependent — documented-only (out of sandbox, Track C kin)

These require a deployment environment, not application code:
- **TLS / mTLS** termination (transport encryption + mutual auth) — reverse proxy.
- **OIDC / token IdP** binding transport identity to the app-layer authz of E2.
- **Durable / replicated storage** backend (today: single-process local files) —
  object storage / a replicated log.
- **Edge rate-limiting / WAF**, **HSM / threshold keys**, **OTel collector**.

## Invariants Track E must not break

- **Determinism**: no stage changes `reduce`'s output for a given op set — all E
  work is replication/trust-boundary, never reduction logic.
- **Reuse cryptographic identity**: enforce authz with the existing signature /
  membership machinery rather than inventing a new auth system.
- **Default-safe**: unsigned, under-privileged, or causally-incomplete input is
  rejected or quarantined — never silently applied.
- **Backward-compatible sync**: incremental sync falls back to the full `have`
  set; signature enforcement rolls out warn-then-reject.
- **Each stage = a merged PR** with the multi-node convergence harness re-run.
