// Storage B3 — compaction (docs/11). compact() persists the current reduction as a
// durable base snapshot; a later COLD materialize (AVCS_COMPACT=1) loads it and
// reduceIncremental's only the ops added since, folding settled history into the base
// instead of replaying it. The original ops remain on disk (append-only audit). The
// load-bearing invariant — identical to Track A — is that the compacted path equals a
// full reduce; we run with the self-verify guard ON so any divergence throws.
process.env.AVCS_COMPACT = "1";
process.env.AVCS_VERIFY_INCREMENTAL = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

/** A full reduce from a process with no base and the compaction flags off. */
async function fullTreeHash(dir: string): Promise<string> {
  const saved = process.env.AVCS_COMPACT;
  delete process.env.AVCS_COMPACT;
  try { return (await (await Repo.open(dir)).materialize()).treeHash; }
  finally { if (saved) process.env.AVCS_COMPACT = saved; }
}

test("cold materialize from a persisted compaction base equals full reduce, then absorbs new ops", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-compact-"));
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    for (let i = 0; i < 8; i++) {
      await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: `f${i}.ts`, content: `export function g${i}(){ return 0 }\n`, declaredPurpose: `f${i}` });
    }
    await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: ai, path: "f0.ts", newText: "export function g0(){ return 1 }", declaredPurpose: "edit" });
    const expected = (await repo.materialize()).treeHash;

    // compact: persist the base snapshot.
    const c = await repo.compact("main");
    assert.ok(c.baseOps >= 9, `base covers all ops, got ${c.baseOps}`);
    assert.ok(existsSync(join(dir, ".avcs", "snapshot", "main.cbor")), "base snapshot persisted");
    // D2: the snapshot is written atomically (temp→rename) — no torn file, no temp leak.
    const { readdir } = await import("node:fs/promises");
    const snapFiles = await readdir(join(dir, ".avcs", "snapshot"));
    assert.ok(!snapFiles.some((f) => f.includes(".tmp-")), "no leftover temp snapshot file");

    // a brand-new (cold) instance loads the base and materializes identically.
    const cold = await Repo.open(dir);
    const fromBase = (await cold.materialize()).treeHash;
    assert.equal(fromBase, expected, "cold compacted materialize == full");
    assert.equal(fromBase, await fullTreeHash(dir), "and == an independent full reduce");

    // author MORE ops after compaction; the persisted base + delta must still equal full.
    await cold.proposeEdit({ sessionOid: sess, intentOid: intent, actor: ai, path: "f0.ts", newText: "export function g0(){ return 2 }", declaredPurpose: "edit2" });
    await cold.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "f9.ts", content: "export const z = 1\n", declaredPurpose: "f9" });
    const after = (await cold.materialize()).treeHash;
    assert.equal(after, await fullTreeHash(dir), "base + post-compaction delta == full");

    // a fresh cold instance (loads base from disk, then sees the new ops) also matches.
    assert.equal((await (await Repo.open(dir)).materialize()).treeHash, after, "second cold instance matches");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compaction base survives a conflict/decision history and stays correct", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-compact2-"));
  const human: Actor = { kind: "human", id: "human:h" };
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "t", owner: human.id });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    const sessH = await repo.startSession({ intentOid: intent, actor: human });
    // a concurrent conflict resolved by policy (human wins), then a clean file.
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "x.ts", content: "ai", declaredPurpose: "ai" });
    await repo.proposeFileWrite({ sessionOid: sessH, intentOid: intent, actor: human, path: "x.ts", content: "hu", declaredPurpose: "hu" });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "y.ts", content: "y", declaredPurpose: "y" });
    await repo.compact("main");

    const cold = await Repo.open(dir);
    assert.equal((await cold.materialize()).treeHash, await fullTreeHash(dir), "conflicted history compacts correctly");
    // add a new op on top of the compacted base.
    await cold.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "z.ts", content: "z", declaredPurpose: "z" });
    assert.equal((await cold.materialize()).treeHash, await fullTreeHash(dir), "delta on a conflicted base stays correct");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
