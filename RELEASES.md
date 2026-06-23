# Releases

avcs materialize is **content-addressed and deterministic**: the same operation graph
must reduce to the same `treeHash` on every replica. That makes determinism a public
contract, not an implementation detail. This file records every release, and in
particular every change to the **reduce/merge algorithm** or the **operation format**.

## Determinism & semver discipline

- A change that can make the **same op set materialize to a different `treeHash`**, or
  that **adds/removes/renames an `OperationKind`** or object field, is **breaking** for
  consumers that persist materialized state. It MUST be at least a **minor** bump
  (pre-1.0) — never a patch — and MUST appear here with a migration note.
- The merge algorithm carries its own identity: `MERGE3_VERSION` (in `src/merge/merge3.ts`)
  flows into `MATERIALIZER_VERSION` (in `src/reducer/policy.ts`), which is stamped into
  every materialize result (`materializerVersion`) and surfaced by the hub `/` endpoint.
  **Any change to the merge substrate MUST bump `MERGE3_VERSION`** so the stamp changes
  with it. Consumers can pin or branch on `MATERIALIZER_VERSION` to detect a boundary.

## Unreleased

**Added — SSH-style transport authentication for hub writes. `HUB_PROTOCOL_VERSION` 1 → 2.**

- Hub write endpoints (`POST /objects`, `POST /finalize`) can now require an `Authorization:
  AVCS-Sig …` credential: a per-request ed25519 signature over `METHOD\npath\nts\nnonce\n
  sha256(body)`, verified against the signer's registered public key. This authenticates the
  *request/connection* the way `git clone git@host` does — distinct from, and composable
  with, the existing object-level `authorizePush` gating. Read endpoints stay public
  (read-public, write-auth). Failure is **401** (vs the object gate's **403**).
  - Client: `avcs push <hub-url> [--as <actorId>]` signs writes with the local actor key;
    the key is auto-discovered (`--as` → `AVCS_ACTOR` → `.avcs/config.json` `actorId` → the
    sole key in the private keystore), reusing the same keypair already used to sign objects.
    An unsigned push still works against a hub that doesn't require auth.
  - Server: `startHub({ auth: { required, resolvePublicKey, windowMs } })`. The default
    resolver treats the hub's `member:<keyId>` registry as its `authorized_keys`; embedders
    inject `resolvePublicKey` to authenticate principals from their own user store.
  - Replay protection: a freshness window on `ts` (default 5 min) plus a bounded seen-nonce
    cache. `GET /version` advertises `auth: "required" | "none"`.
  - **Why:** the hub had no transport-layer authentication — only individual governance
    objects were signed. A hosted/shared hub needs to authenticate the *connection* (reject
    anonymous writes, attribute pushes) without inventing a new credential type; reusing the
    existing ed25519 identity is the SSH model.
  - **Compatibility:** protocol bump is backward-compatible for the conflict-free union
    (an old client against a no-auth hub is unchanged). A `required` hub returns 401 to an
    unsigned/old client — a clear error, not silent loss.

## 0.2.0

**Added (non-breaking) — content-addressing & core are now importable.**

- New subpath exports so consumers import the canonical implementation instead of
  re-deriving it:
  - `@izagood/avcs/canonical` — `canonicalize`, `computeOid`, `sha256hex`
  - `@izagood/avcs/reducer` — `reduce`, `snapshotReduce`, `reduceIncremental`, `keysOf`, …
  - `@izagood/avcs/policy` — `defaultPolicy`, `evaluateOp`, `MATERIALIZER_VERSION`
  - The same symbols are also re-exported from the package root (`@izagood/avcs`).
  - **Why:** content-addressing (`computeOid`/`canonicalize`) had no public export, so a
    hosting server had to re-implement it. Two parallel implementations of an
    invariant that must agree byte-for-byte is an interop hazard — any divergence
    splits oids/treeHashes. The canonical bytes now have a single source.

- `MATERIALIZER_VERSION` is now **composed from `MERGE3_VERSION`** (`avcs-text3/0.1.0`)
  instead of the stale literal `avcs-text-mvp/0.0.1`.
  - **Why:** the 0.1.1 rewrite (below) changed the merge algorithm but left
    `MATERIALIZER_VERSION` unchanged, so symbol-era and text-era results shared one
    version string. Composing it makes the merge3.ts guarantee self-maintaining: the
    stamp now changes exactly when the algorithm does.
  - **Migration:** materialize results stamped `avcs-text-mvp/0.0.1` by a **0.1.1**
    build were produced by the text algorithm but carry the old string — treat that
    string as ambiguous (symbol-era *or* 0.1.1 text-era). Results from **0.2.0+** carry
    `avcs-text3/0.1.0` and are unambiguous. Re-materialize if you rely on the stamp.

## 0.1.1 — ⚠️ retroactively a breaking (determinism) release

Shipped as a patch; it should have been a **minor**. "Language-neutral core": the
symbol-aware merge was replaced by a pure-text line-level 3-way merge (`docs/15`).

- **Operation format changed:** `set_symbol` / `rename_symbol` / `move_symbol` removed;
  `edit_file` added. `src/semantic/{symbols,contract}.ts` deleted; `src/merge/merge3.ts`
  added; reducer rewritten.
- **Determinism boundary:** an op set valid under both versions (e.g. concurrent edits
  to one file) can materialize to a **different `treeHash`** under 0.1.1 than under 0.1.0.
- **`MATERIALIZER_VERSION` was NOT bumped** — it stayed `avcs-text-mvp/0.0.1`, so the
  change was not observable from the stamp. Fixed in 0.2.0.
- **Consumer guidance:** pin avcs **exactly** (`0.1.0` or `0.1.1`, not `^0.1.0`) and
  adopt a new line only after re-materializing and diffing. Do not let `^0.1.0` float a
  determinism change into persisted state.

## 0.1.0

First npm publish of `@izagood/avcs` (engine/library for the avcshub hosting server).
Symbol-aware merge core. Exports: root, `/hub`, `/hub/client`, `/store`, `/identity`,
`/types`.
