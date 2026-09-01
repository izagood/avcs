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
- **The release automation derives the level from the commit SUBJECT** (`.github/workflows/release.yml`):
  `fix:`/`perf:` → patch, `feat:` → minor, `<type>!:` or `BREAKING CHANGE` → minor. So a
  determinism-affecting change committed as a plain `fix:` gets released as a **patch**, which
  this section forbids. Such a change MUST carry `!` in its subject (`fix(merge)!: …`) or set
  `package.json#version` above the latest tag in the PR (the workflow's manual-override path).
  Learned the hard way: v0.48.1 shipped a `treeHash`-changing fix as a patch because its
  subject was `fix(merge):` — see the v0.49.0 entry.
- The merge algorithm carries its own identity: `MERGE3_VERSION` (in `src/merge/merge3.ts`)
  flows into `MATERIALIZER_VERSION` (in `src/reducer/policy.ts`), which is stamped into
  every materialize result (`materializerVersion`) and surfaced by the hub `/` endpoint.
  **Any change to the merge substrate MUST bump `MERGE3_VERSION`** so the stamp changes
  with it. Consumers can pin or branch on `MATERIALIZER_VERSION` to detect a boundary.

## Unreleased

**Fixed (determinism) — a pure deletion no longer leaves a blank line behind.
`MERGE3_VERSION` `text3/0.3.0` → `text3/0.3.1`. This CHANGES `treeHash` for any op set that
contains a pure deletion.**

**Version note, honestly: the code shipped in `v0.48.1` as a PATCH, which this file forbids.**
The automation derives the level from the commit subject, and the fix was committed as
`fix(merge):` rather than `fix(merge)!:`. `v0.49.0` re-publishes the same code under a correct
MINOR boundary — if you are already on `v0.48.1` you have the fix, and the version number is
the only difference. **Do not use the version number alone to decide whether you are across
the boundary; use `materializerVersion`** (`text3/0.3.0` before, `text3/0.3.1` after), which is
stamped on every materialize result precisely because it cannot drift from the algorithm.

- `merge3` was not the identity on a single variant: a span the variant deleted entirely came
  back as ONE BLANK LINE. `renderSpan` returned joined text and the caller re-split it, but
  `"".split("\n")` is `[""]` — one empty line, not zero. So "delete these lines" reduced to
  "replace these lines with one blank line"; `[]` and `[""]` were indistinguishable after the
  round trip through a string.
- **Not blank-line specific — ANY pure deletion.** Deleting the head of a file put a blank
  line at the top; deleting every line left one blank line instead of an empty file.
  Replacements and insertions were always correct, which is why this survived: every shape
  whose render is non-empty round-trips fine.
- `renderSpan` returns `string[]` and the cluster path pushes those lines directly. The
  render-dedupe key carries the line COUNT (joined text cannot tell zero lines from one empty
  line). `ConflictOption.text` keeps its public shape, with the lines beside it so an
  ARBITRATED deletion removes lines instead of blanking them; the undecided branch emits base
  lines directly.
- Found by dogfooding a git-bridged repo: the bridge reprojects the working tree on every
  commit, so each cycle revived one line per deleted run. The drift accumulated (a run cleaned
  to zero grew back to ten over a day) and landed in files the commit had not touched — which
  is what made it look like a hook problem rather than a merge problem.
- **Migration: re-materialize, do not trust a stored hash across the boundary.** An op set of
  only replacements/insertions is byte-identical either way. One containing a pure deletion
  now reduces to a DIFFERENT (correct) `treeHash`, so a persisted `treeHash` or checkpoint
  written by an earlier version is not comparable for those op sets. The boundary is explicit:
  `materializerVersion` (stamped on every materialize result, surfaced by the hub `/`
  endpoint) reads `text3/0.3.0` before and `text3/0.3.1` after — branch on it rather than
  guessing. Nothing on disk is rewritten and stores open unchanged; only recomputation of a
  materialized tree is affected.

**Added — local `undo` ([docs/23](docs/23-local-undo.md), issue #91). New object type
`"undo"`, new optional `Blob.undoOid`. Additive: existing stores open unchanged.**

- `avcs undo [--last | <op-oid>…] [--purge]` / `repo.undo(...)`. Without `--purge` it only
  grows the view's `excludeOps` (reversible); with `--purge` it also evicts the blob bytes
  the named ops *uniquely* reference — same mechanism as `redact`, same preserved oid.
- **Refuses ops that have already been pushed**, naming `redact` as the answer for that
  case. `redact`'s admin gate is untouched: `undo` never operates on replicated history, so
  it needs no role. New per-replica aux file `.avcs/pushed-ops.json` (op oid → hub URLs),
  written by `pushToHub`; not gossiped.
- Recorded as a first-class `Undo` object (`repo.listUndos()`), alongside the NEW `view`
  object the exclusion authors — the act is append-only in both halves.
- In a git-bridge repo, `--purge` also names what it did NOT reach: git keeps its own copy of
  what it committed, and clearing that is the user's call (it differs once pushed), so the CLI
  points at the commit rather than acting. No git ⇒ no extra output.
- **Determinism unchanged.** Excluding ops is an already-supported reduce input, so
  `MATERIALIZER_VERSION` / `MERGE3_VERSION` are NOT bumped. Verified under
  `AVCS_VERIFY_INCREMENTAL=1`.
- **Migration: none.** A store written before this version has no `undo` objects and no
  ledger; both are created lazily on first use.

**Fixed (security) — byte eviction now also scrubs the derived copies of the bytes.**

- A 3-way merge result is a SYNTHETIC blob the reducer carries as bytes, so it is held by the
  warm reduce cache and — outliving the process — by the persisted compaction snapshot at
  `.avcs/snapshot/<view>.cbor`. `redact` evicted the stored blob and left those bytes intact,
  so a redacted secret whose projected content was a merge result stayed readable on disk.
  Present since Phase 12; found while building `undo --purge`, which had the same gap.
- Both eviction paths now drop the persisted snapshot and the in-memory reduce/incremental
  caches. Pure cache invalidation — rebuildable, costing one full reduce; `redact`'s admin
  gate is unchanged.

**Fixed (determinism) — the signature trust gate no longer keys on local state.
New optional `Policy` fields `requireSignedEvidence` / `requireSignedDecisions`.**

- Evidence and decisions were required to carry a valid signature the moment a
  keyring existed (`keyring.size > 0`). A keyring is per-machine and **never
  replicated**, so the same object graph reduced to different trees on different
  replicas: provisioning one local key flipped already-accepted operations to
  `rejected` and their files silently left the projection (`conflicts` stayed
  empty). Issue #66.
- The requirement now lives in the **policy** — a replicated governance object,
  so every replica agrees. Default (field absent/false) keeps the Phase-1
  `producedBy` heuristic, i.e. **provisioning a key changes nothing**. Opt in
  with `setPolicy({ ...policy, requireSignedEvidence: true })`.
- **Migration.** A repo that had a keyring and unsigned non-agent evidence was
  losing those operations; on this version they are accepted again, so its
  `treeHash` changes back (the point of the fix). To keep the stricter behavior,
  set `requireSignedEvidence: true` in the policy — and note that unsigned
  historical evidence stays untrusted under that setting.
- Reduction results now also carry `blockedReasons` (op oid → why it was
  rejected, from the policy engine) and `untrustedEvidence` (how much evidence
  and how many decisions the gate discarded), so a projection can no longer lose
  files without an explanation.

**Breaking (determinism) — region arbitration: policy, not order, decides who wins a
contended region. `MERGE3_VERSION` `text3/0.2.0` → `text3/0.3.0`, so
`MATERIALIZER_VERSION` becomes `avcs-text3/0.3.0`.**

Closes what [docs/15](docs/15-language-neutral-core.md) §10.4 records as **H1**, "the most
substantial gap": the language-neutral rewrite moved the unit of merge down to the hunk, and
the policy engine did not follow it down. Design: [docs/22](docs/22-region-arbitration.md).

- **What was wrong.** `applyOp` composed concurrent `edit_file`s with
  `merge3(opBase, [current, opNew], { onConflict: "first" })`, and `"first"` takes the
  lowest side index. Side indices come from canonical (`lamport, oid`) order, so the content
  of an overlapping region went to whichever op was applied first — **first-write-wins**,
  the mirror image of the last-write-wins that [docs/00](docs/00-overview.md) principle 6
  forbids ("정책이 정한 우선순위에서 이긴 변경이 맞다. recency는 최후의 tie-break일 뿐이다").
  The trust ladder, reliability learning, code-owner rules and evidence gates had no say
  over region content at all — only a `needs_human` flag — so a **verified change could
  lose a region to an unverified one**, and nothing recorded that it had happened.
- **What changed.** `merge3` gained an injected `arbitrate?: (region) => number | null`
  hook. It computes nothing about policy and is told nothing about why — it hands over
  variant indices and takes back an option index, staying as policy-blind as it is
  language-blind. The reducer supplies the arbiter from the scores `evaluateOp` already
  produced for the group decision:
  - an option several ops agree on is represented by its **highest**-scoring op (an average
    would let a low-trust actor dilute an option by co-signing it);
  - an op that failed an evidence gate, or that a rule reserves for a human, is **out of
    candidacy** — this is the substance of the change: an unverified behaviour change cannot
    take a region;
  - a **tie goes to a human, never to recency**. The arbiter returns `null`, the tree keeps
    the deterministic `onConflict` fallback content, and the region stays an open conflict.
    Region content is where meaning diverges; deciding it quietly is worse than raising it.
- **Decided regions leave the conflict set, and are recorded.** The authoritative N-way pass
  (`detectFileConflicts` → `arbitrateFileConflicts`) drops a region policy decided, so fewer
  conflicts reach a human and the ones left are the ones policy genuinely could not settle.
  Each decided region becomes an `AutoDecision` (`reason: "region-arbitration"`) carrying the
  winning and losing ops, the contested base line range and the per-option score breakdown —
  "why did my change lose this region" is now answerable. Its identity is
  key + region bounds + winner, so a re-reduce does not mint a second record.
  Binary/oversized atomic contests are deliberately NOT arbitrated: their option `sides`
  index distinct contents rather than variants, so side → op is not recoverable there.

**Migration.**

- **An op set with no overlapping region materializes byte-identically.** The arbiter is
  only reachable from inside a `ConflictRegion`, so a history whose concurrent hunks never
  overlapped — the overwhelming majority — is unaffected in content and in `treeHash`. This
  is pinned by a golden-hash regression (docs/22 R1) plus the full pre-existing suite passing
  unchanged. Only a file whose concurrent edits actually contended can reduce differently,
  and only when the policy can separate the contending options.
- **Persisted compaction snapshots invalidate.** Their header stamps the materializer version
  (and the active policy oid), so a cold load rejects the stale file and falls back to a full
  reduce — automatic and safe (Phase 13.3), costing one rebuild.
- **Stored checkpoints stay valid.** Each records the `materializerVersion` that produced its
  `treeHash`, so old checkpoints remain accurate records of what the tree was. The bump is
  what keeps that honest: a replica on `text3/0.2.0` now sees an explicit version mismatch
  instead of computing a divergent tree under a stamp claiming the same substrate.
- **`verify-git` can differ on a contended file.** Re-projecting a history whose concurrent
  edits overlapped may now produce the policy winner's content where it previously produced
  the first-applied op's. That is the intended fix, not drift.
- **The tree now depends on policy at region granularity.** Changing the policy can change
  the content of a contended region, exactly as it can already change which op is accepted
  ([docs/07](docs/07-roadmap.md) "known limitation 4"); the same mitigations apply (policy
  versioning, the audit record above, `require_human`).

**Breaking (determinism) — file identity: a rename and a concurrent edit now merge.
`MERGE3_VERSION` `text3/0.1.0` → `text3/0.2.0`, so `MATERIALIZER_VERSION` becomes
`avcs-text3/0.2.0`.**

Restores `docs/00` principle 2 ("파일 경로가 아니라 Entity ID가 정체성이다 → rename + edit가
자동 병합 가능"), which the language-neutral redesign dropped without recording it as a
tradeoff. Design: [docs/19](docs/19-entity-identity.md). Regression noted in
[docs/15](docs/15-language-neutral-core.md) §11.

- **What was wrong.** `applyOp` applied content ops at the path they name, so the outcome of
  a concurrent `rename_file(P→Q)` and `edit_file(P)` depended on their canonical
  (`lamport, oid`) order: edit-then-rename produced the right tree, while rename-then-edit
  found no `tree.get(P)`, fell back to `current = opBase`, and **resurrected P** — the
  content ended up at two paths with the edit sitting on the dead one. Determinism held;
  correctness was left to an accident of ordering.
- **What changed.** The reducer builds a path-alias map from the rename closure and routes
  content ops to the file's final path, so rename and edit commute (identical `treeHash`
  under either ordering). An op that causally *descends* from a rename is not aliased, so a
  new file created at the vacated path stays a new file. Concurrent renames to different
  destinations, two renames racing for one destination, and concurrent base-less `put_file`
  remain conflicts. `merge3` itself is untouched and still sees nothing but lines.
- **Capture now emits `rename_file`.** `commitWorkingTree` previously computed changes by
  path-set difference, so a move looked like `delete_file` + `put_file` and no rename op was
  ever authored on the git-bridge path. It now pairs removals with additions: exact blob
  match → a bare rename; ≥50% line similarity (reusing this module's LCS, no new algorithm)
  → rename + `edit_file` based on the pre-move content; many-to-many ambiguity or binary
  content without an exact match → left as delete + put.

**Migration.**

- **A rename-free op set materializes byte-identically.** Only op sets containing
  `rename_file` can reduce differently, and before this release the git bridge never authored
  one (nor does `importGitHistory`, which maps changed paths to `put_file`/`delete_file`), so
  a store built through either is unaffected in content. Verified by case C21 plus the full
  pre-existing suite passing unchanged.
- **Persisted compaction snapshots invalidate.** Their header stamps the materializer version,
  so a cold load rejects the stale file and falls back to a full reduce — automatic and safe
  (Phase 13.3), costing one rebuild.
- **Stored checkpoints stay valid.** Each records the `materializerVersion` that produced its
  `treeHash`, so old checkpoints remain accurate records. That field is also the point of the
  bump: a replica on `text3/0.1.0` that receives rename-bearing ops from a `0.2.0` store now
  sees an explicit version mismatch instead of computing a divergent tree under a stamp
  claiming the same substrate.
- If you authored `rename_file` ops directly through the API, re-materializing changes those
  trees. The previous result was the duplicated-path bug described above.


**Changed — an updated install no longer kills a running MCP server; it says so instead.**

- A long-lived stdio server holds the code it was spawned with, so `npm i -g` never reaches
  it. The server used to detect that and `exit(0)`, on the assumption that the client would
  respawn it. Claude Code — the common client — does not: it marks the server disconnected
  and waits for a manual `/mcp`. Exiting there strips every AVCS tool out of a live session
  with no visible cause, which is worse than serving code one version behind that still works.
  - The default is now to emit a `notifications/message` (level `warning`) naming both
    versions and the fix, **once**, and keep serving.
  - The same notice is appended to subsequent errors. A stale server fails in ways that point
    at the wrong culprit — it cannot read a newer on-disk layout and reports "not an AVCS
    repo" about a directory the upgraded CLI reads fine — so the error now names its own cause.
  - Clients that *do* respawn keep the old behaviour with `AVCS_MCP_RELOAD=exit`.
    `AVCS_MCP_RELOAD_CHECK_MS=0` still disables the check entirely.

**Fixed — the server never actually sent any log notification.**

- `notifications/message` is gated by the SDK on a declared `logging` capability
  (`assertNotificationCapability`), which the server did not declare. Every such send was
  wrapped in `.catch(() => {})`, so the failures were invisible: watch events
  (`head-advanced`, `foreign-op-hot-key`, `conflict-opened`) were emitted into nothing and no
  client ever received one. Declaring `logging` makes them arrive.


**Fixed — a lock name containing a path separator spun forever instead of acquiring.**

- `withLock` built its lock directory as `join(locksDir, name + ".lock")` with the name raw.
  Names are built by interpolation — `snapshot:${viewName}`, `finalize:${view}` — and a view
  named after a git branch carries a slash, so the path became nested and its parent did not
  exist. `mkdir` failed `ENOENT`, which the acquire loop read as "the locks dir isn't there
  yet", recreated it, and retried — forever, at full CPU, never consulting `maxWaitMs`.
  - **Symptom:** `git commit` in a working tree on a `feature/x` branch hangs indefinitely
    once the store is `AUTO_COMPACT_DELTA` ops past its persisted base, because the git hook's
    materialize reaches snapshot auto-compaction. `land`/`integration.submit` on such a view
    hang the same way through `finalize:${view}`.
  - Lock names are now percent-encoded (`%` first, so the mapping stays injective and "a/b"
    cannot collide with the literal "a%2Fb"), the same discipline `ObjectStore` already
    applies to ref names.
  - The `ENOENT` retry now honours the deadline, so no future path can spin unbounded.
  - **Compatibility:** lock files are ephemeral, so nothing needs migrating. A lock held under
    an old raw name cannot exist — that path never acquired.


**Added — linked git working trees share one store via a `.avcs` pointer file.**

- `.avcs` may now be a *file* holding a single `avcsdir: <path>` line instead of a directory,
  naming the store to use. This mirrors git's own trick: in a linked working tree `.git` is a
  file saying `gitdir: <path>`. Resolution lives in `ObjectStore.resolveStoreDir()`, which the
  `ObjectStore` constructor and `isRepo` both route through — the single place that computes a
  store path — so the CLI, the MCP server, and any future entry point are fixed together.
  - **No determinism impact.** The op format, `MERGE3_VERSION`, and `MATERIALIZER_VERSION` are
    untouched; this changes only *where a store is found*, never how one reduces. A plain repo
    resolves exactly as before.
  - `findRepoRoot` still returns the **working tree**, not the store's owner, so `materialize`
    and `checkout` keep writing to the tree the caller is in, and work-tree capture keeps
    reading from it. Only the store is shared.
  - New `avcs worktree attach [--to <dir>] | detach | status`. Attach writes the pointer and
    adds `/.avcs` to the repo's shared `info/exclude` (`.avcs/.gitignore` cannot cover a
    pointer, since that file lives *inside* the store). It refuses to shadow an existing store,
    and `detach` refuses to delete one.
  - `install-hooks` gains **`post-checkout`**, so `git worktree add` attaches the new tree by
    itself. Fails open — a checkout is never blocked.
  - `avcs init` now **stops** inside a linked working tree whose main checkout already has a
    store, and names `avcs worktree attach`. `--force` still allows a deliberate split.
  - **Why:** in sidecar mode `.avcs/` is untracked by design, so git cannot deliver the store
    to a new working tree, and AVCS's upward root-finding never reaches it because a linked
    tree is usually not under the main checkout. Only `git-sync`/`git-hook` had a workaround.
    Everything else — including the whole MCP surface — reported "not an AVCS repo", and the
    obvious next move (`avcs init`) silently forked the history into a second store.
  - **Limitation:** committed mode + linked working trees is still unsupported — there git
    carries `.avcs` into every tree, so the store forks per tree. `attach` refuses that
    combination rather than fighting it.

**Fixed — repo-local state is read through the store root.**

- Seven call sites built paths as `join(this.dir, ".avcs", …)` rather than using `store.root`.
  For a plain repo the two agree, so the split was invisible; through a pointer they diverge.
  Notably `writeGitPending` already used `store.root` while `readGitPending` did not, so the
  writer and the reader of the git-hook provenance handoff disagreed about its location.


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
