// Phase 15.3 (docs/17 §15.3) — early conflict warning. Overlap is discovered at
// AUTHORING time via the entity index (O(ops-on-key), no reduce): another actor's live
// concurrent op on your key, or their active lease over it, warns before finalize would
// ever surface a conflict. Own work never warns; rejected/superseded/built-upon ops are
// history, not contention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { TOOLS } from "../src/mcp/server.ts";
import { Logger, type LogEntry } from "../src/observe/logger.ts";
import type { Actor } from "../src/objects/types.ts";

const aliceActor: Actor = { kind: "ai_agent", id: "ai:alice" };
const bobActor: Actor = { kind: "ai_agent", id: "ai:bob" };

async function session(repo: Repo, actor: Actor): Promise<{ intent: string; sess: string }> {
  const intent = await repo.createIntent({ title: `work by ${actor.id}`, owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor });
  return { intent, sess };
}

async function author(repo: Repo, actor: Actor, path: string, content: string, opts?: { causalDeps?: string[]; warnContention?: boolean }): Promise<string> {
  const { intent, sess } = await session(repo, actor);
  return repo.proposeFileWrite({
    sessionOid: sess,
    intentOid: intent,
    actor,
    path,
    content,
    declaredPurpose: `write ${path} as ${actor.id}`,
    causalDeps: opts?.causalDeps,
    warnContention: opts?.warnContention,
  });
}

async function tmpRepo(): Promise<{ repo: Repo; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-cont-"));
  return { repo: await Repo.init(dir), dir };
}

test("another actor's concurrent op on my key warns — and stops warning once I build on it", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await author(repo, aliceActor, "shared.ts", "alice v1\n");
    const bobOp = await author(repo, bobActor, "shared.ts", "bob v1\n"); // causally independent

    // From alice's perspective: bob's live concurrent op is contention.
    let warnings = await repo.contention({ actorId: "ai:alice" });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.key, "file:shared.ts");
    assert.deepEqual(warnings[0]!.theirs.map((t) => t.op), [bobOp]);
    assert.equal(warnings[0]!.theirs[0]!.actor, "ai:bob");
    assert.equal(typeof warnings[0]!.theirs[0]!.purpose, "string");

    // Alice merges bob's work into her ancestry — the surprise is gone, so is the warning.
    await author(repo, aliceActor, "shared.ts", "alice v2 incorporating bob\n", { causalDeps: [bobOp] });
    warnings = await repo.contention({ actorId: "ai:alice" });
    assert.deepEqual(warnings, [], "an op inside my causal closure is history, not contention");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("perspective via sessionOid: the session's actor and authored keys drive the check", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const { intent, sess } = await session(repo, aliceActor);
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: aliceActor, path: "mine.ts", content: "a\n", declaredPurpose: "alice's file" });
    const bobOp = await author(repo, bobActor, "mine.ts", "b\n");
    await author(repo, bobActor, "unrelated.ts", "b\n"); // bob's other key — not alice's problem

    const warnings = await repo.contention({ sessionOid: sess });
    assert.equal(warnings.length, 1, "only the session's own keys are checked");
    assert.equal(warnings[0]!.key, "file:mine.ts");
    assert.deepEqual(warnings[0]!.theirs.map((t) => t.op), [bobOp]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("own concurrent ops never warn", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await author(repo, aliceActor, "own.ts", "v1\n");
    await author(repo, aliceActor, "own.ts", "v2, independent session\n");
    assert.deepEqual(await repo.contention({ actorId: "ai:alice" }), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("superseded work does not warn: only the tip of the other actor's chain is live", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const bobV1 = await author(repo, bobActor, "chain.ts", "bob v1\n");
    const bobV2 = await author(repo, bobActor, "chain.ts", "bob v2\n", { causalDeps: [bobV1] });

    const warnings = await repo.contention({ keys: ["file:chain.ts"], actorId: "ai:alice" });
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0]!.theirs.map((t) => t.op), [bobV2], "v1 is built upon (superseded), only v2 is live");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("decision-rejected ops do not warn", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const aliceOp = await author(repo, aliceActor, "decided.ts", "alice\n");
    const bobOp = await author(repo, bobActor, "decided.ts", "bob\n");
    assert.equal((await repo.contention({ actorId: "ai:alice" })).length, 1);

    await repo.recordDecision({
      conflictId: "conflict:decided.ts",
      chosenOps: [aliceOp],
      rejectedOps: [bobOp],
      reason: "alice's version wins",
      decidedBy: { kind: "human", id: "human:h" },
    });
    assert.deepEqual(await repo.contention({ actorId: "ai:alice" }), [], "a rejected op is settled, not contended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("another actor's active lease over the key is reported; my own lease is not", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const bob = await session(repo, bobActor);
    const granted = await repo.requestLease({ intentOid: bob.intent, sessionOid: bob.sess, actor: bobActor, writeScopes: ["file:src/"], mode: "exclusive" });
    assert.ok(granted.granted);

    const alice = await session(repo, aliceActor);
    await repo.requestLease({ intentOid: alice.intent, sessionOid: alice.sess, actor: aliceActor, writeScopes: ["file:docs/"], mode: "shared" });

    const warnings = await repo.contention({ keys: ["file:src/app.ts", "file:docs/readme.md"], actorId: "ai:alice" });
    assert.equal(warnings.length, 1, "only the key under bob's lease warns");
    assert.equal(warnings[0]!.key, "file:src/app.ts");
    assert.deepEqual(warnings[0]!.theirs, []);
    assert.equal(warnings[0]!.leaseHolders.length, 1);
    assert.equal(warnings[0]!.leaseHolders[0]!.actor, "ai:bob");
    assert.equal(warnings[0]!.leaseHolders[0]!.scope, "file:src/");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("proposeOperation warnContention is additive: oid return unchanged, alert lands in log + metric", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const entries: LogEntry[] = [];
    repo.logger = new Logger({ sink: (e) => entries.push(e), level: "debug" });

    await author(repo, bobActor, "warned.ts", "bob first\n");
    const oid = await author(repo, aliceActor, "warned.ts", "alice, unaware of bob\n", { warnContention: true });
    assert.equal(typeof oid, "string", "return type stays the plain oid");

    const warn = entries.find((e) => e.event === "contention.warn");
    assert.ok(warn, "a structured contention.warn entry was logged");
    assert.equal(warn!.key, "file:warned.ts");
    assert.equal(repo.metrics.snapshot().counters["contention.warnings"], 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP surface: avcs.contention.check reports, and propose+warnContention returns { oid, contentionWarnings }", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const check = TOOLS.find((t) => t.name === "avcs.contention.check");
    assert.ok(check, "avcs.contention.check is registered");

    const bobOp = await author(repo, bobActor, "mcp.ts", "bob\n");
    const { intent, sess } = await session(repo, aliceActor);
    const proposeTool = TOOLS.find((t) => t.name === "avcs.operation.propose")!;
    const result = (await proposeTool.handler(repo, {
      sessionOid: sess,
      intentOid: intent,
      actor: aliceActor,
      path: "mcp.ts",
      content: "alice\n",
      declaredPurpose: "alice via MCP",
      warnContention: true,
    })) as { oid: string; contentionWarnings: { key: string; theirs: { op: string }[] }[] };
    assert.equal(typeof result.oid, "string");
    assert.equal(result.contentionWarnings.length, 1);
    assert.equal(result.contentionWarnings[0]!.key, "file:mcp.ts");
    assert.deepEqual(result.contentionWarnings[0]!.theirs.map((t) => t.op), [bobOp]);

    const report = (await check!.handler(repo, { keys: ["file:mcp.ts"], actor: "ai:bob" })) as { key: string }[];
    assert.equal(report.length, 1, "bob's perspective: alice's op is the live surprise");

    // Without the flag the response is the plain oid — the pre-15.3 contract.
    const plain = await proposeTool.handler(repo, {
      sessionOid: sess,
      intentOid: intent,
      actor: aliceActor,
      path: "plain.ts",
      content: "no check\n",
      declaredPurpose: "plain propose",
    });
    assert.equal(typeof plain, "string");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
