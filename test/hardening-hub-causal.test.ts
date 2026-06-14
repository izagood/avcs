// Track E / E4 — causal-completeness hold-back. A push is N independent POSTs, so a
// dependent op (B, a symbol edit) can arrive at a replica BEFORE its causal ancestor
// (A, the file that defines the symbol). Without a guard the reducer treats the missing
// dep as an absent edge and applies B anyway → a transient WRONG tree. E4 holds B back
// until A arrives; once the set is complete the result is identical to a full sync.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor, Operation, AnyObject } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

test("E4: a dependent op that arrives before its causal ancestor is held back, then converges", async () => {
  const d1 = await mkdtemp(join(tmpdir(), "avcs-e4-src-"));
  const d2 = await mkdtemp(join(tmpdir(), "avcs-e4-dst-"));
  try {
    // Author A (file) then B (symbol edit on that file, depends on A) on the source repo.
    const src = await Repo.init(d1);
    const intent = await src.createIntent({ title: "t", owner: "human:h" });
    const sess = await src.startSession({ intentOid: intent, actor: ai });
    const aOid = await src.proposeFileWrite({
      sessionOid: sess, intentOid: intent, actor: ai, path: "f.ts",
      content: "export function greet() {\n  return 0\n}\n", declaredPurpose: "scaffold",
    });
    await src.proposeSymbolEdit({
      sessionOid: sess, intentOid: intent, actor: ai, path: "f.ts", symbolName: "greet",
      newText: "export function greet() {\n  return 1\n}", declaredPurpose: "edit", causalDeps: [aOid],
    });
    const expected = (await src.materialize()).treeHash; // the fully-synced result

    const aOp = await src.store.get<Operation>(aOid);
    const aBlob = (aOp.body as { blobOid?: string }).blobOid;

    // Partial sync: copy EVERYTHING to the destination EXCEPT A's op and A's blob —
    // i.e. B (and its blob) arrive first, the ancestor A is still in flight.
    const dst = await Repo.init(d2);
    for await (const o of src.store.list()) {
      const oid = o.oid as string;
      if (oid === aOid || (aBlob && oid === aBlob)) continue;
      await dst.store.put(o as AnyObject);
    }

    // Before A arrives: B is causally incomplete → NOT projected. No wrong tree.
    const partial = await dst.materialize();
    assert.ok(!partial.tree.has("f.ts"), "dependent op held back — file not materialized without its ancestor");
    assert.ok((dst.metrics.snapshot().counters?.["materialize.causallyPending"] ?? 0) >= 1, "a pending op was counted");

    // A arrives → the set is complete → converges to the same tree as a full sync.
    await dst.store.put(aOp);
    if (aBlob) await dst.store.put(await src.store.get(aBlob));
    const full = await dst.materialize();
    assert.ok(full.tree.has("f.ts"), "file materializes once the ancestor arrives");
    assert.equal(full.treeHash, expected, "converges to the fully-synced treeHash");
  } finally {
    await rm(d1, { recursive: true, force: true });
    await rm(d2, { recursive: true, force: true });
  }
});
