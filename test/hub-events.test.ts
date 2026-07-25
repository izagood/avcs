// Phase 15.1 (docs/17 §15.1) — GET /events long-poll: the hub's live-convergence feed.
// One cursor meaning (the objlog index shared with /sync), refs on every response (a
// finalize can move head:<view> without appending any object), heartbeat on timeout,
// and a bounded waiter set. Long-poll, not SSE, deliberately: zero-dep + proxy-friendly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { finalizeOnHub } from "../src/hub/hubClient.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

interface EventsPayload {
  cursor: number;
  oids: string[];
  refs: Record<string, string>;
}

async function author(repo: Repo, path: string, content: string, actor: Actor = ai): Promise<string> {
  const intent = await repo.createIntent({ title: `write ${path}`, owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor });
  return repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor, path, content, declaredPurpose: `write ${path}` });
}

async function hubCursor(base: string): Promise<number> {
  const j = (await (await fetch(`${base}/sync?since=0`)).json()) as { cursor: number };
  return j.cursor;
}

test("a mutation wakes a parked waiter with the new oids + the governance refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-ev-"));
  try {
    const hub = await startHub({ repoDir: dir });
    try {
      // The hub is empty and the cursor current → the poll parks instead of answering.
      const waiter = fetch(`${hub.url}/events?since=0&timeoutMs=10000`);
      await new Promise((r) => setTimeout(r, 100)); // let it park

      const body = JSON.stringify({ type: "intent", title: "wake the waiter", owner: "human:h", createdAt: new Date().toISOString() });
      const put = await fetch(`${hub.url}/objects`, { method: "POST", headers: { "content-type": "application/json" }, body });
      assert.equal(put.status, 200);
      const { oid } = (await put.json()) as { oid: string };

      const res = await waiter;
      assert.equal(res.status, 200);
      const j = (await res.json()) as EventsPayload;
      assert.ok(j.oids.includes(oid), "the woken response carries the oid that woke it");
      assert.ok(j.cursor >= 1, "cursor advanced past the append");
      assert.equal(typeof j.refs, "object");

      // /events and /sync share ONE cursor meaning: resuming /sync from the events
      // cursor reports nothing new.
      const sync = (await (await fetch(`${hub.url}/sync?since=${j.cursor}`)).json()) as { oids: string[] };
      assert.deepEqual(sync.oids, []);
    } finally {
      await hub.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a caught-up waiter times out into a heartbeat: empty oids, same cursor, refs attached", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-ev-"));
  try {
    const hub = await startHub({ repoDir: dir });
    try {
      const before = await hubCursor(hub.url);
      const t0 = Date.now();
      const res = await fetch(`${hub.url}/events?since=${before}&timeoutMs=200`);
      const elapsed = Date.now() - t0;
      assert.equal(res.status, 200);
      const j = (await res.json()) as EventsPayload;
      assert.deepEqual(j.oids, [], "heartbeat carries no oids");
      assert.equal(j.cursor, before, "cursor unchanged on a quiet hub");
      assert.equal(typeof j.refs, "object");
      assert.ok(elapsed >= 150, `parked for the timeout window (waited ${elapsed}ms)`);
    } finally {
      await hub.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a ref-only mutation (finalize) is visible to a parked waiter via refs — no new object needed", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-ev-"));
  const clientDir = await mkdtemp(join(tmpdir(), "avcs-ev-cl-"));
  try {
    const hub = await startHub({ repoDir: hubDir });
    try {
      // The checkpoint and all its history reach the hub FIRST (object gossip)…
      const repo = await Repo.init(clientDir);
      await author(repo, "a.ts", "A\n");
      const cp = await repo.createCheckpoint("main", "A's work");
      await repo.pushHub(hub.url);

      // …so the finalize that follows moves head:main WITHOUT appending any object.
      const since = await hubCursor(hub.url);
      const waiter = fetch(`${hub.url}/events?since=${since}&timeoutMs=10000`);
      await new Promise((r) => setTimeout(r, 100)); // let it park

      const fin = await finalizeOnHub(hub.url, { view: "main", newCheckpoint: cp, parentHead: null, by: "human:h" });
      assert.equal(fin.finalized, true);

      const res = await waiter;
      assert.equal(res.status, 200);
      const j = (await res.json()) as EventsPayload;
      assert.equal(j.refs["head:main"], cp, "the head advance rides the refs map");
      assert.deepEqual(j.oids, [], "no object was appended by the finalize");
    } finally {
      await hub.close();
    }
  } finally {
    await rm(hubDir, { recursive: true, force: true });
    await rm(clientDir, { recursive: true, force: true });
  }
});

test("the waiter cap bounds parked pollers: excess polls get an immediate 503", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-ev-"));
  try {
    const hub = await startHub({ repoDir: dir, events: { maxWaiters: 2 } });
    try {
      const w1 = fetch(`${hub.url}/events?since=0&timeoutMs=1500`);
      const w2 = fetch(`${hub.url}/events?since=0&timeoutMs=1500`);
      await new Promise((r) => setTimeout(r, 100)); // let both park

      const t0 = Date.now();
      const res = await fetch(`${hub.url}/events?since=0&timeoutMs=1500`);
      assert.equal(res.status, 503, "the third poller is rejected, not parked");
      assert.ok(Date.now() - t0 < 1000, "the rejection is immediate, not a parked timeout");
      await res.json();

      // The parked two still complete normally (heartbeat) — the cap never breaks them.
      for (const w of [w1, w2]) {
        const r = await w;
        assert.equal(r.status, 200);
        await r.json();
      }
    } finally {
      await hub.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
