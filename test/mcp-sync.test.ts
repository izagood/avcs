// Phase 16 M2 (docs/18 §M2) — sync as a first-class MCP surface.
//
// The point of M2 is principle 3: "an agent does not know git's pain". Landing work is one
// call whose result is either `landed` or a conflict packet a human must decide. The string
// "head moved" must never reach the agent — the hub's integration queue re-reduces, and the
// bounded client loop is the fallback for a local/old hub. Both paths expose the SAME
// contract, so what the agent believes does not depend on which one ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { TOOLS, runTool } from "../src/mcp/server.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const bob: Actor = { kind: "ai_agent", id: "ai:b" };

function tool(name: string) {
  const t = TOOLS.find((t) => t.name === name);
  assert.ok(t, `tool ${name} is registered`);
  return t!;
}

async function call(name: string, repo: Repo, args: Record<string, unknown> = {}): Promise<any> {
  const res = await runTool(tool(name), repo, args);
  assert.notEqual(res.isError, true, `${name} failed: ${res.content[0]!.text}`);
  return JSON.parse(res.content[0]!.text);
}

async function author(repo: Repo, path: string, content: string, actor: Actor): Promise<string> {
  const intent = await repo.createIntent({ title: `write ${path}`, owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor });
  return repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor, path, content, declaredPurpose: `write ${path}` });
}

// ── M2.1 pull / push ────────────────────────────────────────────────────────

test("sync.pull reports what arrived and how the local head compares to the hub's", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-m2-hub-"));
  const aDir = await mkdtemp(join(tmpdir(), "avcs-m2-a-"));
  const bDir = await mkdtemp(join(tmpdir(), "avcs-m2-b-"));
  try {
    const hub = await startHub({ repoDir: hubDir });
    try {
      const b = await Repo.init(bDir);
      const bobOp = await author(b, "b.ts", "from bob\n", bob);
      await b.pushHub(hub.url);

      const a = await Repo.init(aDir);
      await a.addRemote("origin", hub.url);
      const res = await call("avcs.sync.pull", a, {});
      assert.ok(res.pulled > 0, "objects arrived");
      assert.ok(await a.store.has(bobOp), "bob's op is local now");
      assert.ok("local" in res.head && "hub" in res.head, `head comparison reported, got ${JSON.stringify(res)}`);
      assert.equal(typeof res.converged, "boolean");
    } finally {
      await hub.close();
    }
  } finally {
    for (const d of [hubDir, aDir, bDir]) await rm(d, { recursive: true, force: true });
  }
});

test("sync.pull dryRun reports what WOULD arrive without importing anything", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-m2-hub-"));
  const aDir = await mkdtemp(join(tmpdir(), "avcs-m2-a-"));
  const bDir = await mkdtemp(join(tmpdir(), "avcs-m2-b-"));
  try {
    const hub = await startHub({ repoDir: hubDir });
    try {
      const b = await Repo.init(bDir);
      const bobOp = await author(b, "b.ts", "from bob\n", bob);
      await b.pushHub(hub.url);

      const a = await Repo.init(aDir);
      await a.addRemote("origin", hub.url);
      const res = await call("avcs.sync.pull", a, { dryRun: true });
      assert.ok(res.pulled > 0, "reports a non-zero would-pull count");
      assert.equal(await a.store.has(bobOp), false, "dryRun imported nothing");
    } finally {
      await hub.close();
    }
  } finally {
    for (const d of [hubDir, aDir, bDir]) await rm(d, { recursive: true, force: true });
  }
});

test("sync.push reports what the hub accepted", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-m2-hub-"));
  const aDir = await mkdtemp(join(tmpdir(), "avcs-m2-a-"));
  try {
    const hub = await startHub({ repoDir: hubDir });
    try {
      const a = await Repo.init(aDir);
      await a.addRemote("origin", hub.url);
      await author(a, "a.ts", "mine\n", ai);
      const res = await call("avcs.sync.push", a, {});
      assert.ok(res.pushed > 0, `pushed count reported, got ${JSON.stringify(res)}`);
      assert.equal(res.rejected, 0);
    } finally {
      await hub.close();
    }
  } finally {
    for (const d of [hubDir, aDir]) await rm(d, { recursive: true, force: true });
  }
});

// ── M2.2 land — the flagship ────────────────────────────────────────────────

test("sync.land takes work all the way to the protected head in one call", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-m2-hub-"));
  const aDir = await mkdtemp(join(tmpdir(), "avcs-m2-a-"));
  try {
    const hub = await startHub({ repoDir: hubDir });
    try {
      const a = await Repo.init(aDir);
      await a.addRemote("origin", hub.url);
      await author(a, "a.ts", "mine\n", ai);
      const res = await call("avcs.sync.land", a, { by: "human:h", summary: "land it" });
      assert.equal(res.landed, true, `expected a landing, got ${JSON.stringify(res)}`);
      assert.ok(res.head, "the new head is reported");
      assert.ok(res.treeHash, "the landed treeHash is reported");
      assert.ok(res.attempts >= 1);
    } finally {
      await hub.close();
    }
  } finally {
    for (const d of [hubDir, aDir]) await rm(d, { recursive: true, force: true });
  }
});

test("a head that moved under us is absorbed — the agent is never told to pull and redo", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-m2-hub-"));
  const aDir = await mkdtemp(join(tmpdir(), "avcs-m2-a-"));
  const bDir = await mkdtemp(join(tmpdir(), "avcs-m2-b-"));
  try {
    const hub = await startHub({ repoDir: hubDir });
    try {
      // Bob lands first, so the hub's head is ahead of anything Alice knows about.
      const b = await Repo.init(bDir);
      await b.addRemote("origin", hub.url);
      await author(b, "b.ts", "bob\n", bob);
      const first = await call("avcs.sync.land", b, { by: "human:h" });
      assert.equal(first.landed, true);

      // Alice never pulled. Her land must still succeed on disjoint work.
      const a = await Repo.init(aDir);
      await a.addRemote("origin", hub.url);
      await author(a, "a.ts", "alice\n", ai);
      const res = await call("avcs.sync.land", a, { by: "human:h" });
      assert.equal(res.landed, true, `expected absorption, got ${JSON.stringify(res)}`);
      assert.ok(!JSON.stringify(res).includes("head moved"), "the phrase never reaches the agent");
    } finally {
      await hub.close();
    }
  } finally {
    for (const d of [hubDir, aDir, bDir]) await rm(d, { recursive: true, force: true });
  }
});

test("an open conflict stops the loop immediately and returns a decidable packet", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-m2-hub-"));
  const aDir = await mkdtemp(join(tmpdir(), "avcs-m2-a-"));
  try {
    const hub = await startHub({ repoDir: hubDir });
    try {
      const a = await Repo.init(aDir);
      await a.addRemote("origin", hub.url);
      // Two concurrent whole-file writes to one path by different actors: a real conflict.
      const i1 = await a.createIntent({ title: "x", owner: "human:h" });
      const s1 = await a.startSession({ intentOid: i1, actor: ai });
      const s2 = await a.startSession({ intentOid: i1, actor: bob });
      await a.proposeFileWrite({ sessionOid: s1, intentOid: i1, actor: ai, path: "c.ts", content: "alice\n", declaredPurpose: "p" });
      await a.proposeFileWrite({ sessionOid: s2, intentOid: i1, actor: bob, path: "c.ts", content: "bob\n", declaredPurpose: "p" });

      const res = await call("avcs.sync.land", a, { by: "human:h", maxAttempts: 5 });
      assert.equal(res.landed, false);
      assert.ok(res.conflicts?.length > 0, `conflicts are surfaced, got ${JSON.stringify(res)}`);
      assert.equal(res.attempts, 1, "a conflict needs a human — it is not retried through");
      const actions = (res.nextActions ?? []).join(" ");
      assert.match(actions, /avcs\.conflict\.list/);
      assert.match(actions, /avcs\.decision\.record/);
    } finally {
      await hub.close();
    }
  } finally {
    for (const d of [hubDir, aDir]) await rm(d, { recursive: true, force: true });
  }
});

test("land works with no hub at all — a purely local repo still reaches a head", async () => {
  const aDir = await mkdtemp(join(tmpdir(), "avcs-m2-local-"));
  try {
    const a = await Repo.init(aDir);
    await author(a, "a.ts", "mine\n", ai);
    const res = await call("avcs.sync.land", a, { by: "human:h" });
    assert.equal(res.landed, true, `local land, got ${JSON.stringify(res)}`);
    assert.equal(await a.protectedHead("main"), res.head, "the local protected head advanced");
  } finally {
    await rm(aDir, { recursive: true, force: true });
  }
});

// ── M2.3 workspace.project ──────────────────────────────────────────────────

test("workspace.project writes the view to disk so build/test loops need no CLI", async () => {
  const aDir = await mkdtemp(join(tmpdir(), "avcs-m2-proj-"));
  const outDir = await mkdtemp(join(tmpdir(), "avcs-m2-out-"));
  try {
    const a = await Repo.init(aDir);
    await author(a, "a.ts", "mine\n", ai);
    const res = await call("avcs.workspace.project", a, { out: outDir });
    assert.equal(res.fileCount, 1);
    assert.ok(res.treeHash, "the projected treeHash is reported");
    assert.deepEqual((await readdir(outDir)).filter((f) => f === "a.ts"), ["a.ts"]);
  } finally {
    for (const d of [aDir, outDir]) await rm(d, { recursive: true, force: true });
  }
});
