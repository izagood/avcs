# AVCS — Agentic Version Control System

*An AI-native version control system for humans and AI agents working concurrently.*

[![CI](https://github.com/izagood/avcs/actions/workflows/ci.yml/badge.svg)](https://github.com/izagood/avcs/actions/workflows/ci.yml)
![status](https://img.shields.io/badge/status-experimental-orange)
![node](https://img.shields.io/badge/node-%E2%89%A522.6-brightgreen)
![runtime deps](https://img.shields.io/badge/runtime%20deps-0-blue)
![license](https://img.shields.io/badge/license-Apache--2.0-green)

> Git records **when** the code changed.
> AVCS records **who changed it, with what intent, on what evidence, and through which conflict decisions** the code reached its current state.

AVCS is a new, deliberately Git-incompatible version control system built for a world where humans and **many AI agents edit the same codebase concurrently**. It drops the commit / branch / merge / conflict-marker model and instead stores **intent**, **session**, **operation**, **evidence**, and **decision** as first-class objects. The code tree is not the source of truth — it is a **projection** computed by deterministically *reducing* the operation graph:

```
state = reduce(base, operationDAG, decisions, policy, materializer)
```

The same objects + the same policy + the same materializer produce the same tree on any replica. Merging is not text selection; it is a pure, deterministic reduction.

> **Status:** research prototype. The implementation is real and test-covered, but every phase is built to a *working-MVP depth* (file/symbol-level merge, ed25519 signing, heuristic contract analysis). Production-grade tree-sitter integration, multi-signature trust, and hardened distributed sync are tracked on the [roadmap](docs/07-roadmap.md).

## Core principles

| # | Principle | Contrast with Git |
|---|-----------|-------------------|
| 1 | **Operations are history**, not commits | A commit is merely a checkpoint over many operations |
| 2 | **Identity is the entity ID**, not the file path | Rename + edit can auto-merge |
| 3 | **Merge is a deterministic reduction**, not text selection | No conflict markers |
| 4 | **A conflict is a first-class `decision` object**, not a broken file | The rationale stays in history |
| 5 | **AI output is a proposed operation with attached evidence**, not trusted code | A behavior change with no test cannot be `accepted` |
| 6 | **Code never defaults to last-write-wins** | Precedence is decided by policy |

## How it works

Every meaningful thing is a content-addressed, append-only object. Code is a *projection* over the operation DAG, never stored as commits.

| Object | Role |
|--------|------|
| `intent` | Why a change is being made (goal + constraints + allowed scope) |
| `session` | An agent/human work episode against an intent |
| `operation` | A single semantic change unit — the real history |
| `evidence` | Machine-checkable proof (test / typecheck / lint / scan) attached to operations |
| `decision` | A recorded resolution of a conflict or design choice |
| `checkpoint` | A verified (ops + policy + materializer) state vector — replaces a commit |
| `view` | A declarative query over the operation graph — replaces a branch |
| `release` | A signed, provenance-bearing checkpoint — replaces a tag |
| `policy` | The deterministic merge rules the reducer is parameterized by |

…plus `blob` for raw content and the governance objects (`lease`, `membership`, `protection`, `promotion`, `redaction`, `override`, `approval`, `line`) used by the multi-machine and security phases.

## Conflict resolution levels

AVCS never falls back to last-write-wins for code. Contending operations are graded and resolved with a recorded rationale:

- **L0 / L1** — different entities, or the same file but different **symbols** → **auto-merge**
- **L2** — concurrent edits to the same slot → **policy auto-decision** (human-preferred, trust-weighted); the auto-decision is itself recorded in `autoDecisions`
- **L3** — a behavior change with no *trusted* evidence → **blocked**; an undeclared contract change with live callers → **semantic conflict, auto-escalated**
- **L4** — a public-API break → **requires a human decision**, routed to the scope's owners

Evidence trust matters: an operation's own author cannot vouch for it. Evidence-gating and the passing-test bonus only count evidence produced by a *non-authoring, trusted* actor (CI bot / human).

## What works today

The reducer and policy engine are the foundation; the higher phases build distributed collaboration, security, and observability on top.

**Foundation (Phases 1–6)**

- **Storage core** — append-only, content-addressed object store (`.avcs/objects`)
- **Deterministic reducer + policy engine** — the L0–L4 conflict grading above, with a priority ladder, bounded reliability nudges, and auditable auto-decisions
- **Symbol-level merge** (Phase 2) — a pluggable `EntityIndexer` (MVP: a TS/JS brace scanner; Tree-sitter backend can drop in) so two edits to different functions in one file auto-merge
- **Cryptographic trust** (Phase 3) — ed25519-signed evidence/decision; forged signatures fail the trust gate. Real validation runner, `WorkLease`, `RepairContext`
- **Semantic conflict detection + decision memory** (Phase 4) — signature-drift detection, recallable decisions and learned policies
- **Policy depth** (Phase 5) — code-owner routing and bounded reliability learning
- **Release & provenance** (Phase 6) — verified checkpoints + CycloneDX SBOM + signed artifacts

**Collaboration, scale & security (Phases 7–12)**

- **Phase 7 — multi-machine:** membership/roles (signed key federation), `pull` (object gossip; two replicas converge to the same `treeHash`), protection + `finalize` CAS (non-fast-forward rejected, so a stale push can't overwrite fresh history)
- **Phase 8 — lineage:** long-lived divergent lines (e.g. v1.x ∥ v2.x, same symbol, different content, zero conflict), `portOp` (backport = cherry-pick)
- **Phase 9 — scale:** entity index, `materializeAt` (time travel), chunked large-blob storage with dedup
- **Phase 10 — observability:** `blame` (who/why), `logP`, deterministic `bisect`, `diff`
- **Phase 11 — external contributions:** quarantine tier + `promote` + untrusted-CI gate
- **Phase 12 — security:** `redact` (byte-eviction of leaked secrets, oid preserved), break-glass `override`, forward-only rollback

Branches become **views**, commits become **checkpoints**, tags become **releases**. Agents drive AVCS through a first-class **MCP server** (21 tools); humans use the **CLI**. The behavior is pinned by a 148-test contract suite (`test/*.test.ts`, all green) and `tsc` is clean.

## Install

Requires **Node ≥ 22.6** — AVCS runs TypeScript directly via type stripping, so there is **no build step and zero runtime dependencies**.

```bash
curl -fsSL https://raw.githubusercontent.com/izagood/avcs/main/install.sh | bash
```

That one-liner clones the repo to `~/.local/share/avcs` (override with `--dir`/`AVCS_HOME`) and installs an `avcs` launcher to `~/.local/bin`. Re-running it updates the checkout in place. Already have a clone? Run the installer from inside it instead:

```bash
git clone https://github.com/izagood/avcs.git && cd avcs
./install.sh
```

Either way, `install.sh` writes a small `avcs` launcher to `~/.local/bin` (override with `--bin-dir <dir>` or `AVCS_BIN_DIR`) that points back at the checkout, so updating is just `git pull` — no reinstall needed. If `~/.local/bin` isn't on your `PATH` yet, the installer prints the line to add.

```bash
avcs version      # confirm it's on your PATH
avcs help         # list every command

avcs init .       # create a repo in the current directory
avcs status       # operation / conflict summary
avcs conflicts    # decisions a human still owes
avcs log          # operation history
```

Other install options:

```bash
./install.sh --bin-dir /usr/local/bin   # system-wide (may need sudo)
./install.sh --name avcs-dev            # install under a different command name
./install.sh --dir ~/src/avcs --ref v1  # one-liner mode: clone dir + ref to install
./uninstall.sh                          # remove the launcher (data is left intact)
```

Prefer npm? `npm link` exposes the same `avcs` binary from `package.json`'s `bin` field. If `node` isn't on your `PATH` at runtime, point the launcher at one with `AVCS_NODE=/path/to/node`.

## Use as a library (`@izagood/avcs`)

A hosting server (e.g. avcshub) can depend on the AVCS core as a versioned package. Development and tests run the raw `.ts` via type stripping, but `npm publish` ships a `tsc`-compiled `dist/` (JS + type declarations via `tsconfig.build.json`), so consumers import it with no build tooling of their own.

```bash
npm install @izagood/avcs
```

```ts
import { startHub, type HubHandle } from "@izagood/avcs/hub";   // the hub server
import { ObjectStore, CorruptObjectError } from "@izagood/avcs/store";
import { verifyMessage, generateKeypair } from "@izagood/avcs/identity";
import { Repo } from "@izagood/avcs";                            // root: primary public API

const hub = await startHub({ repoDir: "./data", port: 8080, gated: true });
```

Entry points: `.` (root barrel) · `./hub` · `./hub/client` · `./store` · `./identity` · `./types`.

Releasing: bump `package.json`'s `version` in a PR and merge it to `main` — `.github/workflows/release.yml` detects the new version, runs `npm publish` (with provenance), tags the commit `vX.Y.Z`, and cuts a GitHub Release. The publish steps are guarded by a registry check, so package.json edits that don't change the version are no-ops. Every PR also runs a release dry run (`npm run build` + `npm pack --dry-run`) in CI to catch packaging regressions before merge. Requires an `NPM_TOKEN` repository secret with publish rights to the `@izagood` scope.

## Quick start

If you'd rather not install, every command runs straight from the checkout with `node`:

```bash
# Walk all four merge scenarios end to end
node --experimental-strip-types src/demo.ts

# Run the behavior-contract test suite
node --experimental-strip-types --test test/*.test.ts      # or: npm test

# Human-facing CLI (or just `avcs <command>` once installed)
node --experimental-strip-types src/cli.ts init .
node --experimental-strip-types src/cli.ts status
node --experimental-strip-types src/cli.ts conflicts
node --experimental-strip-types src/cli.ts log

# Agent-facing MCP server (requires the optional dependency)
npm install
AVCS_REPO=$(pwd) node --experimental-strip-types src/mcp/server.ts
```

> Type checking (`tsc --noEmit`) needs `npm install`; the runtime itself has no dependencies.

## Code map

| Path | Role |
|------|------|
| `src/objects/types.ts` | Object model definitions (single source of truth) |
| `src/store/objectStore.ts` | Append-only, content-addressed store |
| `src/core/canonical.ts` | Canonical serialization + content addressing (oid) |
| `src/core/identity.ts` | ed25519 sign/verify + Keyring (Phase 3) |
| `src/reducer/reducer.ts` | Operation graph → code tree reduction + conflict grading |
| `src/reducer/policy.ts` | Policy engine (priority ladder, reliability nudge) |
| `src/reducer/incremental.ts` | Incremental re-reduce (reuse clean groups) |
| `src/semantic/symbols.ts` | Symbol parser (`EntityIndexer`) — symbol-level merge (Phase 2) |
| `src/semantic/contract.ts` | Signature analysis + semantic conflict detection (Phase 4) |
| `src/policy/owners.ts`, `reliability.ts` | Code-owner routing · reliability learning (Phase 5) |
| `src/validation/runner.ts`, `repair.ts` | Validation runner · RepairContext (Phase 3) |
| `src/concurrency/lease.ts` | WorkLease (Phase 3) |
| `src/release/sbom.ts` | SBOM generation (Phase 6) |
| `src/hub/hubServer.ts`, `hubClient.ts` | Multi-machine sync hub (Phase 7) |
| `src/api/repo.ts` | High-level facade (shared by CLI, demo, MCP) |
| `src/mcp/server.ts` | Agent-facing MCP interface (21 tools) |
| `src/cli.ts` | Human-facing inspection/release CLI |
| `src/demo.ts` | End-to-end scenario |

## Design docs

- [00 — Overview & principles](docs/00-overview.md)
- [01 — Architecture](docs/01-architecture.md)
- [02 — Object model](docs/02-object-model.md)
- [03 — Reducer & conflict levels](docs/03-reducer.md)
- [04 — Policy engine](docs/04-policy.md)
- [05 — Views · Checkpoints · Releases](docs/05-views-checkpoints.md)
- [06 — MCP / Skill interface](docs/06-mcp-interface.md)
- [07 — Roadmap](docs/07-roadmap.md)
- [08 — Governance & consensus (avcshub)](docs/08-governance.md)
- [09 — Git/GitHub use-case coverage & design evolution](docs/09-usecase-coverage.md)
- [10 — Production design plan](docs/10-production-plan.md)
- [11 — Incremental reduce](docs/11-incremental-reduce.md)
- [12 — Local production](docs/12-local-production.md)
- [13 — Hub production](docs/13-hub-production.md)
- [14 — Git bridge (real-world compatibility)](docs/14-git-bridge.md)

## Contributing

This is an early-stage research prototype and the design is still moving. Issues and discussion are welcome — if you're proposing a change, the design docs above are the best starting point for the rationale behind the current model. Please run `npm test` and `npm run typecheck` before opening a pull request.

Every push and pull request to `main` runs CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): `npm ci` → `npm run typecheck` → `npm test` on Node 22.x and 24.x. PRs are merged only when CI is green.

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright © 2026 jaebin lee. See [NOTICE](NOTICE) for attribution.
