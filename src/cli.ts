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

import { Repo } from "./api/repo.ts";
import { ObjectStore } from "./store/objectStore.ts";
import type { Operation } from "./objects/types.ts";

const args = process.argv.slice(2);
const cmd = args[0];
const cwd = process.cwd();

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  switch (cmd) {
    case "init": {
      const dir = args[1] ?? cwd;
      await Repo.init(dir);
      console.log(`initialized AVCS repo at ${dir}/.avcs`);
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
      break;
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
      if (!url || !/^https?:\/\//.test(url)) throw new Error("usage: avcs push <hub-url>");
      const r = await repo.pushHub(url);
      console.log(`pushed ${r.pushed} object(s) to ${url}${r.rejected ? `, rejected ${r.rejected} (gated)` : ""}`);
      break;
    }
    case "clone": {
      const url = args[1];
      const dir = args[2] ?? cwd;
      if (!url || !/^https?:\/\//.test(url)) throw new Error("usage: avcs clone <hub-url> [dir]");
      const repo = await Repo.init(dir);
      const r = await repo.pullHub(url);
      console.log(`cloned ${r.pulled} object(s) from ${url} into ${dir}`);
      break;
    }
    case "serve": {
      const { startHub } = await import("./hub/hubServer.ts");
      const dir = args[1] && !args[1].startsWith("--") ? args[1] : cwd;
      const port = Number(flag("--port") ?? 0);
      const gated = args.includes("--gated");
      const hub = await startHub({ repoDir: dir, port, gated });
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
    case "show": {
      const store = new ObjectStore(cwd);
      const oid = args[1];
      if (!oid) throw new Error("usage: avcs show <oid>");
      console.log(JSON.stringify(await store.get(oid), null, 2));
      break;
    }
    default:
      console.log(
        "avcs <command>\n\n" +
          "  init [dir]                  create a repo\n" +
          "  status [view]               operation/conflict summary\n" +
          "  conflicts [view]            list decisions a human owes\n" +
          "  checkout [view]             write the view's files into the working dir\n" +
          "  commit -m <msg> [--author id]  author ops for working-tree changes\n" +
          "  serve [dir] [--port N] [--gated]  run a hub (HTTP) over a repo\n" +
          "  clone <hub-url> [dir]       create a repo from a hub\n" +
          "  push <hub-url>              push objects to a hub\n" +
          "  pull <hub-url | dir>        sync objects from a hub or local repo\n" +
          "  head [view]                 show the protected head\n" +
          "  lines                       list lineage lines (Phase 8)\n" +
          "  blame <entityKey> [--line l] who owns an entity and why\n" +
          "  diff <viewA> <viewB>        added/removed/modified paths\n" +
          "  log                         operation history\n" +
          "  materialize [view] [--out d]  project the code tree\n" +
          "  checkpoint <view> [-m msg]  freeze a verified state\n" +
          "  release [view] [-m msg]     cut a verified release + SBOM\n" +
          "  show <oid>                  dump an object\n",
      );
      if (cmd) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
