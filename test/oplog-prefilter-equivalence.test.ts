// The op-log prefilter must not change WHAT a view sees — only how much gets read.
//
// `materialize` now picks candidates from the log's line/workspace records instead of reading
// every operation and rejecting most of them. That is only safe if the two paths agree
// exactly, so these tests build a repo with several lines, a workspace, an unlanded workspace
// and a forked line, then compare the record path against the legacy bare-oid path — which is
// the pre-change behaviour, still reachable by stripping the metadata off the log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { ObjectStore } from "../src/store/objectStore.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

/** Rewrite the log as bare oids, preserving order — a store as it looked before records. */
async function stripRecords(dir: string): Promise<void> {
  const p = join(dir, ".avcs", "oplog");
  const oids = await new ObjectStore(dir).readOpLog();
  await writeFile(p, oids.map((o) => `${o}\n`).join(""), "utf8");
}

/** A repo whose ops are spread over lines and workspaces, plus a forked line. */
async function mixed(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-prefilter-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  const write = async (path: string, content: string, extra: Record<string, unknown> = {}) => {
    const res = await repo.materialize();
    await repo.proposeFileWrite({
      sessionOid: sess, intentOid: intent, actor: ai, path, content,
      declaredPurpose: path, causalDeps: res.headOps, ...extra,
    });
  };

  for (let i = 0; i < 4; i++) await write(`main${i}.ts`, `m${i}\n`);
  // A forked line inherits main's frontier at the fork.
  await repo.createLine("feature", "main");
  for (let i = 0; i < 3; i++) await write(`feat${i}.ts`, `f${i}\n`, { line: "feature" });
  for (let i = 0; i < 2; i++) await write(`main-after${i}.ts`, `a${i}\n`);
  // Workspace-tagged ops on main: one workspace lands, one does not.
  await write("ws-landed.ts", "L\n", { workspace: "wsA" });
  await write("ws-open.ts", "O\n", { workspace: "wsB" });
  await repo.landWorkspace("wsA");
  return dir;
}

/** Everything about a reduction that a caller can observe. */
const shape = (r: Awaited<ReturnType<Repo["materialize"]>>) => ({
  treeHash: r.treeHash,
  tree: [...r.tree.keys()].sort(),
  statuses: [...r.statuses].sort(),
  headOps: [...r.headOps].sort(),
  conflicts: r.conflicts.length,
});

test("the record path and the legacy path agree on every view", async () => {
  const dir = await mixed();
  const views: { label: string; call: (r: Repo) => Promise<unknown> }[] = [
    { label: "main", call: (r) => r.materialize() },
    { label: "feature", call: (r) => r.materialize("feature") },
    { label: "main+wsA", call: (r) => r.materialize("main", { workspace: "wsA" }) },
    { label: "main+wsB", call: (r) => r.materialize("main", { workspace: "wsB" }) },
  ];

  // With records (the new path).
  const withRecords: Record<string, unknown> = {};
  for (const v of views) {
    const repo = await Repo.open(dir); // a cold handle per view: no cache carried over
    withRecords[v.label] = shape((await v.call(repo)) as Awaited<ReturnType<Repo["materialize"]>>);
  }

  // Same store, metadata stripped (the pre-change path).
  //
  // Stripped before EVERY view, not once: a materialize over a metadata-less log upgrades it
  // on the way out, so after the first view the log would carry records again and both sides
  // would be taking the same path — the comparison would pass by construction. The first
  // version of this test did exactly that and reported agreement while the record path was
  // provably dropping a forked line's inherited ops.
  for (const v of views) {
    await stripRecords(dir);
    const entries = await new ObjectStore(dir).readOpLogEntries();
    assert.ok(entries.every((e) => !e.meta), "the log must be metadata-less for this leg");
    const repo = await Repo.open(dir);
    const legacy = shape((await v.call(repo)) as Awaited<ReturnType<Repo["materialize"]>>);
    assert.deepEqual(legacy, withRecords[v.label], `view ${v.label} differs between the two paths`);
  }
  await rm(dir, { recursive: true, force: true });
});

test("a legacy log is upgraded in place by the materialize that had to read it", async () => {
  const dir = await mixed();
  await stripRecords(dir);

  const repo = await Repo.open(dir);
  const before = await repo.materialize();
  const upgraded = await new ObjectStore(dir).readOpLogEntries();
  assert.ok(upgraded.every((e) => e.meta), "every entry should carry metadata after one materialize");

  // And the upgrade must not have changed the answer.
  const after = await (await Repo.open(dir)).materialize();
  assert.equal(after.treeHash, before.treeHash);
  assert.deepEqual([...after.tree.keys()].sort(), [...before.tree.keys()].sort());
  await rm(dir, { recursive: true, force: true });
});

test("the prefilter reads only what the view can use", async () => {
  const dir = await mixed();
  const repo = await Repo.open(dir);
  const original = ObjectStore.prototype.get;
  let gets = 0;
  ObjectStore.prototype.get = function (this: ObjectStore, oid: string) {
    if (oid.startsWith("operation_")) gets++;
    return (original as (o: string) => Promise<unknown>).call(this, oid);
  } as typeof ObjectStore.prototype.get;
  let logged = 0;
  try {
    await repo.materialize();
    logged = (await new ObjectStore(dir).readOpLog()).length;
  } finally {
    ObjectStore.prototype.get = original;
  }
  assert.ok(logged > 0);
  assert.ok(
    gets < logged,
    `read ${gets} operation objects for a ${logged}-op log — the prefilter bought nothing`,
  );
  await rm(dir, { recursive: true, force: true });
});
