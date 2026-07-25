// Phase 16 M4.3 (docs/18 §4.3) — the local watcher behind MCP notifications.
//
// Zero-dep by design: the correctness path is polling `.avcs` (oplog length + governance
// refs), because fs.watch is per-platform unreliable and a MISSED head advance is exactly
// the failure this feature exists to prevent. The detector is separated from the SDK's
// notification plumbing so it can be driven directly here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { RepoWatcher } from "../src/mcp/watch.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const bob: Actor = { kind: "ai_agent", id: "ai:b" };

async function tmpRepo(): Promise<{ repo: Repo; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-mcp-watch-"));
  return { repo: await Repo.init(dir), dir };
}

async function author(repo: Repo, path: string, content: string, actor: Actor): Promise<string> {
  const intent = await repo.createIntent({ title: `w ${path}`, owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor });
  return repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor, path, content, declaredPurpose: "p" });
}

test("the first poll establishes a baseline and reports nothing", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await author(repo, "a.ts", "x\n", ai);
    const w = new RepoWatcher(repo);
    assert.deepEqual(await w.poll(), [], "arriving at a repo with history is not an event");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a new object after the baseline is reported once, not on every poll", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const w = new RepoWatcher(repo);
    await w.poll();
    await author(repo, "a.ts", "x\n", ai);
    const first = await w.poll();
    assert.ok(first.length > 0, `the arrival is reported, got ${JSON.stringify(first)}`);
    assert.deepEqual(await w.poll(), [], "a quiet repo produces no repeat events");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a head advance is reported as head-advanced with the view and new head", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await author(repo, "a.ts", "x\n", ai);
    const w = new RepoWatcher(repo);
    await w.poll();
    const cp = await repo.createCheckpoint("main", "cut");
    await repo.finalize({ view: "main", newCheckpoint: cp, parentHead: null, by: "human:h" });
    const events = await w.poll();
    const head = events.find((e) => e.type === "head-advanced");
    assert.ok(head, `got ${JSON.stringify(events.map((e) => e.type))}`);
    assert.equal(head.view, "main");
    assert.ok(head.head, "the new head travels with the event");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("another actor's op on a key I am working on raises foreign-op-hot-key", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await author(repo, "hot.ts", "mine\n", ai);
    const w = new RepoWatcher(repo);
    // The server tells the watcher which keys THIS client authored on — a stdio server is
    // one per client, so that scope is exactly right.
    w.trackKeys(["file:hot.ts"]);
    await w.poll();

    const intent = await repo.createIntent({ title: "theirs", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: bob });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: bob, path: "hot.ts", content: "theirs\n", declaredPurpose: "p" });

    const events = await w.poll();
    const hot = events.find((e) => e.type === "foreign-op-hot-key");
    assert.ok(hot, `got ${JSON.stringify(events.map((e) => e.type))}`);
    assert.equal(hot.key, "file:hot.ts");
    assert.equal(hot.actor, "ai:b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("my own op on a tracked key is not a foreign-op alert", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await author(repo, "hot.ts", "mine\n", ai);
    const w = new RepoWatcher(repo, { selfActor: "ai:a" });
    w.trackKeys(["file:hot.ts"]);
    await w.poll();
    await author(repo, "hot.ts", "mine again\n", ai);
    const events = await w.poll();
    assert.ok(!events.some((e) => e.type === "foreign-op-hot-key"), `got ${JSON.stringify(events)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an opened conflict is reported", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const intent = await repo.createIntent({ title: "c", owner: "human:h" });
    const s1 = await repo.startSession({ intentOid: intent, actor: ai });
    await repo.proposeFileWrite({ sessionOid: s1, intentOid: intent, actor: ai, path: "c.ts", content: "a\n", declaredPurpose: "p" });
    const w = new RepoWatcher(repo);
    await w.poll();
    const s2 = await repo.startSession({ intentOid: intent, actor: bob });
    await repo.proposeFileWrite({ sessionOid: s2, intentOid: intent, actor: bob, path: "c.ts", content: "b\n", declaredPurpose: "p" });
    const events = await w.poll();
    assert.ok(events.some((e) => e.type === "conflict-opened"), `got ${JSON.stringify(events.map((e) => e.type))}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("polling a repo that vanished degrades to no events instead of throwing", async () => {
  const { repo, dir } = await tmpRepo();
  const w = new RepoWatcher(repo);
  await w.poll();
  await rm(dir, { recursive: true, force: true });
  // A watcher is background machinery; it must never take the server down with it.
  assert.deepEqual(await w.poll(), []);
});
