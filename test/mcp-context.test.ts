// Phase 16 M3 (docs/18 §M3) — ContextPack.
//
// Without it an agent reconstructs its working context by hand: blame here, history there,
// decisions somewhere else, and pays for every round trip. context.build assembles the
// whole thing under a byte budget.
//
// The invariant that makes it an AVCS feature rather than a convenience: truncation is
// DETERMINISTIC. Section priority is fixed, ordering inside a section is fixed, and the
// greedy fill runs over compact serialization bytes — so the same input yields the same
// bytes, and what got dropped is recorded rather than silently missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
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

async function tmpRepo(): Promise<{ repo: Repo; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-mcp-ctx-"));
  return { repo: await Repo.init(dir), dir };
}

/** A repo with one intent, one session and `paths` authored by `ai`. */
async function seeded(repo: Repo, paths: string[]): Promise<{ intent: string; sess: string }> {
  const intent = await repo.createIntent({
    title: "work", owner: "human:h",
    allowedScopes: paths.map((p) => `file:${p}`) as never,
  });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  for (const p of paths) {
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: p, content: `// ${p}\n`, declaredPurpose: `write ${p}` });
  }
  return { intent, sess };
}

test("context.build requires a scope — it will not silently pack the whole repo", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const res = await runTool(tool("avcs.context.build"), repo, {});
    assert.equal(res.isError, true, "no scope is an error, not an unbounded answer");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("paths scope builds a pack carrying the version, view and treeHash", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await seeded(repo, ["a.ts"]);
    const pack = await call("avcs.context.build", repo, { paths: ["a.ts"] });
    assert.equal(pack.v, 1);
    assert.equal(pack.view, "main");
    assert.ok(pack.treeHash, "the pack is pinned to a materialized tree");
    assert.ok(pack.budget.maxBytes > 0);
    assert.ok(pack.budget.usedBytes > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("symbols carry provenance but NOT content — the agent fetches slices separately", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await seeded(repo, ["a.ts"]);
    const pack = await call("avcs.context.build", repo, { paths: ["a.ts"] });
    const sym = pack.symbols.find((s: any) => s.key === "file:a.ts");
    assert.ok(sym, `file:a.ts is in the pack, got ${JSON.stringify(pack.symbols)}`);
    assert.equal(sym.owner, "ai:a");
    assert.ok(sym.blobOid, "the blob oid is there so object.show can slice it");
    assert.ok(typeof sym.bytes === "number");
    assert.ok(!("text" in sym) && !("content" in sym), "content is deliberately absent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an intent scope resolves to the entities its sessions actually touched", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const { intent } = await seeded(repo, ["a.ts", "b.ts"]);
    const pack = await call("avcs.context.build", repo, { intentOid: intent });
    const keys = pack.symbols.map((s: any) => s.key).sort();
    assert.deepEqual(keys, ["file:a.ts", "file:b.ts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an open conflict on a scoped key is reported as a risk", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const intent = await repo.createIntent({ title: "c", owner: "human:h" });
    const s1 = await repo.startSession({ intentOid: intent, actor: ai });
    const s2 = await repo.startSession({ intentOid: intent, actor: bob });
    await repo.proposeFileWrite({ sessionOid: s1, intentOid: intent, actor: ai, path: "c.ts", content: "alice\n", declaredPurpose: "p" });
    await repo.proposeFileWrite({ sessionOid: s2, intentOid: intent, actor: bob, path: "c.ts", content: "bob\n", declaredPurpose: "p" });
    const pack = await call("avcs.context.build", repo, { paths: ["c.ts"] });
    assert.ok(
      pack.risks.some((r: any) => r.kind === "conflict" && r.key === "file:c.ts"),
      `conflict risk surfaced, got ${JSON.stringify(pack.risks)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("another actor's overlapping lease is a risk you see before you start", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const { intent } = await seeded(repo, ["a.ts"]);
    const bobSess = await repo.startSession({ intentOid: intent, actor: bob });
    await repo.requestLease({ intentOid: intent, sessionOid: bobSess, actor: bob, writeScopes: ["file:a.ts"], ttlMs: 60_000 });
    const pack = await call("avcs.context.build", repo, { paths: ["a.ts"] });
    assert.ok(
      pack.risks.some((r: any) => r.kind === "lease" && r.key === "file:a.ts"),
      `lease risk surfaced, got ${JSON.stringify(pack.risks)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── the invariant that matters ──────────────────────────────────────────────

test("the same input produces byte-identical output — truncation is deterministic", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await seeded(repo, ["a.ts", "b.ts", "c.ts"]);
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(JSON.stringify(await call("avcs.context.build", repo, { paths: ["a.ts", "b.ts", "c.ts"], maxBytes: 700 })));
    assert.equal(new Set(runs).size, 1, "three builds of the same input agree byte for byte");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tight budget drops low-priority sections and RECORDS what it dropped", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await seeded(repo, ["a.ts", "b.ts", "c.ts", "d.ts"]);
    const pack = await call("avcs.context.build", repo, { paths: ["a.ts", "b.ts", "c.ts", "d.ts"], maxBytes: 400 });
    assert.ok(pack.budget.usedBytes <= 400, `stayed within budget, used ${pack.budget.usedBytes}`);
    assert.ok(pack.budget.truncated.length > 0, "an omission is never silent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("risks outrank everything — a tight budget keeps them and drops history first", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const intent = await repo.createIntent({ title: "c", owner: "human:h" });
    const s1 = await repo.startSession({ intentOid: intent, actor: ai });
    const s2 = await repo.startSession({ intentOid: intent, actor: bob });
    await repo.proposeFileWrite({ sessionOid: s1, intentOid: intent, actor: ai, path: "c.ts", content: "alice\n", declaredPurpose: "p" });
    await repo.proposeFileWrite({ sessionOid: s2, intentOid: intent, actor: bob, path: "c.ts", content: "bob\n", declaredPurpose: "p" });
    const pack = await call("avcs.context.build", repo, { paths: ["c.ts"], maxBytes: 350 });
    assert.ok(pack.risks.length > 0, "a risk survives a budget that dropped other sections");
    assert.ok(pack.budget.truncated.includes("history"), `history goes first, truncated=${JSON.stringify(pack.budget.truncated)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── M3.2 decision.recall ────────────────────────────────────────────────────

test("decision.recall returns the decision memory for a key plus the learned policies", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await seeded(repo, ["a.ts"]);
    const res = await call("avcs.decision.recall", repo, { conflictKey: "file:a.ts" });
    assert.ok(Array.isArray(res.decisions));
    assert.ok(Array.isArray(res.policies));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
