// Phase 15.2 (docs/17 §15.2) — the live-convergence daemon + the freshness window.
// `sync --watch` = long-poll /events → incremental pull → refs adoption → contention
// early warning, single instance per repo via the heartbeat-kept "syncd" lock. The
// materialize freshness hook is stale-while-revalidate: the read path NEVER blocks on
// the network — a lapsed window fires a background sync and the read returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { runSyncWatch, type SyncWatchEvent } from "../src/hub/syncWatch.ts";
import type { Actor } from "../src/objects/types.ts";
// A wall-clock budget cannot tell a false condition from a starved event loop (issue #55).
import { until } from "./helpers/until.ts";

const aliceActor: Actor = { kind: "ai_agent", id: "ai:alice" };
const bobActor: Actor = { kind: "ai_agent", id: "ai:bob" };

async function author(repo: Repo, path: string, content: string, actor: Actor): Promise<string> {
  const intent = await repo.createIntent({ title: `write ${path}`, owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor });
  return repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor, path, content, declaredPurpose: `write ${path}` });
}



test("watch converges live: another replica's push arrives with no manual pull, and its op on a locally-worked key raises a contention alert", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-w-hub-"));
  const aliceDir = await mkdtemp(join(tmpdir(), "avcs-w-a-"));
  const bobDir = await mkdtemp(join(tmpdir(), "avcs-w-b-"));
  const ac = new AbortController();
  let watcher: Promise<void> | null = null;
  try {
    const hub = await startHub({ repoDir: hubDir });
    try {
      const alice = await Repo.init(aliceDir);
      await alice.addRemote("origin", hub.url);
      // Alice has live local work on shared.ts — the key Bob is about to land on.
      await author(alice, "shared.ts", "alice's version\n", aliceActor);

      const events: SyncWatchEvent[] = [];
      watcher = runSyncWatch(alice, { remote: "origin", timeoutMs: 2_000, signal: ac.signal, onEvent: (ev) => events.push(ev) });
      await until(async () => events.some((e) => e.type === "synced"), { timeoutMs: 8_000, label: "initial sync" });

      // Bob pushes concurrent (causally independent) work on the SAME key.
      const bob = await Repo.init(bobDir);
      const bobOp = await author(bob, "shared.ts", "bob's version\n", bobActor);
      await bob.pushHub(hub.url);

      // Alice's daemon pulls it — no manual `avcs pull` anywhere.
      await until(() => alice.store.has(bobOp), { timeoutMs: 8_000, label: "bob's op to arrive at alice" });

      // …and announces the overlap at ARRIVAL time, not at finalize.
      await until(async () => events.some((e) => e.type === "contention" && e.key === "file:shared.ts" && e.incomingActor === "ai:bob"), { timeoutMs: 8_000, label: "contention alert for the incoming op" });
      const alert = events.find((e) => e.type === "contention")!;
      assert.equal(alert.type, "contention");
      if (alert.type === "contention") {
        assert.equal(alert.incomingOp, bobOp);
        assert.ok(alert.localOps.some((o) => o.actor === "ai:alice"), "the alert names the local work it collides with");
      }
    } finally {
      ac.abort();
      if (watcher) await watcher;
      await hub.close();
    }
  } finally {
    await rm(hubDir, { recursive: true, force: true });
    await rm(aliceDir, { recursive: true, force: true });
    await rm(bobDir, { recursive: true, force: true });
  }
});

test("one watcher per repo: a second runSyncWatch on the same store is refused", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-w-hub-"));
  const dir = await mkdtemp(join(tmpdir(), "avcs-w-one-"));
  const ac = new AbortController();
  let watcher: Promise<void> | null = null;
  try {
    const hub = await startHub({ repoDir: hubDir });
    try {
      const repo = await Repo.init(dir);
      await repo.addRemote("origin", hub.url);
      const events: SyncWatchEvent[] = [];
      watcher = runSyncWatch(repo, { remote: "origin", timeoutMs: 2_000, signal: ac.signal, onEvent: (ev) => events.push(ev) });
      await until(async () => events.some((e) => e.type === "started"), { timeoutMs: 8_000, label: "first watcher start" });

      await assert.rejects(
        () => runSyncWatch(repo, { remote: "origin", timeoutMs: 500 }),
        /already running/,
        "the second instance is refused while the first holds the syncd lock",
      );
    } finally {
      ac.abort();
      if (watcher) await watcher;
      await hub.close();
    }
  } finally {
    await rm(hubDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("a watch daemon sees a head advance made on the hub (refs ride the event feed)", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-w-hub-"));
  const aliceDir = await mkdtemp(join(tmpdir(), "avcs-w-a-"));
  const bobDir = await mkdtemp(join(tmpdir(), "avcs-w-b-"));
  const ac = new AbortController();
  let watcher: Promise<void> | null = null;
  try {
    const hub = await startHub({ repoDir: hubDir });
    try {
      const alice = await Repo.init(aliceDir);
      await alice.addRemote("origin", hub.url);
      const events: SyncWatchEvent[] = [];
      watcher = runSyncWatch(alice, { remote: "origin", timeoutMs: 2_000, signal: ac.signal, onEvent: (ev) => events.push(ev) });
      await until(async () => events.some((e) => e.type === "synced"), { timeoutMs: 8_000, label: "initial sync" });

      // Bob lands work through the integration queue — the hub advances head:main.
      const bob = await Repo.init(bobDir);
      await author(bob, "landed.ts", "bob lands this\n", bobActor);
      const cp = await bob.createCheckpoint("main", "bob's landing");
      const r = await bob.integrateHub(hub.url, { view: "main", checkpoint: cp, by: "human:h" });
      assert.equal(r.verdict, "advanced");

      // The daemon adopts the hub's head ref and reports the advance.
      await until(async () => (await alice.protectedHead("main")) !== null, { timeoutMs: 8_000, label: "head adoption at alice" });
      await until(async () => events.some((e) => e.type === "head" && e.view === "main"), { timeoutMs: 8_000, label: "head event" });
    } finally {
      ac.abort();
      if (watcher) await watcher;
      await hub.close();
    }
  } finally {
    await rm(hubDir, { recursive: true, force: true });
    await rm(aliceDir, { recursive: true, force: true });
    await rm(bobDir, { recursive: true, force: true });
  }
});

test("stale-while-revalidate: materialize never blocks on the network, even with a dead autoSync remote", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-w-swr-"));
  try {
    const repo = await Repo.init(dir);
    // A dead hub with a 1ms freshness window: every materialize is "stale".
    await repo.addRemote("origin", "http://127.0.0.1:9", { autoSync: true, freshnessMs: 1 });
    await author(repo, "x.ts", "x\n", aliceActor);
    const t0 = Date.now();
    const res = await repo.materialize("main");
    const elapsed = Date.now() - t0;
    assert.ok(res.tree.has("x.ts"), "the read itself succeeds");
    assert.ok(elapsed < 1_500, `read path did not wait on the dead remote (took ${elapsed}ms)`);
    await repo.settleBackgroundSync(); // don't leave the failing revalidate running into teardown
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale-while-revalidate: a lapsed window fires a BACKGROUND sync that actually converges", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-w-hub-"));
  const aliceDir = await mkdtemp(join(tmpdir(), "avcs-w-a-"));
  const bobDir = await mkdtemp(join(tmpdir(), "avcs-w-b-"));
  try {
    const hub = await startHub({ repoDir: hubDir });
    try {
      const bob = await Repo.init(bobDir);
      const bobOp = await author(bob, "fresh.ts", "from bob\n", bobActor);
      await bob.pushHub(hub.url);

      const alice = await Repo.init(aliceDir);
      await alice.addRemote("origin", hub.url, { autoSync: true, freshnessMs: 1 });
      // A materialize on the stale window fires the background revalidate…
      await alice.materialize("main");
      // …which converges shortly after, without any blocking pull in the read path.
      await until(() => alice.store.has(bobOp), { timeoutMs: 8_000, label: "background revalidate to pull bob's op" });
      // The op arriving is a MID-run effect (pull), not the end of the run — push and the
      // last-sync stamp write still follow. Quiesce before the teardown below removes the
      // dir, or the rmdir races an in-flight `.avcs` write (ENOTEMPTY).
      await alice.settleBackgroundSync();
    } finally {
      await hub.close();
    }
  } finally {
    await rm(hubDir, { recursive: true, force: true });
    await rm(aliceDir, { recursive: true, force: true });
    await rm(bobDir, { recursive: true, force: true });
  }
});

test("the background revalidate is awaitable: settleBackgroundSync resolves only after it has fully finished writing", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-w-hub-"));
  const aliceDir = await mkdtemp(join(tmpdir(), "avcs-w-set-"));
  const bobDir = await mkdtemp(join(tmpdir(), "avcs-w-b-"));
  try {
    const hub = await startHub({ repoDir: hubDir });
    try {
      const bob = await Repo.init(bobDir);
      const bobOp = await author(bob, "fresh.ts", "from bob\n", bobActor);
      await bob.pushHub(hub.url);

      const alice = await Repo.init(aliceDir);
      await alice.addRemote("origin", hub.url, { autoSync: true, freshnessMs: 1 });
      await alice.materialize("main"); // fires the background revalidate

      // Waiting on an OBSERVABLE EFFECT (the op arriving) is not enough: pull lands the
      // op, but push + the last-sync stamp write still follow. Anything that then tears
      // the repo dir down — a test, a daemon shutdown — races those writes. settle is
      // the daemon-style handle (cf. runSyncWatch's returned promise) that closes it.
      await alice.settleBackgroundSync();

      assert.ok(await alice.store.has(bobOp), "the revalidate converged");
      assert.ok(
        (await alice.syncAgeMs("origin")) < 60_000,
        "the sync stamp was written BEFORE settle returned — no writes remain in flight",
      );
      // With nothing in flight the teardown below cannot lose a rmdir race.
    } finally {
      await hub.close();
    }
  } finally {
    await rm(hubDir, { recursive: true, force: true });
    await rm(aliceDir, { recursive: true, force: true });
    await rm(bobDir, { recursive: true, force: true });
  }
});

test("settleBackgroundSync is a no-op when nothing is in flight", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-w-noop-"));
  try {
    const repo = await Repo.init(dir); // no remotes at all
    await repo.materialize("main");
    await repo.settleBackgroundSync(); // must resolve, not hang
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("syncIfStale blocks only when stale: it syncs a lapsed remote and skips a fresh one", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-w-hub-"));
  const dir = await mkdtemp(join(tmpdir(), "avcs-w-sis-"));
  try {
    const hub = await startHub({ repoDir: hubDir });
    try {
      const repo = await Repo.init(dir);
      await repo.addRemote("origin", hub.url, { autoSync: true, freshnessMs: 60_000 });
      assert.equal(await repo.syncAgeMs("origin"), Infinity, "never synced yet");

      const first = await repo.syncIfStale();
      assert.deepEqual(first.synced, ["origin"], "a never-synced remote is stale by definition");
      assert.ok((await repo.syncAgeMs("origin")) < 60_000);

      const second = await repo.syncIfStale();
      assert.deepEqual(second.synced, [], "inside the freshness window nothing happens");
    } finally {
      await hub.close();
    }
  } finally {
    await rm(hubDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
