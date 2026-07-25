// Phase 16 M4 (docs/18 §4.1–4.2, §4.4) — resources, prompts and the governance subset.
//
// Tools are the parameterized main path; resources exist to be SUBSCRIBABLE, so a client
// can be told "this changed" instead of polling. Both read through the same handlers, so a
// resource can never disagree with the tool that backs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { TOOLS, runTool } from "../src/mcp/server.ts";
import { RESOURCES, readResource } from "../src/mcp/resources.ts";
import { PROMPTS, buildPrompt } from "../src/mcp/prompts.ts";
import { generateKeypair } from "../src/core/identity.ts";
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
  const dir = await mkdtemp(join(tmpdir(), "avcs-mcp-res-"));
  return { repo: await Repo.init(dir), dir };
}

async function author(repo: Repo, path: string, content: string, actor: Actor): Promise<string> {
  const intent = await repo.createIntent({ title: `w ${path}`, owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor });
  return repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor, path, content, declaredPurpose: "p" });
}

// ── 4.1 resources ───────────────────────────────────────────────────────────

test("every advertised resource has a uri template and a mime type", () => {
  assert.ok(RESOURCES.length > 0);
  for (const r of RESOURCES) {
    assert.match(r.uri, /^avcs:\/\//, `${r.uri} is namespaced`);
    assert.ok(r.name.length > 0);
    assert.equal(r.mimeType, "application/json");
  }
});

test("the head resource reports the view's head and treeHash", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await author(repo, "a.ts", "x\n", ai);
    const body = JSON.parse(await readResource(repo, "avcs://view/main/head"));
    assert.ok("head" in body, `got ${JSON.stringify(body)}`);
    assert.ok(body.treeHash, "the tree the head resolves to");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the conflicts resource agrees with the conflict.list tool that backs it", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const intent = await repo.createIntent({ title: "c", owner: "human:h" });
    const s1 = await repo.startSession({ intentOid: intent, actor: ai });
    const s2 = await repo.startSession({ intentOid: intent, actor: bob });
    await repo.proposeFileWrite({ sessionOid: s1, intentOid: intent, actor: ai, path: "c.ts", content: "a\n", declaredPurpose: "p" });
    await repo.proposeFileWrite({ sessionOid: s2, intentOid: intent, actor: bob, path: "c.ts", content: "b\n", declaredPurpose: "p" });
    const viaResource = JSON.parse(await readResource(repo, "avcs://view/main/conflicts"));
    const viaTool = await call("avcs.conflict.list", repo, { view: "main" });
    assert.deepEqual(viaResource, viaTool, "one source of truth, two doors to it");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the guide resource is the guide tool's output", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const viaResource = JSON.parse(await readResource(repo, "avcs://guide"));
    const viaTool = await call("avcs.guide", repo, {});
    assert.deepEqual(viaResource, viaTool);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the view context resource scopes itself to the keys actually in play", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await author(repo, "a.ts", "x\n", ai);
    const body = JSON.parse(await readResource(repo, "avcs://view/main/context"));
    assert.equal(body.v, 1, `a ContextPack, got ${JSON.stringify(body).slice(0, 200)}`);
    assert.ok(body.symbols.some((s: any) => s.key === "file:a.ts"), "the recently-touched key is in scope");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unknown resource uri is an error, not an empty body", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await assert.rejects(() => readResource(repo, "avcs://nope/whatever"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 4.2 prompts ─────────────────────────────────────────────────────────────

test("every advertised prompt has a name and declares its arguments", () => {
  assert.ok(PROMPTS.length >= 4, `got ${PROMPTS.map((p) => p.name).join(", ")}`);
  for (const p of PROMPTS) {
    assert.match(p.name, /^avcs\./);
    assert.ok(p.description.length > 0);
    assert.ok(Array.isArray(p.arguments));
  }
});

test("the onboard prompt inlines the guide so a client needs no extra round trip", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const text = await buildPrompt(repo, "avcs.onboard", {});
    assert.match(text, /avcs\.sync\.land/, "the canonical loop is inlined");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the propose-change prompt inlines the intent's own constraints", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const intent = await repo.createIntent({
      title: "add caching", owner: "human:h",
      constraints: ["no new dependencies"],
    });
    const text = await buildPrompt(repo, "avcs.propose-change", { intentOid: intent });
    assert.match(text, /add caching/);
    assert.match(text, /no new dependencies/, "the constraint travels with the prompt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unknown prompt name is an error", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await assert.rejects(() => buildPrompt(repo, "avcs.nope", {}));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 4.4 governance subset ───────────────────────────────────────────────────

test("governance.status reports protection, head and the caller's role", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    await author(repo, "a.ts", "x\n", ai);
    const res = await call("avcs.governance.status", repo, { view: "main", as: "ai:a" });
    assert.ok("protection" in res);
    assert.ok("head" in res);
    assert.ok("myRole" in res, `got ${JSON.stringify(res)}`);
    assert.ok(Array.isArray(res.approvals));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("approval.record signs a reviewer verdict that governance.status then reports", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const root = generateKeypair();
    const rev = generateKeypair();
    await repo.registerMembership({
      actorId: "human:rev", publicKey: rev.publicKey, role: "reviewer", actorKind: "human",
      root: { keyId: "root", privateKey: root.privateKey },
    });
    await author(repo, "a.ts", "x\n", ai);
    const cp = await repo.createCheckpoint("main", "review me");
    await call("avcs.approval.record", repo, { checkpointOid: cp, verdict: "approve", by: "human:rev" });
    const res = await call("avcs.governance.status", repo, { view: "main", checkpointOid: cp });
    assert.ok(
      res.approvals.some((a: any) => a.by === "human:rev" && a.verdict === "approve"),
      `got ${JSON.stringify(res.approvals)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("approval.record refuses an actor without the reviewer role", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const root = generateKeypair();
    const kp = generateKeypair();
    await repo.registerMembership({
      actorId: "ai:a", publicKey: kp.publicKey, role: "proposer", actorKind: "ai_agent",
      root: { keyId: "root", privateKey: root.privateKey },
    });
    await author(repo, "a.ts", "x\n", ai);
    const cp = await repo.createCheckpoint("main", "review me");
    const res = await runTool(tool("avcs.approval.record"), repo, { checkpointOid: cp, verdict: "approve", by: "ai:a" });
    assert.equal(res.isError, true, "a proposer cannot approve");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
