// Track E / E5 — since-cursor incremental sync. `GET /have` returns the whole oid set
// every sync (O(total history)); `GET /sync?since=N` returns only objects appended since
// the client's last cursor. The client persists a per-hub cursor and falls back to /have
// against an older hub, so correctness never depends on the cursor — it's a transfer
// optimization. These tests assert: convergence on both the full and the delta path, the
// delta is strictly smaller, and the cursor advances.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function getJson(url: string): Promise<any> {
  return (await fetch(url)).json();
}

test("E5: GET /sync?since returns only the delta and a stable cursor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-e5sync-"));
  const central = await Repo.init(dir);
  const intent = await central.createIntent({ title: "t", owner: "human:h" });
  const sess = await central.startSession({ intentOid: intent, actor: ai });
  await central.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "1\n", declaredPurpose: "a" });
  const hub = await startHub({ repoDir: dir, port: 0 });
  try {
    const full = await getJson(`${hub.url}/sync?since=0`);
    assert.ok(full.cursor >= 3, `cursor counts all objects, got ${full.cursor}`);
    assert.equal(full.oids.length, full.cursor, "since=0 returns the full set");

    // nothing new since the latest cursor → empty delta, same cursor.
    const empty = await getJson(`${hub.url}/sync?since=${full.cursor}`);
    assert.equal(empty.oids.length, 0, "no new objects → empty delta");
    assert.equal(empty.cursor, full.cursor, "cursor unchanged");

    // author more → the delta from the old cursor is exactly the new objects.
    await central.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "b.ts", content: "2\n", declaredPurpose: "b" });
    const delta = await getJson(`${hub.url}/sync?since=${full.cursor}`);
    assert.ok(delta.oids.length >= 1 && delta.oids.length < delta.cursor, "delta is only the new objects, smaller than full");
    assert.ok(delta.cursor > full.cursor, "cursor advanced");
  } finally {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("E5: incremental pull converges and pulls only the delta on the second sync", async () => {
  const centralDir = await mkdtemp(join(tmpdir(), "avcs-e5c-"));
  const userDir = await mkdtemp(join(tmpdir(), "avcs-e5u-"));
  const central = await Repo.init(centralDir);
  const intent = await central.createIntent({ title: "t", owner: "human:h" });
  const sess = await central.startSession({ intentOid: intent, actor: ai });
  for (let i = 0; i < 4; i++)
    await central.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: `f${i}.ts`, content: `${i}\n`, declaredPurpose: `f${i}` });
  const hub = await startHub({ repoDir: centralDir, port: 0 });
  try {
    const user = await Repo.init(userDir);
    // first pull: full.
    const r1 = await user.pullHub(hub.url);
    assert.ok(r1.pulled >= 8, `first pull is full, got ${r1.pulled}`);
    assert.equal((await user.materialize()).treeHash, (await central.materialize()).treeHash, "converges after full pull");

    // cursor persisted.
    const cursPath = join(userDir, ".avcs", "sync-cursors.json");
    assert.ok(existsSync(cursPath), "cursor file written");
    const c1 = JSON.parse(await readFile(cursPath, "utf8"))[hub.url] as number;
    assert.ok(c1 > 0, "cursor advanced past 0");

    // a second pull with nothing new pulls nothing.
    assert.equal((await user.pullHub(hub.url)).pulled, 0, "no-op pull when nothing new");

    // central authors one more file; the user's next pull fetches ONLY the delta.
    await central.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "new.ts", content: "x\n", declaredPurpose: "new" });
    const r2 = await user.pullHub(hub.url);
    assert.ok(r2.pulled >= 1 && r2.pulled < r1.pulled, `second pull is the small delta, got ${r2.pulled}`);
    assert.equal((await user.materialize()).treeHash, (await central.materialize()).treeHash, "converges after incremental pull");

    const c2 = JSON.parse(await readFile(cursPath, "utf8"))[hub.url] as number;
    assert.ok(c2 > c1, "cursor advanced on the incremental pull");
  } finally {
    await hub.close();
    await rm(centralDir, { recursive: true, force: true });
    await rm(userDir, { recursive: true, force: true });
  }
});
