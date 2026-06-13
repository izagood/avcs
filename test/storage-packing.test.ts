// Storage B2 (docs/11): pack folds loose object files into a packfile + index. Packing is
// a transparent read optimization — every read returns the same object whether it is loose
// or packed, and materialize is byte-identical before and after a pack. Blobs are left
// loose so redaction can always scrub their bytes; we assert that explicitly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor, Operation } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

/** Count loose object files (across shards) whose name starts with `prefix`. */
async function looseCount(dir: string, prefix: string): Promise<number> {
  const objects = join(dir, ".avcs", "objects");
  if (!existsSync(objects)) return 0;
  let n = 0;
  for (const shard of await readdir(objects)) {
    const sd = join(objects, shard);
    for (const f of await readdir(sd).catch(() => [] as string[])) if (f.startsWith(prefix) && f.endsWith(".json")) n++;
  }
  return n;
}

test("pack is a transparent read optimization: materialize identical, non-blobs packed, blobs loose", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-pack-"));
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    for (let i = 0; i < 6; i++) {
      await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: `f${i}.ts`, content: `export const v${i} = ${i}\n`, declaredPurpose: `f${i}` });
    }
    const before = (await repo.materialize()).treeHash;
    const opsBefore = (await repo.store.collect<Operation>("operation")).length;
    assert.ok(await looseCount(dir, "operation_") > 0, "ops start loose");

    const { packed } = await repo.pack();
    assert.ok(packed > 0, "packed some objects");

    // non-blob loose files are gone; blobs remain loose (redaction-safe).
    assert.equal(await looseCount(dir, "operation_"), 0, "operations were packed (no loose left)");
    assert.ok(await looseCount(dir, "blob_") > 0, "blobs stay loose");

    // reads still work: list count unchanged, get works, treeHash identical from a COLD reopen.
    assert.equal((await repo.store.collect<Operation>("operation")).length, opsBefore, "list still sees every op");
    const cold = await Repo.open(dir);
    assert.equal((await cold.materialize()).treeHash, before, "materialize identical after pack (cold reopen)");

    // packing again is a no-op (nothing loose to pack besides blobs, which are excluded).
    assert.equal((await repo.pack()).packed, 0, "second pack finds nothing to do");

    // authoring after a pack keeps working (new ops land loose, coexist with packed ones).
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "after.ts", content: "export const a = 1\n", declaredPurpose: "after" });
    const after = (await repo.materialize()).treeHash;
    assert.notEqual(after, before, "tree changed");
    assert.equal((await (await Repo.open(dir)).materialize()).treeHash, after, "cold == warm after post-pack author");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("redaction still scrubs plaintext after a pack (blobs were never packed)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-packredact-"));
  try {
    const repo = await Repo.init(dir);
    const root = generateKeypair();
    const admin = generateKeypair();
    await repo.registerMembership({ actorId: "human:admin", publicKey: admin.publicKey, role: "admin", root: { keyId: "root", privateKey: root.privateKey } });
    await repo.registerMembership({ actorId: "ai:a", publicKey: generateKeypair().publicKey, role: "proposer", root: { keyId: "root", privateKey: root.privateKey } });
    const intent = await repo.createIntent({ title: "t", owner: "human:admin" });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "secret.env", content: "AWS_KEY=AKIA_leaked\n", declaredPurpose: "oops" });
    const blobOid = (await repo.materialize()).tree.get("secret.env")!;

    await repo.pack(); // pack the ops; the blob stays loose

    await repo.redact(blobOid, "leaked key", "human:admin", { keyId: "human:admin", privateKey: admin.privateKey });
    assert.doesNotMatch((await repo.readBlob(blobOid)).toString("utf8"), /AKIA_leaked/, "warm read scrubbed");
    assert.doesNotMatch((await (await Repo.open(dir)).readBlob(blobOid)).toString("utf8"), /AKIA_leaked/, "cold read scrubbed (no packed plaintext)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
