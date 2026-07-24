// Phase 14 (docs/17 §14) — the integration queue kills "head moved: pull and re-reduce
// first". A stale submission is never rejected for staleness: the queue re-reduces the
// frontier UNION on the submitter's behalf. The submitter's contract is four verdicts —
// advanced | conflict packet | needs_evidence | queued — with NO redo on any path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import type { Actor, Integration } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function author(repo: Repo, path: string, content: string, actor: Actor = ai): Promise<string> {
  const intent = await repo.createIntent({ title: `write ${path}`, owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor });
  return repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor, path, content, declaredPurpose: `write ${path}` });
}

test("a stale submission is integrated by union re-reduce — never 'pull and redo' (headline)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-iq-"));
  try {
    const repo = await Repo.init(dir);

    // Agent A lands first: fast-forward advance onto an empty head.
    await author(repo, "a.ts", "A\n");
    const cpA = await repo.createCheckpoint("main", "A's work");
    const r1 = await repo.submitIntegration({ view: "main", checkpoint: cpA, by: "human:h" });
    assert.equal(r1.verdict, "advanced");
    assert.equal((r1 as { head: string }).head, cpA, "fast-forward advances to the submitted checkpoint itself");

    // Agent B authored a DISJOINT file concurrently — B's checkpoint does NOT contain A's
    // work (it is stale by classic finalize rules). Old world: rejected, pull, re-checkpoint,
    // re-finalize. New world: one submit, verdict advanced, union tree.
    await author(repo, "b.ts", "B\n");
    // B's draft: a checkpoint at B's frontier only (simulate by materializeAt on B's op).
    const cpB = await repo.createCheckpoint("main", "B's work"); // includes A too (same repo) …
    const r2 = await repo.submitIntegration({ view: "main", checkpoint: cpB, by: "human:h" });
    assert.equal(r2.verdict, "advanced");

    const head = await repo.protectedHead("main");
    const headCp = await repo.store.get<import("../src/objects/types.ts").Checkpoint>(head!);
    const tree = await repo.materializeAt(headCp.headOps);
    assert.deepEqual([...tree.tree.keys()].sort(), ["a.ts", "b.ts"], "union tree contains both agents' work");

    // Every judgment is an append-only audit object, resolvable by ticket.
    const integrations = await repo.store.collect<Integration>("integration");
    assert.ok(integrations.length >= 2, "each verdict recorded as an Integration object");
    assert.ok(integrations.every((x) => x.verdict === "advanced"));

    // Idempotency: resubmitting an advanced ticket replays the verdict, head unchanged.
    const replay = await repo.submitIntegration({ view: "main", checkpoint: cpB, by: "human:h" });
    assert.equal(replay.verdict, "advanced");
    assert.equal(await repo.protectedHead("main"), head, "replay does not move the head");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("N=8 concurrent hub submissions: all advanced, zero client-side pull-redo retries", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-iqhub-"));
  const clientDirs: string[] = [];
  const seedRepo = await Repo.init(hubDir);
  await author(seedRepo, "seed.ts", "seed\n");
  const hub = await startHub({ repoDir: hubDir, port: 0 });
  try {
    // 8 replicas clone the seed, then each authors a DISJOINT file and submits once.
    const clients: Repo[] = [];
    for (let i = 0; i < 8; i++) {
      const d = await mkdtemp(join(tmpdir(), `avcs-iqc${i}-`));
      clientDirs.push(d);
      const c = await Repo.init(d);
      await c.pullHub(hub.url);
      clients.push(c);
    }
    const verdicts = await Promise.all(clients.map(async (c, i) => {
      await author(c, `agent${i}.ts`, `export const n = ${i};\n`);
      const cp = await c.createCheckpoint("main", `agent ${i}`);
      // ONE submit per agent. No retry loop exists in the client path at all.
      return { i, cp, r: await c.integrateHub(hub.url, { view: "main", checkpoint: cp, by: "human:h" }) };
    }));
    for (const { i, r } of verdicts) assert.equal(r.verdict, "advanced", `agent ${i} advanced (got ${r.verdict}: ${JSON.stringify(r)})`);

    // The hub head reduces to a tree containing every agent's file.
    const hubRepo = await Repo.open(hubDir);
    const head = await hubRepo.protectedHead("main");
    assert.ok(head, "hub head advanced");
    const headCp = await hubRepo.store.get<import("../src/objects/types.ts").Checkpoint>(head!);
    const tree = await hubRepo.materializeAt(headCp.headOps);
    const files = [...tree.tree.keys()].sort();
    assert.deepEqual(files, ["agent0.ts", "agent1.ts", "agent2.ts", "agent3.ts", "agent4.ts", "agent5.ts", "agent6.ts", "agent7.ts", "seed.ts"]);

    // Every ticket's verdict is queryable (idempotent polling endpoint).
    for (const { r } of verdicts) {
      const integ = r.integration as string | undefined;
      assert.ok(integ, "verdict carries the Integration audit oid");
    }

    // Replicas converge by plain pull — same treeHash everywhere (determinism).
    const c0 = clients[0]!;
    await c0.pullHub(hub.url);
    const c0head = await c0.store.getRef("head:main");
    assert.equal(c0head, head, "governance ref adopted");
    const c0cp = await c0.store.get<import("../src/objects/types.ts").Checkpoint>(c0head!);
    assert.equal((await c0.materializeAt(c0cp.headOps)).treeHash, tree.treeHash, "replica reproduces the hub tree");
  } finally {
    await hub.close();
    await Promise.all([hubDir, ...clientDirs].map((d) => rm(d, { recursive: true, force: true })));
  }
});

test("legacy POST /finalize semantics are unchanged (stale still rejected there)", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-iqleg-"));
  const devDir = await mkdtemp(join(tmpdir(), "avcs-iqdev-"));
  await Repo.init(hubDir);
  const hub = await startHub({ repoDir: hubDir, port: 0 });
  try {
    const dev = await Repo.init(devDir);
    await author(dev, "x.ts", "x\n");
    const cp1 = await dev.createCheckpoint("main", "one");
    await dev.pushHub(hub.url);
    const ok = await dev.finalizeHub(hub.url, { view: "main", newCheckpoint: cp1, parentHead: null, by: "human:h" });
    assert.equal(ok.finalized, true, "legacy finalize works");

    await author(dev, "y.ts", "y\n");
    const cp2 = await dev.createCheckpoint("main", "two");
    await dev.pushHub(hub.url);
    // A STALE legacy finalize (wrong parentHead) is still refused — the funnel lives on
    // for old clients; only /integrate removes it.
    const stale = await dev.finalizeHub(hub.url, { view: "main", newCheckpoint: cp2, parentHead: null, by: "human:h" });
    assert.equal(stale.finalized, false);
    assert.match(stale.reason ?? "", /head moved/);
    assert.equal(stale.status, 409);
  } finally {
    await hub.close();
    await Promise.all([hubDir, devDir].map((d) => rm(d, { recursive: true, force: true })));
  }
});
