// Phase 13.1 (docs/17 §13.1) — persisted remotes: named hub URLs in .avcs/remotes.json
// (aux file, per-replica config, never gossiped) + `repo.sync(remote)` = pull + push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

test("addRemote/listRemotes/removeRemote persist across Repo.open (.avcs/remotes.json)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-remote-"));
  try {
    const repo = await Repo.init(dir);
    await repo.addRemote("origin", "http://hub.example:8080/", { autoSync: true, freshnessMs: 5000 });
    await repo.addRemote("mirror", "http://mirror.example");

    // trailing slash is normalized; options round-trip
    let remotes = await repo.listRemotes();
    assert.equal(remotes["origin"]!.url, "http://hub.example:8080");
    assert.equal(remotes["origin"]!.autoSync, true);
    assert.equal(remotes["origin"]!.freshnessMs, 5000);
    assert.equal(remotes["mirror"]!.url, "http://mirror.example");
    assert.equal(remotes["mirror"]!.autoSync, undefined, "unset options are not stored");

    // persisted as an aux file, visible to a FRESH handle on the same dir
    assert.ok(existsSync(join(dir, ".avcs", "remotes.json")), "remotes live in .avcs/remotes.json");
    const reopened = await Repo.open(dir);
    remotes = await reopened.listRemotes();
    assert.deepEqual(Object.keys(remotes).sort(), ["mirror", "origin"], "remotes survive a reopen");

    // removal
    assert.equal(await reopened.removeRemote("mirror"), true);
    assert.equal(await reopened.removeRemote("mirror"), false, "removing twice reports absence");
    assert.deepEqual(Object.keys(await reopened.listRemotes()), ["origin"]);

    // a non-http url is refused (remotes are hub URLs, not paths)
    await assert.rejects(() => repo.addRemote("bad", "/some/dir"), /http/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sync(remote) = pull + push against the named hub; unknown remote is a clear error", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "avcs-A-"));
  const dirB = await mkdtemp(join(tmpdir(), "avcs-B-"));
  const dirHub = await mkdtemp(join(tmpdir(), "avcs-hub-"));
  const A = await Repo.init(dirA);
  const B = await Repo.init(dirB);
  await Repo.init(dirHub);
  const hub = await startHub({ repoDir: dirHub, port: 0 });
  try {
    // disjoint work on each replica
    const iA = await A.createIntent({ title: "t", owner: "human:h" });
    const sA = await A.startSession({ intentOid: iA, actor: ai });
    await A.proposeFileWrite({ sessionOid: sA, intentOid: iA, actor: ai, path: "a.ts", content: "A\n", declaredPurpose: "a" });
    const iB = await B.createIntent({ title: "t", owner: "human:h" });
    const sB = await B.startSession({ intentOid: iB, actor: ai });
    await B.proposeFileWrite({ sessionOid: sB, intentOid: iB, actor: ai, path: "b.ts", content: "B\n", declaredPurpose: "b" });

    // default remote name is "origin"; no URL appears at the call site
    await A.addRemote("origin", hub.url);
    await B.addRemote("origin", hub.url);

    const r1 = await A.sync();
    assert.ok(r1.pushed > 0, "A pushed its work");
    const r2 = await B.sync();
    assert.ok(r2.pulled > 0 && r2.pushed > 0, "B pulled A's work and pushed its own");
    const r3 = await A.sync();
    assert.ok(r3.pulled > 0, "A pulled B's work on the second sync");

    assert.equal((await A.materialize()).treeHash, (await B.materialize()).treeHash, "replicas converge via named-remote sync");

    await assert.rejects(() => A.sync("nope"), /unknown remote: nope/);
  } finally {
    await hub.close();
    await Promise.all([dirA, dirB, dirHub].map((d) => rm(d, { recursive: true, force: true })));
  }
});
