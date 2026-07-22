// Phase 13.3 (docs/17 §13.3) — incremental reduce is the DEFAULT. The persisted
// compaction base is loaded on every cold start (no AVCS_COMPACT gate), stamped with
// the materializer version + policy oid so a merge-algorithm or policy change silently
// invalidates it (→ full reduce, always correct), and re-persisted automatically once
// the live snapshot is ≥ AUTO_COMPACT_DELTA ops past the last base. AVCS_INCREMENTAL=0
// opts out (the pre-13.3 behavior).
process.env.AVCS_NO_FSYNC = "1"; // the auto-compact test authors 260+ ops

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { encodeCbor, decodeCbor } from "../src/core/cbor.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function seed(repo: Repo, n: number, prefix = "f"): Promise<void> {
  const intent = await repo.createIntent({ title: "t", owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  for (let i = 0; i < n; i++) {
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: `${prefix}${i}.ts`, content: `export const ${prefix}${i} = ${i};\n`, declaredPurpose: `${prefix}${i}` });
  }
}

test("cold start loads the persisted base by default and equals an opted-out full reduce", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-incdef-"));
  try {
    const repo = await Repo.init(dir);
    await seed(repo, 6);
    const expected = (await repo.materialize()).treeHash;
    await repo.compact("main");

    // cold instance: the base is loaded with NO flag set (13.3 default).
    const cold = await Repo.open(dir);
    assert.equal((await cold.materialize()).treeHash, expected, "cold default == warm");
    assert.equal(cold.metrics.snapshot().counters["snapshot.cold.loaded"], 1, "base was actually loaded");

    // opt-out path (AVCS_INCREMENTAL=0) produces the identical tree and never loads.
    process.env.AVCS_INCREMENTAL = "0";
    try {
      const optOut = await Repo.open(dir);
      assert.equal((await optOut.materialize()).treeHash, expected, "opt-out full reduce == default");
      assert.equal(optOut.metrics.snapshot().counters["snapshot.cold.loaded"], undefined, "opt-out never touches the base");
    } finally {
      delete process.env.AVCS_INCREMENTAL;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a materializer-version bump invalidates the cold base (rejected → full reduce, still correct)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-incver-"));
  try {
    const repo = await Repo.init(dir);
    await seed(repo, 5);
    const expected = (await repo.materialize()).treeHash;
    await repo.compact("main");

    // Simulate "the merge algorithm changed since this base was written": rewrite the
    // header stamp to a version that is not the running MATERIALIZER_VERSION.
    const p = join(dir, ".avcs", "snapshot", "main.cbor");
    const raw = decodeCbor(await readFile(p)) as { header: { materializerVersion: string; policyOid: string }; snapshot: unknown };
    raw.header.materializerVersion = "0.0-obsolete";
    await writeFile(p, encodeCbor(raw));

    const cold = await Repo.open(dir);
    assert.equal((await cold.materialize()).treeHash, expected, "stale base is discarded, not misused");
    assert.equal(cold.metrics.snapshot().counters["snapshot.cold.rejected"], 1, "version mismatch → rejected");
    assert.equal(cold.metrics.snapshot().counters["snapshot.cold.loaded"], undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a policy change invalidates the cold base; a pre-13.3 headerless file is rejected too", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-incpol-"));
  try {
    const repo = await Repo.init(dir);
    await seed(repo, 5);
    await repo.compact("main");

    // Policy bump AFTER the base was persisted → the stamped policy oid no longer matches.
    const policy = await repo.policy();
    await repo.setPolicy({ ...policy, version: `${policy.version}+changed`, createdAt: new Date().toISOString() });
    const expected = (await (async () => {
      process.env.AVCS_INCREMENTAL = "0";
      try { return (await Repo.open(dir)).materialize(); } finally { delete process.env.AVCS_INCREMENTAL; }
    })()).treeHash;

    const cold = await Repo.open(dir);
    assert.equal((await cold.materialize()).treeHash, expected, "post-policy-change tree is correct");
    assert.equal(cold.metrics.snapshot().counters["snapshot.cold.rejected"], 1, "policy oid mismatch → rejected");

    // A legacy (pre-13.3, headerless) snapshot file: also rejected, never trusted.
    const p = join(dir, ".avcs", "snapshot", "main.cbor");
    const raw = decodeCbor(await readFile(p)) as { snapshot: unknown };
    await writeFile(p, encodeCbor(raw.snapshot ?? { v: 1 })); // strip the header wrapper
    const cold2 = await Repo.open(dir);
    assert.equal((await cold2.materialize()).treeHash, expected, "headerless base is discarded");
    assert.equal(cold2.metrics.snapshot().counters["snapshot.cold.rejected"], 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("amortized auto-compaction: ≥ AUTO_COMPACT_DELTA ops past the base re-persists on materialize", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-incauto-"));
  try {
    const repo = await Repo.init(dir);
    const snapPath = join(dir, ".avcs", "snapshot", "main.cbor");

    // Below the threshold: no base appears on its own.
    await seed(repo, 5, "a");
    await repo.materialize();
    assert.ok(!existsSync(snapPath), "no auto-persist below the delta");

    // Cross the threshold: the next materialize persists the base automatically.
    await seed(repo, Repo.AUTO_COMPACT_DELTA, "b");
    await repo.materialize();
    assert.ok(existsSync(snapPath), "auto-persisted once ≥ AUTO_COMPACT_DELTA ops past the base");
    assert.equal(repo.metrics.snapshot().counters["snapshot.auto.persisted"], 1);

    // …and a cold start actually uses it.
    const cold = await Repo.open(dir);
    assert.equal((await cold.materialize()).treeHash, (await repo.materialize()).treeHash);
    assert.equal(cold.metrics.snapshot().counters["snapshot.cold.loaded"], 1);

    // Steady state right after persisting: no re-persist until another delta accumulates.
    await repo.materialize();
    assert.equal(repo.metrics.snapshot().counters["snapshot.auto.persisted"], 1, "no churn on every materialize");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
