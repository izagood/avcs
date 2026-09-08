// Two operations with the SAME effect on a key are agreement, not contention (issue #176).
//
// Blobs are content-addressed, so identical bytes converge on their own; operations carry
// provenance, so they never do. That is right for genuinely concurrent authorship — but when
// two heads on a key write the same blob to the same path (or both delete it), provenance is
// the only thing that differs, and nobody can meaningfully arbitrate it. The reducer used to
// send exactly that case to `needs_decision` ("score tie — needs a human"): two repos that
// `import` the same tree and are merged into one store projected NOTHING, and a file deleted
// concurrently on two scopes stayed as a 61-way tie. Same effect ⇒ accept every head; the
// outcome for the key is one whatever the order, so determinism holds and provenance stays.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor, AnyObject } from "../src/objects/types.ts";

const cli: Actor = { kind: "human", id: "human:cli" };
const alice: Actor = { kind: "ai_agent", id: "ai:alice" };
const bob: Actor = { kind: "ai_agent", id: "ai:bob" };
const mk = (p: string) => mkdtemp(join(tmpdir(), p));

async function treeWith(files: Record<string, string>): Promise<string> {
  const dir = await mk("avcs-agree-tree-");
  for (const [p, c] of Object.entries(files)) await writeFile(join(dir, p), c);
  return dir;
}

test("#176 — two repos import the same tree; merged, every file projects and nothing needs a human", async () => {
  const files = { "a.ts": "export const a = 1\n", "README.md": "# same\n" };
  const [t1, t2, d1, d2, dm] = await Promise.all([treeWith(files), treeWith(files), mk("avcs-agree-r1-"), mk("avcs-agree-r2-"), mk("avcs-agree-m-")]);
  try {
    const r1 = await Repo.init(d1);
    await r1.commitWorkingTree(t1, { message: "initial import", actor: cli });
    const r2 = await Repo.init(d2);
    await r2.commitWorkingTree(t2, { message: "initial import", actor: cli });

    // Every object each repo holds, in its own objlog order — what a hub round-trip delivers.
    const objectsOf = async (repo: Repo): Promise<AnyObject[]> => {
      const out: AnyObject[] = [];
      for (const oid of await repo.store.readObjLog()) out.push(await repo.store.get(oid));
      return out;
    };
    const merged = await Repo.init(dm);
    await merged.importObjects(await objectsOf(r1));
    await merged.importObjects(await objectsOf(r2));

    const res = await merged.materialize("main");
    assert.deepEqual(res.conflicts, [], "identical bytes at the same path are the same assertion made twice");
    assert.deepEqual([...res.tree.keys()].sort(), ["README.md", "a.ts"], "every file projects");
    for (const s of res.statuses.values()) assert.ok(s === "accepted" || s === "superseded", `no op is left for a human: ${s}`);
    // Same outcome as either repo alone — agreement changes nothing about the tree.
    assert.equal(res.treeHash, (await r1.materialize("main")).treeHash);
  } finally {
    for (const d of [t1, t2, d1, d2, dm]) await rm(d, { recursive: true, force: true });
  }
});

test("two concurrent deletes of the same path agree: the file is gone and nothing is asked", async () => {
  const dir = await mk("avcs-agree-del-");
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "t", owner: cli.id });
    const sess = await repo.startSession({ intentOid: intent, actor: cli });
    const base = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: cli, path: "gone.txt", content: "bye\n", declaredPurpose: "seed" });
    for (const actor of [alice, bob]) {
      await repo.proposeOperation({ sessionOid: sess, intentOid: intent, actor, target: { entityKind: "file", entityId: "gone.txt" }, body: { kind: "delete_file", path: "gone.txt" }, declaredPurpose: `delete as ${actor.id}`, causalDeps: [base] });
    }
    const res = await repo.materialize("main");
    assert.deepEqual(res.conflicts, [], "deleting a file twice is not a disagreement about it");
    assert.ok(!res.tree.has("gone.txt"), "the file is gone");
    assert.equal([...res.statuses.values()].filter((s) => s === "needs_decision").length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("control: the same path written with DIFFERENT content is still a concurrent_write conflict", async () => {
  const dir = await mk("avcs-agree-ctl-");
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "t", owner: cli.id });
    const sess = await repo.startSession({ intentOid: intent, actor: cli });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: alice, path: "x.bin", content: Buffer.from([0, 1, 2]), declaredPurpose: "alice" });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: bob, path: "x.bin", content: Buffer.from([0, 9, 8]), declaredPurpose: "bob" });
    const res = await repo.materialize("main");
    assert.equal(res.conflicts.length, 1, "different bytes really are a disagreement");
    assert.equal(res.conflicts[0]!.kind, "concurrent_write");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("control: a delete racing a put of the same path still conflicts", async () => {
  const dir = await mk("avcs-agree-ctl2-");
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "t", owner: cli.id });
    const sess = await repo.startSession({ intentOid: intent, actor: cli });
    const base = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: cli, path: "f.bin", content: Buffer.from([1]), declaredPurpose: "seed" });
    await repo.proposeOperation({ sessionOid: sess, intentOid: intent, actor: alice, target: { entityKind: "file", entityId: "f.bin" }, body: { kind: "delete_file", path: "f.bin" }, declaredPurpose: "alice deletes", causalDeps: [base] });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: bob, path: "f.bin", content: Buffer.from([2]), declaredPurpose: "bob rewrites", causalDeps: [base] });
    const res = await repo.materialize("main");
    assert.equal(res.conflicts.length, 1, "delete vs write is a real disagreement");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
