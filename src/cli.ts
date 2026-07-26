#!/usr/bin/env -S node --experimental-strip-types
// AVCS CLI — inspection & materialization.
//
// In an agent-native VCS the primary interface is the MCP server (src/mcp/server.ts);
// agents author intents/sessions/operations through it. This CLI is the human's
// read-and-decide surface: see what the agents did, why, and what still needs a call.
//
//   avcs init [dir]
//   avcs status [view]
//   avcs conflicts [view]
//   avcs log
//   avcs materialize [view] [--out <dir>]
//   avcs checkpoint <view> [-m <summary>]
//   avcs show <oid>
//   avcs mcp [install]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";

import { Repo, type GitMode } from "./api/repo.ts";
import { ObjectStore } from "./store/objectStore.ts";
import type { Operation, Actor } from "./objects/types.ts";
import { withDeadline, hookTimeoutMs } from "./concurrency/deadline.ts";

const args = process.argv.slice(2);
let cmd = args[0];
const cwd = process.cwd();

// Normalize the version/help flags so `avcs --version` / `avcs -h` work like
// every other CLI, instead of falling through to the usage exit-1 path.
if (cmd === "--version" || cmd === "-v") cmd = "version";
if (cmd === "--help" || cmd === "-h") cmd = "help";

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// ── git-bridge worktree resolution ──────────────────────────────────────────
// AVCS keeps a SINGLE store and is git-agnostic at its core. These helpers live
// in the CLI (the bridge layer, which already shells out to git) so the core
// never depends on git. They let `git-sync`/`git-hook` work correctly when run
// from a *linked git worktree*: the working tree is the worktree dir, but the
// store lives in the main checkout — which we locate via git's own resolution.
function gitCmd(dir: string, a: string[]): string | null {
  try {
    return execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

/** Locate the single AVCS store for a (possibly git-worktree) working dir: it's at `dir`
 *  or any ancestor if `.avcs` is present (AVCS's own upward root-finding — works with no
 *  git, like `git` ascending to `.git`); otherwise it lives in the main git checkout
 *  (resolved via `git rev-parse --git-common-dir`, whose parent is the main work tree).
 *  Falls back to `dir` so `Repo.open` surfaces its normal "not an AVCS repo" error when
 *  truly absent. */
function storeDirFor(dir: string): string {
  const root = ObjectStore.findRepoRoot(dir); // here, or any ancestor (non-git-dependent)
  if (root) return root;
  const common = gitCmd(dir, ["rev-parse", "--git-common-dir"]);
  if (common) {
    const main = dirname(isAbsolute(common) ? common : join(dir, common)); // <main>/.git → <main>
    if (ObjectStore.isRepo(main)) return main;
  }
  return dir;
}

/** The AVCS line a working dir maps to: an explicit `--line` wins; otherwise the current
 *  git branch (so each worktree/branch commits to its own line), with main/master → the
 *  default `main` line. Detached HEAD or non-git → the default line. */
function lineFor(dir: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const branch = gitCmd(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD" || branch === "main" || branch === "master") return undefined;
  return branch;
}

/** An ignore predicate backed by `git check-ignore`, so `git-sync` respects `.gitignore`
 *  (and global excludes) without the core ever depending on git (issue #10). git absent or
 *  not-a-repo ⇒ a no-op, leaving the core's own `.avcsignore` as the only filter. The core
 *  prunes ignored directories, so this is invoked per surviving entry, not per ignored file. */
function gitIgnorePredicate(dir: string): (rel: string) => boolean {
  if (gitCmd(dir, ["rev-parse", "--is-inside-work-tree"]) !== "true") return () => false;
  // `git check-ignore -q <path>`: exit 0 (ignored) ⇒ gitCmd returns ""; exit 1 (not ignored)
  // or any error ⇒ gitCmd returns null. So "ignored" is exactly a non-null result.
  return (rel: string): boolean => gitCmd(dir, ["check-ignore", "-q", rel]) !== null;
}

/** Ensure the line/view exists before sync targets it (auto-forked from main on the first
 *  commit on a branch). No-op for the default `main` line/view, which always exists. */
async function ensureLine(repo: Repo, line?: string): Promise<void> {
  if (!line) return;
  if (!(await repo.store.getRef(`view:${line}`))) await repo.createLine(line);
}

function pkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// The exact command that re-invokes this CLI (node + strip-types + this script path), so
// installed hooks call the same AVCS the user is running now — no global install assumed.
function avcsInvocation(): string {
  return `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(process.argv[1])}`;
}

const HOOK_PHASES = ["pre-commit", "prepare-commit-msg", "post-commit", "post-merge"] as const;
const HOOK_MARKER = "# avcs-git-bridge-hook";

function hookScript(phase: string, avcsCmd: string): string {
  return `#!/bin/sh
${HOOK_MARKER} ${phase}
# Managed by \`avcs install-hooks\` (docs/14). Delete this file to disable.
exec ${avcsCmd} git-hook ${phase} "$@"
`;
}

/** Install the git-bridge hook scripts into `hooksDir`, preserving any non-AVCS hooks. */
async function installHooks(hooksDir: string, avcsCmd: string, force: boolean): Promise<{ installed: string[]; skipped: string[] }> {
  const { writeFile, mkdir, readFile, chmod } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  await mkdir(hooksDir, { recursive: true });
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const phase of HOOK_PHASES) {
    const p = join(hooksDir, phase);
    if (existsSync(p)) {
      const existing = await readFile(p, "utf8");
      if (!existing.includes(HOOK_MARKER) && !force) { skipped.push(phase); continue; } // a foreign hook — don't clobber
    }
    await writeFile(p, hookScript(phase, avcsCmd), "utf8");
    await chmod(p, 0o755);
    installed.push(phase);
  }
  return { installed, skipped };
}

async function main(): Promise<void> {
  switch (cmd) {
    case "version": {
      console.log(`avcs ${pkgVersion()}`);
      break;
    }
    case "init": {
      const dir = args[1] && !args[1].startsWith("--") ? args[1] : cwd;
      const repo = await Repo.init(dir);
      const want = flag("--mode");
      const mode: GitMode = want === "committed" ? "committed" : "sidecar";
      await repo.setGitMode(mode);
      console.log(`initialized AVCS repo at ${dir}/.avcs  [git mode: ${mode}]`);
      if (mode === "sidecar") console.log(`  .avcs/ is git-ignored — git tracks only the projection (run \`avcs git-mode committed\` to share history via git)`);
      // If this is a git repo, offer to install the bridge hooks so `git commit` just works.
      if (!args.includes("--no-hooks")) {
        const { execFileSync } = await import("node:child_process");
        try {
          const gp = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: dir }).toString().trim();
          const { isAbsolute, join } = await import("node:path");
          const hooksDir = isAbsolute(gp) ? gp : join(dir, gp);
          const cmd = `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(process.argv[1])}`;
          const { installed } = await installHooks(hooksDir, cmd, false);
          if (installed.length) console.log(`  installed git hooks (${installed.join(", ")}) — \`git commit\` now auto-syncs AVCS (--no-hooks to skip)`);
        } catch { /* not a git repo — fine; user can `git init` then `avcs install-hooks` */ }
      }
      break;
    }
    case "status": {
      const repo = await Repo.open(cwd);
      const view = args[1] ?? "main";
      const res = await repo.materialize(view);
      const counts: Record<string, number> = {};
      for (const s of res.statuses.values()) counts[s] = (counts[s] ?? 0) + 1;
      console.log(`view: ${view}`);
      console.log(`operations: ${JSON.stringify(counts)}`);
      console.log(`files: ${res.tree.size}   conflicts: ${res.conflicts.length}   auto-merged: ${res.autoDecisions.length}`);
      console.log(`treeHash: ${res.treeHash}`);
      for (const a of res.autoDecisions)
        console.log(`  ✓ auto @ ${a.key}: chose ${a.chosenOp.slice(0, 16)} (policy ${a.policyVersion})`);
      if (res.conflicts.length) console.log(`\nrun \`avcs conflicts ${view}\` to review`);
      // Phase 15.3: early conflict warning — other actors' live concurrent work (and
      // lease holders) on the keys this replica's actor has authored on. Needs a local
      // identity for perspective; without one the section is simply omitted.
      const me = await repo.localActorId(flag("--as"));
      if (me) {
        const warnings = await repo.contention({ actorId: me });
        if (warnings.length) {
          console.log(`\ncontention (${warnings.length} key(s), from ${me}'s perspective):`);
          for (const w of warnings) {
            console.log(`  ⚠ ${w.key}`);
            for (const t of w.theirs) console.log(`     ~ ${t.op.slice(0, 16)}… ${t.actor} :: ${t.purpose}`);
            for (const l of w.leaseHolders) console.log(`     ⛔ lease held by ${l.actor} on ${l.scope} until ${l.expiresAt}`);
          }
        }
      }
      break;
    }
    case "key": {
      // Signing keys, reachable without writing a script (issue #51). `ls` prints actor
      // ids only — a listing that emitted key material would be the disclosure it exists
      // to help avoid.
      const repo = await Repo.open(cwd);
      const sub = args[1];
      if (sub === "provision") {
        const id = args[2];
        if (!id) throw new Error("usage: avcs key provision <actor-id> [--kind human|ai_agent|ci_bot]");
        const kind = (flag("--kind") ?? (id.startsWith("human:") ? "human" : id.startsWith("ci:") ? "ci_bot" : "ai_agent")) as Actor["kind"];
        const r = await repo.ensureOwnerKey({ kind, id });
        console.log(r.created ? `provisioned signing key for ${id}` : `${id} already has a local signing key (unchanged)`);
        break;
      }
      if (sub === "ls" || sub === undefined) {
        const [local, trusted] = await Promise.all([repo.listLocalKeys(), repo.listTrustedKeys()]);
        console.log(`signable on this machine (${local.length}):`);
        for (const a of local) console.log(`  ${a}`);
        console.log(`trusted by this repo (${trusted.length}):`);
        for (const a of trusted) console.log(`  ${a}`);
        break;
      }
      throw new Error(`unknown key subcommand: ${sub} — use \`avcs key provision <actor-id>\` or \`avcs key ls\``);
    }
    case "conflicts": {
      const repo = await Repo.open(cwd);
      const view = args[1] ?? "main";
      const res = await repo.materialize(view);
      if (!res.conflicts.length) {
        console.log("no open conflicts — nothing needs a human.");
        break;
      }
      for (const c of res.conflicts) {
        console.log(`\n● ${c.id}  [${c.kind}]  @ ${c.key}`);
        console.log(`  ${c.reason}`);
        for (const o of c.options) {
          const tags = [o.blocked && "blocked", o.requiresHuman && "needs-human"]
            .filter(Boolean)
            .join(",");
          console.log(`   - ${o.opOid}`);
          console.log(`     ${o.actor} :: ${o.purpose}  (score ${o.score}${tags ? ", " + tags : ""})`);
        }
        if (c.recommendedOp) console.log(`  → recommended: ${c.recommendedOp}`);
        console.log(`  decide via MCP avcs.decision.record or the API`);
      }
      break;
    }
    case "metrics": {
      const repo = await Repo.open(cwd);
      await repo.materialize(args[1] ?? "main"); // do some work so there's something to show
      console.log(JSON.stringify(repo.metrics.snapshot(), null, 2));
      break;
    }
    case "blame": {
      const repo = await Repo.open(cwd);
      const key = args[1];
      if (!key) throw new Error("usage: avcs blame <file:path | symbol:path#name>");
      const b = await repo.blame(key, flag("--line") ?? "main");
      if (!b) console.log("no owner (entity not present)");
      else console.log(`${b.actor.id}  ${b.op.slice(0, 16)}\n  why: ${b.purpose}${b.intentTitle ? `  [intent: ${b.intentTitle}]` : ""}\n  at:  ${b.at}`);
      break;
    }
    case "diff": {
      const repo = await Repo.open(cwd);
      const a = args[1] ?? "main";
      const b = args[2] ?? "main";
      const d = await repo.diff(a, b);
      for (const p of d.added) console.log(`+ ${p}`);
      for (const p of d.removed) console.log(`- ${p}`);
      for (const p of d.modified) console.log(`~ ${p}`);
      if (!d.added.length && !d.removed.length && !d.modified.length) console.log("(no differences)");
      break;
    }
    case "pull": {
      const repo = await Repo.open(cwd);
      const from = args[1];
      if (!from) throw new Error("usage: avcs pull <hub-url | other-repo-dir>");
      if (/^https?:\/\//.test(from)) {
        const r = await repo.pullHub(from);
        console.log(`pulled ${r.pulled} object(s) from hub ${from}`);
      } else {
        const r = await repo.pull(from);
        console.log(`pulled ${r.copied} object(s)${r.rejected ? `, rejected ${r.rejected}` : ""}`);
      }
      break;
    }
    case "push": {
      const repo = await Repo.open(cwd);
      const url = args[1];
      if (!url || !/^https?:\/\//.test(url)) throw new Error("usage: avcs push <hub-url> [--as <actorId>]");
      // --as picks which local identity key signs the request (SSH `-i`); omitted, avcs
      // auto-discovers it (AVCS_ACTOR → config.actorId → the sole private key), and an
      // unsigned push still works against a hub that doesn't require transport auth.
      const asIdx = args.indexOf("--as");
      const as = asIdx >= 0 ? args[asIdx + 1] : undefined;
      const r = await repo.pushHub(url, { as });
      console.log(`pushed ${r.pushed} object(s) to ${url}${r.rejected ? `, rejected ${r.rejected} (gated)` : ""}`);
      break;
    }
    case "clone": {
      const url = args[1];
      const dir = args[2] ?? cwd;
      if (!url || !/^https?:\/\//.test(url)) throw new Error("usage: avcs clone <hub-url> [dir] [--key <repo-dir|key-file>] [--as <actor-id>]");
      const repo = await Repo.init(dir);
      // A hub that gates reads refuses an unsigned GET /have, and a just-created repo holds
      // no key to sign it with (issue #58). `--key` brings one in from an existing repo dir
      // or a key file; it is adopted into the new repo first, so later syncs work too.
      const keySrc = flag("--key") ?? process.env.AVCS_KEY;
      const as = flag("--as");
      let signer: string | undefined = as;
      if (keySrc) signer = await repo.importLocalKey(keySrc, as);
      const r = await repo.pullHub(url, signer ? { as: signer } : undefined);
      // Phase 13.1: remember where we came from — `avcs sync` now works with no URL.
      await repo.addRemote("origin", url);
      console.log(
        `cloned ${r.pulled} object(s) from ${url} into ${dir}  [remote origin recorded]` +
          (signer ? `  [signing as ${signer}]` : ""),
      );
      break;
    }
    case "remote": {
      const repo = await Repo.open(cwd);
      const sub = args[1];
      if (sub === "add") {
        const name = args[2];
        const url = args[3];
        if (!name || !url) throw new Error("usage: avcs remote add <name> <url> [--auto-sync] [--freshness-ms N]");
        const freshness = flag("--freshness-ms");
        await repo.addRemote(name, url, {
          autoSync: args.includes("--auto-sync"),
          freshnessMs: freshness !== undefined ? Number(freshness) : undefined,
        });
        console.log(`remote ${name} → ${url}`);
      } else if (sub === "rm") {
        const name = args[2];
        if (!name) throw new Error("usage: avcs remote rm <name>");
        console.log((await repo.removeRemote(name)) ? `removed remote ${name}` : `no such remote: ${name}`);
      } else if (sub === "ls" || sub === undefined) {
        const remotes = await repo.listRemotes();
        const names = Object.keys(remotes).sort();
        if (!names.length) console.log("(no remotes — add one with `avcs remote add origin <url>`)");
        for (const n of names) {
          const r = remotes[n]!;
          console.log(`${n}\t${r.url}${r.autoSync ? "  [auto-sync]" : ""}${r.freshnessMs !== undefined ? `  [freshness ${r.freshnessMs}ms]` : ""}`);
        }
      } else {
        throw new Error("usage: avcs remote <add|rm|ls> ...");
      }
      break;
    }
    case "sync": {
      const repo = await Repo.open(cwd);
      const remote = args[1] && !args[1].startsWith("--") ? args[1] : "origin";
      const asIdx = args.indexOf("--as");
      const as = asIdx >= 0 ? args[asIdx + 1] : undefined;
      // Phase 15.2: `--watch` turns sync into the live-convergence daemon — long-poll
      // GET /events, incremental pull on wake, contention early warning on arrivals.
      if (args.includes("--watch")) {
        const { runSyncWatch } = await import("./hub/syncWatch.ts");
        const { consoleLogger } = await import("./observe/logger.ts");
        repo.logger = consoleLogger("info");
        const ac = new AbortController();
        const stop = () => ac.abort();
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        console.log(`watching ${remote} — live convergence via long-poll (Ctrl-C to stop)`);
        await runSyncWatch(repo, {
          remote,
          as,
          signal: ac.signal,
          onEvent: (ev) => {
            if (ev.type === "contention")
              console.log(`⚠ contention @ ${ev.key}: ${ev.incomingActor}'s op ${ev.incomingOp.slice(0, 16)}… arrived on a key with local work by ${[...new Set(ev.localOps.map((o) => o.actor))].join(", ")}`);
            else if (ev.type === "head") console.log(`↑ head:${ev.view} → ${ev.checkpoint.slice(0, 24)}…`);
          },
        });
        break;
      }
      const r = await repo.sync(remote, { as });
      console.log(`synced with ${remote}: pulled ${r.pulled}, pushed ${r.pushed}${r.rejected ? `, rejected ${r.rejected} (gated)` : ""}`);
      break;
    }
    case "land": {
      // Phase 16 M2 (docs/18 §2.2): CLI parity over the same land loop the MCP tool uses,
      // so a human and an agent get identical semantics — landed, or a conflict to decide.
      const repo = await Repo.open(cwd);
      const { land } = await import("./mcp/land.ts");
      const r = await land(repo, {
        view: flag("--view"),
        summary: flag("-m"),
        by: flag("--as") ?? process.env.AVCS_ACTOR ?? "human:cli",
        hub: flag("--remote"),
        workspace: flag("--workspace"),
        maxAttempts: flag("--max-attempts") ? Number(flag("--max-attempts")) : undefined,
      });
      if (r.landed) {
        console.log(`✓ landed — head is now ${r.head.slice(0, 24)}… (${r.attempts} attempt(s), via ${r.via})`);
        break;
      }
      console.error(`✗ not landed (${r.reason}) after ${r.attempts} attempt(s)${r.detail ? ` — ${r.detail}` : ""}`);
      for (const c of (r.conflicts ?? []) as { key?: string; reason?: string }[]) {
        console.error(`  ● ${c.key ?? "?"} — ${c.reason ?? ""}`);
      }
      console.error("  next:");
      for (const a of r.nextActions) console.error(`    - ${a}`);
      process.exitCode = 1;
      break;
    }
    case "submit": {
      // Phase 14 (docs/17): checkpoint the view and submit it to the remote's integration
      // queue. The result is ALWAYS a verdict — never "pull and redo".
      const repo = await Repo.open(cwd);
      const view = flag("--view") ?? "main";
      const remote = flag("--remote") ?? "origin";
      const by = flag("--as") ?? process.env.AVCS_ACTOR ?? "human:cli";
      const checkpoint = await repo.createCheckpoint(view, flag("-m") ?? `submit ${view}`);
      const r = await repo.integrateHub(remote, { view, checkpoint, by });
      switch (r.verdict) {
        case "advanced":
          console.log(`✓ advanced — head is now ${String(r.head).slice(0, 24)}…${r.legacy ? "  [legacy hub fallback]" : ""}`);
          break;
        case "conflict": {
          const packet = r.packet as import("./api/repo.ts").ConflictPacket | undefined;
          console.error(`✗ conflict — ${packet?.conflicts.length ?? 0} key(s) need a decision (repair packet below):`);
          for (const c of packet?.conflicts ?? []) {
            console.error(`  ● ${c.key} — ${c.reason}`);
            for (const o of c.options) console.error(`     - ${o.op.slice(0, 24)}… ${o.actor} :: ${o.purpose}`);
            for (const d of c.priorDecisions) console.error(`     ↩ precedent (${d.decidedBy}): ${d.reason}`);
          }
          console.error(`  decide via MCP avcs.decision.record, then resubmit.`);
          process.exitCode = 1;
          break;
        }
        case "needs_evidence":
          console.log(`… needs_evidence — run validation ONCE against the integrated tree, then resubmit the same ticket:`);
          console.log(`  integrated checkpoint : ${r.integratedCheckpoint}`);
          console.log(`  treeHash              : ${r.treeHash}`);
          console.log(`  required checks       : ${(r.requiredChecks as string[] | undefined)?.join(", ") ?? "(none)"}`);
          console.log(`  ticketId              : ${r.ticketId}`);
          break;
        case "queued":
          console.log(`… queued behind ticket ${String(r.behindTicket).slice(0, 16)}… — retry after ${r.retryAfterMs}ms`);
          break;
        default:
          console.error(`✗ rejected — ${r.reason}`);
          process.exitCode = 1;
      }
      break;
    }
    case "serve": {
      const { startHub } = await import("./hub/hubServer.ts");
      const { consoleLogger } = await import("./observe/logger.ts");
      const dir = args[1] && !args[1].startsWith("--") ? args[1] : cwd;
      const port = Number(flag("--port") ?? 0);
      const gated = args.includes("--gated");
      const quiet = args.includes("--quiet");
      const hub = await startHub({ repoDir: dir, port, gated, logger: quiet ? undefined : consoleLogger("info") });
      console.log(`avcs hub serving ${dir} at ${hub.url}${gated ? " (gated: member-signed ops only)" : ""}`);
      console.log("press Ctrl-C to stop");
      const stop = async () => { await hub.close(); process.exit(0); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await new Promise(() => {}); // run until signalled
      break;
    }
    case "head": {
      const repo = await Repo.open(cwd);
      const view = args[1] ?? "main";
      const h = await repo.protectedHead(view);
      console.log(h ? `${view}: ${h}` : `${view}: (not finalized)`);
      break;
    }
    case "import": {
      const repo = await Repo.open(cwd);
      const src = args[1];
      if (!src) throw new Error("usage: avcs import <source-dir> [-m message] [--author id]");
      const message = flag("-m") ?? flag("--message") ?? `import ${src}`;
      const author = flag("--author") ?? "human:cli";
      // Apply the repo's ignore rules, as `git-sync` already does (issue #48). Without this
      // the same tree captured very differently depending on which command you reached for —
      // `import` pulled node_modules/ and dist/ into history.
      const r = await repo.commitWorkingTree(src, {
        message,
        actor: { kind: "human", id: author },
        ignorePredicate: gitIgnorePredicate(src),
      });
      console.log(`imported ${r.ops.length} file(s) from ${src} (${r.added.length} new)`);
      break;
    }
    case "gc": {
      const repo = await Repo.open(cwd);
      const dryRun = args.includes("--dry-run");
      const r = await repo.gc({ dryRun });
      console.log(`${dryRun ? "would collect" : "collected"} ${r.blobs.length} orphan blob(s), ${r.quarantinedOps.length} expired quarantine op(s)`);
      break;
    }
    case "pack": {
      const repo = await Repo.open(cwd);
      const r = await repo.pack();
      console.log(`packed ${r.packed} loose object(s) into a packfile (blobs left loose)`);
      break;
    }
    case "compact": {
      const repo = await Repo.open(cwd);
      const view = args[1] && !args[1].startsWith("--") ? args[1] : "main";
      const r = await repo.compact(view);
      console.log(`compacted ${view}: persisted a base snapshot over ${r.baseOps} op(s) (cold materialize loads it automatically; AVCS_INCREMENTAL=0 to opt out)`);
      break;
    }
    case "bundle": {
      const repo = await Repo.open(cwd);
      const out = args[1];
      if (!out) throw new Error("usage: avcs bundle <out-file>");
      const { writeFile } = await import("node:fs/promises");
      const b = await repo.exportBundle();
      await writeFile(out, JSON.stringify(b), "utf8");
      console.log(`bundled ${b.objects.length} object(s) + ${Object.keys(b.refs).length} ref(s) → ${out}`);
      break;
    }
    case "unbundle": {
      const repo = await Repo.open(cwd);
      const file = args[1];
      if (!file) throw new Error("usage: avcs unbundle <bundle-file>");
      const { readFile } = await import("node:fs/promises");
      const b = JSON.parse(await readFile(file, "utf8"));
      const r = await repo.importBundle(b);
      console.log(`unbundled ${r.objects} object(s), ${r.refs} ref(s)`);
      break;
    }
    case "checkout": {
      const repo = await Repo.open(cwd);
      const view = args[1] && !args[1].startsWith("--") ? args[1] : "main";
      const written = await repo.checkoutInto(cwd, view);
      console.log(`checked out ${written.length} file(s) from ${view}`);
      break;
    }
    case "commit": {
      const repo = await Repo.open(cwd);
      const message = flag("-m") ?? flag("--message");
      if (!message) throw new Error("usage: avcs commit -m <message> [--author <id>] [--line <line>]");
      const author = flag("--author") ?? "human:cli";
      const line = flag("--line");
      const r = await repo.commitWorkingTree(cwd, { message, actor: { kind: "human", id: author }, ...(line ? { line } : {}) });
      if (!r.ops.length) { console.log("nothing to commit (working tree matches the view)"); break; }
      for (const p of r.added) console.log(`  A ${p}`);
      for (const p of r.modified) console.log(`  M ${p}`);
      for (const p of r.removed) console.log(`  D ${p}`);
      console.log(`committed ${r.ops.length} change(s) as "${message}"`);
      break;
    }
    case "git-sync": {
      const repo = await Repo.open(storeDirFor(cwd));
      const message = flag("-m") ?? flag("--message");
      if (!message) throw new Error("usage: avcs git-sync -m <message> [--commit] [--author <id>] [--line <line>] [--no-add]");
      const author = flag("--author") ?? "human:cli";
      const line = lineFor(cwd, flag("--line"));
      await ensureLine(repo, line);
      const r = await repo.gitSync({ message, actor: { kind: "human", id: author }, workDir: cwd, ...(line ? { line } : {}), ignorePredicate: gitIgnorePredicate(cwd) });
      for (const p of r.captured.added) console.log(`  A ${p}`);
      for (const p of r.captured.modified) console.log(`  M ${p}`);
      for (const p of r.captured.removed) console.log(`  D ${p}`);
      if (r.conflicts.length) {
        console.error(`\n✗ ${r.conflicts.length} open conflict(s) need a human — refusing to stage a conflicted tree.`);
        console.error(`  run \`avcs conflicts ${line ?? "main"}\` to review; resolve, then re-run git-sync.`);
        process.exitCode = 1;
        break;
      }
      console.log(`captured ${r.captured.ops.length} op(s) · checkpoint ${r.checkpoint!.slice(0, 16)}… · treeHash ${r.treeHash!.slice(0, 12)}…`);
      console.log(`reprojected ${r.reprojected} file(s)  [git mode: ${r.mode}]`);
      const wantCommit = args.includes("--commit");
      if (!args.includes("--no-add") || wantCommit) {
        const { execFileSync } = await import("node:child_process");
        try {
          execFileSync("git", ["add", "-A"], { cwd, stdio: "inherit" });
          if (wantCommit) {
            // Inject the provenance trailer (git→avcs) then record the SHA back-link (avcs→git).
            const trailerOn = await repo.gitTrailerEnabled();
            const body = trailerOn
              ? `${message}\n\n${repo.gitTrailer({ checkpoint: r.checkpoint!, treeHash: r.treeHash!, ...(r.captured.intent ? { intent: r.captured.intent } : {}) })}`
              : message;
            execFileSync("git", ["commit", "-m", body], { cwd, stdio: "inherit" });
            const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();
            await repo.recordGitCommit(sha, r.checkpoint!);
            console.log(`committed ${sha.slice(0, 12)} ↔ checkpoint ${r.checkpoint!.slice(0, 16)}…  (\`avcs verify-git\` to check)`);
          } else {
            console.log(`staged working tree (git add -A) — now run \`git commit\` (or re-run with --commit)`);
          }
        } catch {
          console.error(`(git step failed — not a git repo? stage/commit manually, or pass --no-add)`);
          process.exitCode = 1;
        }
      }
      break;
    }
    case "verify-git": {
      const repo = await Repo.open(cwd);
      const { execFileSync } = await import("node:child_process");
      const git = (a: string[]): string => execFileSync("git", a, { cwd }).toString();
      let sha: string;
      try {
        sha = args[1] && !args[1].startsWith("--") ? git(["rev-parse", args[1]]).trim() : git(["rev-parse", "HEAD"]).trim();
      } catch {
        console.error(`not a git repo (or bad ref) — verify-git needs a git commit`);
        process.exitCode = 1;
        break;
      }
      // Find the checkpoint: prefer the local back-link ref, fall back to the commit trailer.
      let cp = await repo.gitCheckpoint(sha);
      if (!cp) {
        const m = git(["log", "-1", "--format=%B", sha]).match(/^AVCS-Checkpoint:\s*(\S+)/m);
        cp = m?.[1] ?? null;
      }
      if (!cp) {
        console.error(`✗ no AVCS checkpoint linked to ${sha.slice(0, 12)} (no back-link ref, no trailer)`);
        process.exitCode = 1;
        break;
      }
      const { treeHashOk, files } = await repo.checkpointFiles(cp);
      const avcs = new Map(files.map((f) => [f.path, f.content]));
      // Compare against git's committed tree, excluding the .avcs/ history itself (committed mode).
      const gitPaths = git(["ls-tree", "-r", "--name-only", sha]).split("\n").filter((p) => p && !p.startsWith(".avcs/"));
      const gitSet = new Set(gitPaths);
      const diffs: string[] = [];
      for (const p of gitSet) if (!avcs.has(p)) diffs.push(`  +git only: ${p}`);
      for (const p of avcs.keys()) if (!gitSet.has(p)) diffs.push(`  -avcs only: ${p}`);
      for (const p of gitSet) if (avcs.has(p) && git(["show", `${sha}:${p}`]) !== avcs.get(p)) diffs.push(`  ≠ content: ${p}`);
      if (!treeHashOk) diffs.push(`  ! checkpoint treeHash no longer reproduces from its frontier`);
      if (diffs.length) {
        console.error(`✗ ${sha.slice(0, 12)} does NOT match checkpoint ${cp.slice(0, 16)}… (${diffs.length} difference(s)):`);
        for (const d of diffs.slice(0, 20)) console.error(d);
        process.exitCode = 1;
      } else {
        console.log(`✓ ${sha.slice(0, 12)} is a faithful projection of checkpoint ${cp.slice(0, 16)}… (${avcs.size} file(s) match)`);
      }
      break;
    }
    case "git-mode": {
      const repo = await Repo.open(cwd);
      const want = args[1];
      if (!want) { console.log(`git mode: ${await repo.getGitMode()}`); break; }
      if (want !== "sidecar" && want !== "committed") throw new Error("usage: avcs git-mode [sidecar|committed]");
      await repo.setGitMode(want);
      console.log(`git mode set to: ${want} (rewrote .avcs/.gitignore)`);
      if (want === "committed") console.log(`  next: \`git add .avcs\` to start tracking AVCS history, then commit`);
      else console.log(`  .avcs/ is now git-ignored; \`git rm -r --cached .avcs\` to stop tracking already-committed history`);
      break;
    }
    case "reindex": {
      const repo = await Repo.open(cwd);
      const r = await repo.reindex();
      console.log(`reindexed ${r.ops} operation(s) into the entity index`);
      break;
    }
    case "install-hooks": {
      await Repo.open(cwd); // validate this is an AVCS repo
      const { execFileSync } = await import("node:child_process");
      let hooksDir: string;
      try {
        const gp = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd }).toString().trim();
        const { isAbsolute, join } = await import("node:path");
        hooksDir = isAbsolute(gp) ? gp : join(cwd, gp);
      } catch {
        console.error(`not a git repo — run \`git init\` first`);
        process.exitCode = 1;
        break;
      }
      const { installed, skipped } = await installHooks(hooksDir, avcsInvocation(), args.includes("--force"));
      if (installed.length) console.log(`installed git hooks: ${installed.join(", ")}`);
      if (skipped.length) console.log(`skipped (foreign hook present, use --force): ${skipped.join(", ")}`);
      console.log(`now \`git commit\` auto-runs avcs sync; \`git pull\`/\`merge\` auto-reprojects`);
      break;
    }
    case "git-hook": {
      // Internal dispatch target for the installed hook scripts (docs/14). Each phase is
      // designed to be safe to run by hand, and a no-op when there is nothing to do.
      const phase = args[1];
      // A git-bridge hook must never hard-block git indefinitely (#33). Every store-touching
      // step runs under a deadline; if it elapses we fail open — let git proceed, warn, and
      // let the next sync catch up — rather than spinning forever. AVCS_HOOK_TIMEOUT_MS=0
      // restores the old unbounded behavior; a non-zero value overrides the default.
      const hookMs = hookTimeoutMs();
      const line = lineFor(cwd);
      const author = process.env.AVCS_AUTHOR ?? "human:cli";
      // cwd is the working tree (possibly a linked git worktree); the store may live in
      // the main checkout. Opening the store can itself block under contention, so bound it.
      const opened = await withDeadline(() => Repo.open(storeDirFor(cwd)), hookMs);
      if (!opened.ok) {
        console.error(`avcs: opening the store exceeded ${hookMs}ms — skipping git-hook ${phase} (#33). Another avcs process may be holding it; set AVCS_HOOK_TIMEOUT_MS=0 to wait.`);
        break; // fail open: never block git on a busy store
      }
      const repo = opened.value;
      switch (phase) {
        case "pre-commit": {
          // Capture working-tree edits as ops, gate on conflicts, checkpoint, reproject,
          // re-stage the canonical projection, and stash the provenance for the next hooks.
          const message = process.env.AVCS_COMMIT_MESSAGE ?? "git commit";
          const res = await withDeadline(async () => {
            await ensureLine(repo, line);
            return repo.gitSync({ message, actor: { kind: "human", id: author }, workDir: cwd, ...(line ? { line } : {}), ignorePredicate: gitIgnorePredicate(cwd) });
          }, hookMs);
          if (!res.ok) {
            console.error(`avcs: pre-commit ingest exceeded ${hookMs}ms — proceeding without audit capture (#33). The change will be captured on the next sync. Set AVCS_HOOK_TIMEOUT_MS=0 to wait, or check for another avcs process holding the store.`);
            break; // fail open: let git complete the commit
          }
          const r = res.value;
          if (r.conflicts.length) {
            console.error(`avcs: ${r.conflicts.length} open conflict(s) — resolve via \`avcs conflicts\` before committing.`);
            process.exit(1); // abort the commit
          }
          execFileSync("git", ["add", "-A"], { cwd, stdio: "inherit" });
          await repo.writeGitPending({ checkpoint: r.checkpoint!, treeHash: r.treeHash!, ...(r.captured.intent ? { intent: r.captured.intent } : {}) }, cwd);
          break;
        }
        case "prepare-commit-msg": {
          // args: [2]=msgFile [3]=source [4]=sha. Append the trailer if enabled & absent.
          const msgFile = args[2];
          if (!msgFile) break;
          const res = await withDeadline(async () => {
            const pending = await repo.readGitPending(cwd);
            if (!pending || !(await repo.gitTrailerEnabled())) return;
            const { readFile, writeFile } = await import("node:fs/promises");
            const cur = await readFile(msgFile, "utf8");
            if (cur.includes("AVCS-Checkpoint:")) return;
            const trailer = repo.gitTrailer({ checkpoint: pending.checkpoint, treeHash: pending.treeHash, ...(pending.intent ? { intent: pending.intent } : {}) });
            await writeFile(msgFile, `${cur.replace(/\n*$/, "")}\n\n${trailer}\n`, "utf8");
          }, hookMs);
          if (!res.ok) console.error(`avcs: prepare-commit-msg exceeded ${hookMs}ms — commit trailer skipped (#33).`);
          break;
        }
        case "post-commit": {
          // `git rev-parse` is a synchronous interop call that returns instantly; keep it
          // outside the deadline, whose callback is meant to bound *async* store work — a
          // sync call inside it would starve the timer (see deadline.ts). All store I/O
          // (read/record/clear pending) stays within the bound.
          const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();
          const res = await withDeadline(async () => {
            const pending = await repo.readGitPending(cwd);
            if (!pending) return;
            await repo.recordGitCommit(sha, pending.checkpoint);
            await repo.clearGitPending(cwd);
          }, hookMs);
          if (!res.ok) console.error(`avcs: post-commit bookkeeping exceeded ${hookMs}ms — commit↔checkpoint link deferred (#33).`);
          break;
        }
        case "post-merge": {
          // A git pull/merge changed the working tree. Committed mode also unioned new
          // `.avcs` objects straight onto disk — rebuild the rebuildable logs/indexes
          // first so materialize sees them. Then CAPTURE-then-reproject (gitSync), not a
          // bare checkoutInto: in sidecar mode the pulled content exists ONLY in git, and
          // reprojecting a stale avcs view would silently revert files the pull just
          // updated (observed live: a release version bump undone by the old hook).
          // Capturing first ingests the pulled tree as ops, making reprojection a no-op
          // on it; in committed mode the capture finds no diff and this reduces to the
          // old behavior plus a checkpoint.
          const res = await withDeadline(async () => {
            await repo.reindex();
            await ensureLine(repo, line);
            return repo.gitSync({ message: process.env.AVCS_COMMIT_MESSAGE ?? "git merge", actor: { kind: "human", id: author }, workDir: cwd, ...(line ? { line } : {}), ignorePredicate: gitIgnorePredicate(cwd) });
          }, hookMs);
          if (!res.ok) console.error(`avcs: post-merge sync exceeded ${hookMs}ms — skipped; run \`avcs git-sync -m "post-merge" --no-add\` if the store looks stale (#33).`);
          else if (res.value.conflicts.length) console.error(`avcs: ${res.value.conflicts.length} open conflict(s) after merge — run \`avcs conflicts ${line ?? "main"}\`.`);
          break;
        }
        default:
          console.error(`unknown git-hook phase: ${phase}`);
          process.exitCode = 1;
      }
      break;
    }
    case "lines": {
      const repo = await Repo.open(cwd);
      const lines = await repo.listLines();
      console.log("main  (root)");
      for (const l of lines) console.log(`${l.name}  ← forked from ${l.baseLine} @ ${l.forkCheckpointOid?.slice(0, 16)}`);
      break;
    }
    case "log": {
      const store = new ObjectStore(cwd);
      const ops = await store.collect<Operation>("operation");
      ops.sort((a, b) => a.lamport - b.lamport);
      for (const op of ops) {
        const tgt = `${op.target.entityKind}:${op.target.entityId}`;
        console.log(
          `[${String(op.lamport).padStart(3, "0")}] ${op.actor.id}  ${op.body.kind} ${tgt}` +
            `\n        ${op.declaredPurpose}`,
        );
      }
      break;
    }
    case "materialize": {
      const repo = await Repo.open(cwd);
      const view = args[1] && !args[1].startsWith("--") ? args[1] : "main";
      const res = await repo.materialize(view);
      const out = flag("--out");
      if (out) {
        await repo.writeWorkspace(res, out);
        console.log(`wrote ${res.tree.size} files to ${out}`);
      } else {
        for (const p of [...res.tree.keys()].sort()) console.log(p);
      }
      break;
    }
    case "workspace": {
      // Native build/verify isolation (docs/16): project a workspace's view to a dir,
      // land it onto its base, or list landed workspaces. `project` is the physical
      // checkout that lets concurrent agents build without colliding on disk.
      const repo = await Repo.open(cwd);
      const sub = args[1];
      if (sub === "project") {
        const name = args[2];
        if (!name || name.startsWith("--")) throw new Error("usage: avcs workspace project <name> [--out <dir>]");
        const out = flag("--out") ?? cwd;
        const written = await repo.checkoutInto(out, "main", { workspace: name });
        console.log(`projected workspace ${name}: ${written.length} file(s) to ${out}`);
      } else if (sub === "land") {
        const name = args[2];
        if (!name) throw new Error("usage: avcs workspace land <name>");
        await repo.landWorkspace(name);
        console.log(`landed workspace ${name}`);
      } else if (sub === "list") {
        const landed = await repo.landedWorkspaces();
        console.log(landed.length ? landed.join("\n") : "(no landed workspaces)");
      } else {
        throw new Error("usage: avcs workspace <project|land|list> ...");
      }
      break;
    }
    case "checkpoint": {
      const repo = await Repo.open(cwd);
      const view = args[1] ?? "main";
      const oid = await repo.createCheckpoint(view, flag("-m") ?? "checkpoint");
      console.log(oid);
      break;
    }
    case "release": {
      const repo = await Repo.open(cwd);
      const view = args[1] && !args[1].startsWith("--") ? args[1] : "main";
      const res = await repo.cutRelease(view, { summary: flag("-m") ?? `release of ${view}` });
      if (!res.released) {
        console.error(`cannot release: ${res.reason}`);
        process.exitCode = 1;
        break;
      }
      const rel = await repo.store.get(res.releaseOid) as { treeHash: string; sbom: { components: unknown[] }; evidence: Record<string, string> };
      console.log(`released ${res.releaseOid}`);
      console.log(`  treeHash : ${rel.treeHash}`);
      console.log(`  sbom     : ${rel.sbom.components.length} components`);
      console.log(`  evidence : ${JSON.stringify(rel.evidence)}`);
      break;
    }
    case "fsck": {
      const store = new ObjectStore(cwd);
      if (!ObjectStore.isRepo(cwd)) throw new Error("not an AVCS repo (no .avcs here)");
      const rebuild = args.includes("--rebuild");
      const r = await store.fsck({ rebuild });
      console.log(`checked ${r.objectsChecked} object(s)`);
      if (r.corrupt.length) {
        console.log(`\n✗ ${r.corrupt.length} corrupt object(s):`);
        for (const c of r.corrupt) console.log(`   ${c.oid}  — ${c.reason}`);
      }
      const d = r.oplogDrift;
      if (d.opsMissingFromLog.length)
        console.log(`\n${rebuild ? "↻ repaired" : "✗"} op-log drift: ${d.opsMissingFromLog.length} operation(s) missing from the log${rebuild ? "" : " (run `avcs fsck --rebuild`)"}`);
      if (d.logEntriesMissingObject.length)
        console.log(`\nℹ ${d.logEntriesMissingObject.length} op-log entr(y/ies) without an object (GC'd or lost)`);
      if (r.repaired) console.log(`   op-log rebuilt → ${r.repaired.oplogEntries} entr(y/ies)`);
      console.log(r.ok ? "\n✓ healthy" : rebuild && r.corrupt.length === 0 ? "\n✓ repaired" : "\n✗ problems found");
      if (!r.ok && !(rebuild && r.corrupt.length === 0)) process.exitCode = 1;
      break;
    }
    case "show": {
      const store = new ObjectStore(cwd);
      const oid = args[1];
      if (!oid) throw new Error("usage: avcs show <oid>");
      console.log(JSON.stringify(await store.get(oid), null, 2));
      break;
    }
    case "mcp": {
      // AVCS's primary, agent-facing interface. `avcs mcp` boots the stdio MCP server
      // (this is what Claude/agents spawn); `avcs mcp install` registers it with the
      // Claude Code CLI. The server loads `@modelcontextprotocol/sdk` lazily, so all the
      // commands above keep working even when that optionalDependency is absent.
      const sub = args[1] && !args[1].startsWith("-") ? args[1] : undefined;
      if (sub === "install") {
        // Mirror `install-hooks`: the registered command re-invokes the EXACT binary the
        // user is running now — node + any --experimental-strip-types flag + this script —
        // so it works for a global install and a source checkout alike.
        const scope = flag("-s") ?? flag("--scope") ?? "user";
        const repoDir = flag("--repo");
        const serverArgv = [process.execPath, ...process.execArgv, process.argv[1]!, "mcp"];
        const addArgs = ["mcp", "add", "avcs", "-s", scope];
        if (repoDir) addArgs.push("-e", `AVCS_REPO=${repoDir}`);
        addArgs.push("--", ...serverArgv);
        const pretty = `claude ${addArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
        const { execFileSync } = await import("node:child_process");
        try {
          execFileSync("claude", addArgs, { stdio: "inherit" });
          console.log(`\nregistered avcs MCP server (scope: ${scope}). Verify with \`claude mcp list\`.`);
        } catch (e) {
          const enoent = (e as NodeJS.ErrnoException)?.code === "ENOENT";
          console.error(
            (enoent
              ? "Claude Code CLI ('claude') not found on PATH. Register it manually:"
              : "`claude mcp add` failed. You can register it manually:") + `\n\n  ${pretty}\n`,
          );
          process.exitCode = 1;
        }
        break;
      }
      if (sub) {
        console.error(`unknown mcp subcommand: ${sub} — use \`avcs mcp\` to serve or \`avcs mcp install\` to register`);
        process.exitCode = 1;
        break;
      }
      const { startMcpServer } = await import("./mcp/server.ts");
      // `--profile core` advertises only the canonical loop's 13 tools (docs/18 §M5).
      await startMcpServer({ profile: flag("--profile") });
      break;
    }
    case "help":
    default:
      console.log(
        "avcs <command>\n\n" +
          "  init [dir] [--mode m]       create a repo (--mode sidecar|committed, default sidecar)\n" +
          "  status [view]               operation/conflict summary\n" +
          "  key provision <actor-id> | key ls   local signing keys (decisions, hub writes)\n" +
          "  conflicts [view]            list decisions a human owes\n" +
          "  import <dir> [-m msg]       import an existing tree (e.g. a git repo) as ops\n" +
          "  gc [--dry-run]              reclaim orphan blobs + expired quarantine ops\n" +
          "  pack                        fold loose objects into a packfile (blobs stay loose)\n" +
          "  compact [view]              persist a base snapshot (cold materialize folds history)\n" +
          "  fsck [--rebuild]            verify object integrity + op-log; --rebuild repairs the log\n" +
          "  bundle <file>               export the whole repo to a portable file\n" +
          "  unbundle <file>             import a bundle into this repo\n" +
          "  checkout [view]             write the view's files into the working dir\n" +
          "  commit -m <msg> [--author id]  author ops for working-tree changes\n" +
          "  git-sync -m <msg> [--commit]   capture edits → checkpoint → reproject → git add (--commit: also commit w/ trailer)\n" +
          "  git-mode [sidecar|committed]   show/set how AVCS history relates to git\n" +
          "  verify-git [<commit>]       check a git commit is a faithful projection of its AVCS checkpoint\n" +
          "  install-hooks [--force]     install git hooks so `git commit`/`pull` auto-sync AVCS\n" +
          "  reindex                     rebuild the entity index (after a git pull of .avcs objects)\n" +
          "  serve [dir] [--port N] [--gated]  run a hub (HTTP) over a repo\n" +
          "  clone <hub-url> [dir] [--key <repo-dir|key-file>] [--as <id>]  create a repo from a hub\n" +
          "  remote add <name> <url>     register a named hub ([--auto-sync] [--freshness-ms N])\n" +
          "  remote rm <name> | remote ls   manage named hubs (.avcs/remotes.json)\n" +
          "  sync [remote] [--as <id>]   pull + push against a named remote (default origin)\n" +
          "  sync --watch [remote]       live-convergence daemon: /events long-poll + contention early warning\n" +
          "  land [--view v] [--remote r] [-m msg] [--as <id>] [--workspace w]  push+merge-check+checkpoint+integrate in one step\n" +
          "  submit [--view v] [--remote r] [-m msg] [--as <id>]  checkpoint + integration-queue submit (never pull-and-redo)\n" +
          "  push <hub-url> [--as <id>] push objects to a hub (signs writes with the actor's key)\n" +
          "  pull <hub-url | dir>        sync objects from a hub or local repo\n" +
          "  head [view]                 show the protected head\n" +
          "  lines                       list lineage lines (Phase 8)\n" +
          "  blame <entityKey> [--line l] who owns an entity and why\n" +
          "  diff <viewA> <viewB>        added/removed/modified paths\n" +
          "  log                         operation history\n" +
          "  materialize [view] [--out d]  project the code tree\n" +
          "  checkpoint <view> [-m msg]  freeze a verified state\n" +
          "  release [view] [-m msg]     cut a verified release + SBOM\n" +
          "  show <oid>                  dump an object\n" +
          "  mcp [--profile core]        run the agent-facing MCP server over stdio (primary interface)\n" +
          "  mcp install [-s scope] [--repo d]  register avcs with the Claude Code CLI (`claude mcp add`)\n" +
          "  version | --version | -v    print the avcs version\n" +
          "  help | --help | -h          show this help\n",
      );
      if (cmd && cmd !== "help") process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
