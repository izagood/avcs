// Op-log foundation for incremental reduce (docs/11 A5). The op-log must list EVERY
// operation in the store regardless of how it entered — authoring, hub pull, bundle
// import — because it enters through the single ObjectStore.put choke point. A reader
// (A6) tails it to re-reduce only the delta; a missing entry would silently drop an op,
// so the load-bearing invariant tested here is: oplog ⊇ current operations, in
// first-write order, deduped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import type { Actor, Operation } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function opSet(repo: Repo): Promise<Set<string>> {
  return new Set((await repo.store.collect<Operation>("operation")).map((o) => o.oid as string));
}

test("op-log lists every authored op in first-write order, deduped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-oplog-"));
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    const o1 = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "a", declaredPurpose: "a" });
    const o2 = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "b.ts", content: "b", declaredPurpose: "b" });
    const o3 = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "c.ts", content: "c", declaredPurpose: "c", causalDeps: [o1] });

    const log = await repo.store.readOpLog();
    assert.deepEqual(log, [o1, o2, o3], "op-log is exactly the authored ops in order");

    // re-writing the same op object is idempotent — no duplicate log entry.
    const again = await repo.store.put(await repo.store.get(o1));
    assert.equal(again, o1);
    assert.deepEqual(await repo.store.readOpLog(), [o1, o2, o3], "idempotent put adds no log entry");

    // every current operation appears in the log (the load-bearing invariant).
    const ops = await opSet(repo);
    const logged = new Set(await repo.store.readOpLog());
    for (const oid of ops) assert.ok(logged.has(oid), `op ${oid} missing from log`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("op-log captures ops that arrive via hub pull and bundle import", async () => {
  const centralDir = await mkdtemp(join(tmpdir(), "avcs-c-"));
  const peerDir = await mkdtemp(join(tmpdir(), "avcs-p-"));
  const impDir = await mkdtemp(join(tmpdir(), "avcs-i-"));
  const central = await Repo.init(centralDir);
  const hub = await startHub({ repoDir: centralDir, port: 0 });
  try {
    const intent = await central.createIntent({ title: "t", owner: "human:h" });
    const sess = await central.startSession({ intentOid: intent, actor: ai });
    await central.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "a", declaredPurpose: "a" });
    await central.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "b.ts", content: "b", declaredPurpose: "b" });
    await central.pushHub(hub.url);

    // (a) pull: a fresh peer's op-log must list the pulled ops.
    const peer = await Repo.init(peerDir);
    await peer.pullHub(hub.url);
    const peerLog = new Set(await peer.store.readOpLog());
    for (const oid of await opSet(peer)) assert.ok(peerLog.has(oid), `pulled op ${oid} missing from peer log`);
    assert.ok(peerLog.size >= 2);

    // (b) import: a bundle's ops must land in the importer's op-log.
    const bundle = await central.exportBundle();
    const imp = await Repo.init(impDir);
    await imp.importBundle(bundle);
    const impLog = new Set(await imp.store.readOpLog());
    for (const oid of await opSet(imp)) assert.ok(impLog.has(oid), `imported op ${oid} missing from import log`);
  } finally {
    await hub.close();
    await rm(centralDir, { recursive: true, force: true });
    await rm(peerDir, { recursive: true, force: true });
    await rm(impDir, { recursive: true, force: true });
  }
});

test("rebuildOpLog reconstructs the log from a full scan (pre-existing / corrupted stores)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-rebuild-"));
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "a", declaredPurpose: "a" });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "b.ts", content: "b", declaredPurpose: "b" });

    const n = await repo.store.rebuildOpLog();
    const ops = await opSet(repo);
    assert.equal(n, ops.size, "rebuild counts every operation");
    assert.deepEqual(new Set(await repo.store.readOpLog()), ops, "rebuilt log = current op set");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
