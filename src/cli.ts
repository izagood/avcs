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
