// M2 / docs/10 WS-B: object-gossip over the NETWORK (HTTP hub).
//
// Mirrors phase7-governance-sync.test.ts "object-gossip sync converges" but the
// transport is HTTP instead of a local dir. Two repos do disjoint work, push to a
// hub (a third empty repo), then pull back — both must converge to the same tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { pushToHub, pullFromHub } from "../src/hub/hubClient.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };

test("HTTP object-gossip via a hub converges two replicas to the same tree", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "avcs-A-"));
  const dirB = await mkdtemp(join(tmpdir(), "avcs-B-"));
  const dirHub = await mkdtemp(join(tmpdir(), "avcs-hub-"));
  const A = await Repo.init(dirA);
  const B = await Repo.init(dirB);

  // Disjoint work on each replica.
  const iA = await A.createIntent({ title: "t", owner: human.id });
  const sA = await A.startSession({ intentOid: iA, actor: ai });
  await A.proposeFileWrite({ sessionOid: sA, intentOid: iA, actor: ai, path: "a.ts", content: "A\n", declaredPurpose: "a" });

  const iB = await B.createIntent({ title: "t", owner: human.id });
  const sB = await B.startSession({ intentOid: iB, actor: ai });
  await B.proposeFileWrite({ sessionOid: sB, intentOid: iB, actor: ai, path: "b.ts", content: "B\n", declaredPurpose: "b" });

  // Hub over a third, empty repo dir on an OS-assigned port (port 0).
  const hub = await startHub({ repoDir: dirHub, port: 0 });
  try {
    assert.ok(hub.port > 0, "hub bound a real port");

    // Push from both replicas, then pull into both.
    const pa = await pushToHub(dirA, hub.url);
    const pb = await pushToHub(dirB, hub.url);
    assert.ok(pa.pushed > 0 && pb.pushed > 0, "both replicas pushed objects");

    const qa = await pullFromHub(dirA, hub.url);
    const qb = await pullFromHub(dirB, hub.url);
    // Each pulls at least the objects authored only on the other replica.
    assert.ok(qa.pulled > 0, "A pulled B's objects");
    assert.ok(qb.pulled > 0, "B pulled A's objects");

    const ra = await A.materialize();
    const rb = await B.materialize();
    assert.equal(ra.treeHash, rb.treeHash, "replicas converge over HTTP — no conflict step");
    assert.deepEqual([...ra.tree.keys()].sort(), ["a.ts", "b.ts"]);

    // Entity index was maintained on pull, so cross-replica blame works.
    assert.equal((await A.historyOf("file:b.ts")).length, 1);
    assert.equal((await B.historyOf("file:a.ts")).length, 1);

    // Idempotent: a second push transfers nothing new.
    const again = await pushToHub(dirA, hub.url);
    assert.equal(again.pushed, 0, "second push is a no-op (content-addressed union)");
  } finally {
    await hub.close();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
    await rm(dirHub, { recursive: true, force: true });
  }
});
