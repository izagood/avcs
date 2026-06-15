// A6: materialize tails operations from the op-log into a warm in-memory cache instead
// of scanning every shard. The cache is a pure optimization — a warm Repo must always
// agree with a cold one (fresh Repo.open) byte-for-byte (treeHash), including after
// authoring more ops, GC, and redaction (the mutations that invalidate the caches).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

/** A cold materialize: a brand-new Repo instance with empty caches, reading from disk. */
async function coldTreeHash(dir: string): Promise<string> {
  return (await (await Repo.open(dir)).materialize()).treeHash;
}

test("warm (cached) materialize agrees with cold across authoring", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-tail-"));
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "export function a(){ return 1 }\n", declaredPurpose: "a" });

    const warm1 = (await repo.materialize()).treeHash; // populates the op cache
    const warm1b = (await repo.materialize()).treeHash; // pure cache hit
    assert.equal(warm1, warm1b);
    assert.equal(warm1, await coldTreeHash(dir), "warm == cold after first author");

    // author more on the SAME warm instance — the op-log tail must pick up the new op.
    await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", newText: "export function a(){ return 2 }", declaredPurpose: "edit" });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "b.ts", content: "export const b = 1\n", declaredPurpose: "b" });
    const warm2 = (await repo.materialize()).treeHash;
    assert.notEqual(warm2, warm1, "tree changed after edits");
    assert.equal(warm2, await coldTreeHash(dir), "warm == cold after more authoring");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("warm materialize agrees with cold after gc and redaction (cache invalidation)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-tail2-"));
  try {
    const repo = await Repo.init(dir);
    const root = generateKeypair();
    const admin = generateKeypair();
    await repo.registerMembership({ actorId: "human:admin", publicKey: admin.publicKey, role: "admin", root: { keyId: "root", privateKey: root.privateKey } });
    await repo.registerMembership({ actorId: "ai:a", publicKey: generateKeypair().publicKey, role: "proposer", root: { keyId: "root", privateKey: root.privateKey } });
    const intent = await repo.createIntent({ title: "t", owner: "human:admin" });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "keep.ts", content: "export const k = 1\n", declaredPurpose: "k" });
    const mat = await repo.materialize(); // warm the caches
    const secretOid = mat.tree.get("keep.ts")!;

    // redact the blob on the warm instance — the blob cache must be evicted.
    await repo.redact(secretOid, "leak", "human:admin", { keyId: "human:admin", privateKey: admin.privateKey });
    const afterRedact = await repo.materialize();
    assert.equal(afterRedact.treeHash, await coldTreeHash(dir), "warm == cold after redact");
    assert.match((await repo.readBlob(secretOid)).toString("utf8"), /REDACTED/, "warm read sees the stub, not stale plaintext");

    // gc (dry run false) then materialize — caches dropped for deleted objects.
    await repo.gc();
    const afterGc = await repo.materialize();
    assert.equal(afterGc.treeHash, await coldTreeHash(dir), "warm == cold after gc");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
