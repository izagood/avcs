// Phase 16 M1.3 (docs/18 §1.3) — avcs.guide, the on-demand self-onboarding surface.
//
// The trade this makes: tool descriptions are a toll an agent pays on EVERY session, so
// teaching material moves out of them and into a tool that is called only when needed.
// That only works if the guide cannot go stale, so everything derivable — the tool index,
// the error map — is generated from the live tables rather than restated by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { TOOLS, runTool } from "../src/mcp/server.ts";
import { RECOVERY } from "../src/mcp/respond.ts";

function tool(name: string) {
  const t = TOOLS.find((t) => t.name === name);
  assert.ok(t, `tool ${name} is registered`);
  return t!;
}

async function guide(args: Record<string, unknown> = {}): Promise<any> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-mcp-guide-"));
  try {
    const repo = await Repo.init(dir);
    const res = await runTool(tool("avcs.guide"), repo, args);
    assert.notEqual(res.isError, true, res.content[0]!.text);
    return JSON.parse(res.content[0]!.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the guide is versioned so a client can tell the shape apart later", async () => {
  assert.equal((await guide()).v, 1);
});

test("with no topic the guide returns the canonical loop", async () => {
  const g = await guide();
  assert.ok(Array.isArray(g.loop) && g.loop.length > 0, "the canonical loop is the default answer");
  for (const step of g.loop) {
    assert.equal(typeof step.tool, "string");
    assert.ok(step.why.length > 0, `${step.tool} explains why it is in the loop`);
  }
});

test("every tool the canonical loop names is actually registered — the loop cannot drift", async () => {
  const registered = new Set(TOOLS.map((t) => t.name));
  for (const step of (await guide()).loop) {
    assert.ok(registered.has(step.tool), `loop step names unregistered tool ${step.tool}`);
  }
});

test("the tool index is generated from the live tool table, so it can never go stale", async () => {
  const g = await guide({ topic: "tools" });
  const indexed = new Set(g.tools.map((t: any) => t.name));
  for (const t of TOOLS) assert.ok(indexed.has(t.name), `${t.name} is missing from the index`);
  assert.equal(indexed.size, TOOLS.length, "the index has no entries the server does not serve");
});

test("the errors topic is derived from the same recovery table the dispatcher uses", async () => {
  const g = await guide({ topic: "errors" });
  assert.equal(g.errors.length, RECOVERY.length, "one entry per known failure class, generated not restated");
  for (const e of g.errors) assert.ok(Array.isArray(e.nextActions) && e.nextActions.length > 0);
});

test("the rules topic states the agent obligations in machine-readable form", async () => {
  const g = await guide({ topic: "rules" });
  assert.ok(Array.isArray(g.rules) && g.rules.length >= 4, `got ${JSON.stringify(g.rules)}`);
  const joined = g.rules.join(" ").toLowerCase();
  assert.match(joined, /propose/, "the never-write-files-directly rule is present");
  assert.match(joined, /evidence|test/, "the evidence-for-behaviour-change rule is present");
});

test("an unknown topic degrades to the default rather than erroring", async () => {
  const g = await guide({ topic: "nonsense-topic" });
  assert.ok(Array.isArray(g.loop), "still answers with the canonical loop");
});

test("no tool description exceeds the word budget — teaching lives in the guide, not the schema", () => {
  // The other half of the guide trade (docs/18 §1.2): descriptions are paid on every
  // session by every agent, so they identify a tool; the guide teaches it. Without this
  // ceiling the schema quietly re-absorbs the prose the guide was created to hold.
  const over = TOOLS.map((t) => ({ name: t.name, words: t.description.split(/\s+/).length }))
    .filter((t) => t.words > 25);
  assert.deepEqual(over, [], `these descriptions exceed 25 words: ${JSON.stringify(over)}`);
});

test("the guide stays small enough to be worth calling — it is a budget, not a manual", async () => {
  // ~600 tokens is the design target (docs/18 §1.3); assert a generous ceiling on the
  // compact serialization so the guide cannot quietly grow into a second manual.
  const bytes = JSON.stringify(await guide()).length;
  assert.ok(bytes < 6000, `default guide is ${bytes} bytes`);
});
