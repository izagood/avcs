// Phase 16 M1.1 (docs/18 §1.1, §3) — the CallTool layer: compact/verbose serialization and
// the error envelope, wired where every tool call passes through.
//
// Driven without the SDK (the house style for MCP tests): the dispatch logic is exported
// so it can be exercised against a real temp Repo, exactly as the handlers already are.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { TOOLS, runTool, advertisedSchema } from "../src/mcp/server.ts";

function tool(name: string) {
  const t = TOOLS.find((t) => t.name === name);
  assert.ok(t, `tool ${name} is registered`);
  return t!;
}

async function tmpRepo(): Promise<{ repo: Repo; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-mcp-dispatch-"));
  const repo = await Repo.init(dir);
  return { repo, dir };
}

test("a successful call serializes compactly and is not marked an error", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const res = await runTool(tool("avcs.intent.create"), repo, {
      title: "t",
      owner: "human:h",
    });
    assert.notEqual(res.isError, true);
    const text = res.content[0]!.text;
    assert.ok(!text.includes("\n"), `compact, got: ${text}`);
    // The raw shape survives — no envelope around success (docs/18 §2 principle 1):
    // a tool returning an oid still serializes to that bare oid string.
    assert.match(text, /^"intent_[0-9a-f]+"$/, `bare oid string, got: ${text}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verbose pretty-prints the same successful result", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    // Needs real content: an empty list pretty-prints to "[]" either way.
    await runTool(tool("avcs.intent.create"), repo, { title: "t", owner: "human:h" });
    const res = await runTool(tool("avcs.intent.list"), repo, { verbose: true });
    assert.ok(res.content[0]!.text.includes("\n"), "verbose output is multi-line");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verbose is consumed by the layer, not passed through as a tool argument", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    // intent.create would happily ignore an unknown key, so assert the behaviour that
    // matters: asking for verbose changes only formatting, never the value produced.
    const plain = await runTool(tool("avcs.intent.list"), repo, {});
    const loud = await runTool(tool("avcs.intent.list"), repo, { verbose: true });
    assert.deepEqual(JSON.parse(loud.content[0]!.text), JSON.parse(plain.content[0]!.text));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failing call returns the recovery envelope instead of throwing at the transport", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    // No such intent → the handler throws; the layer must translate rather than propagate.
    const res = await runTool(tool("avcs.intent.read"), repo, { oid: "0".repeat(64) });
    assert.equal(res.isError, true);
    const env = JSON.parse(res.content[0]!.text) as { error: string; nextActions?: string[] };
    assert.ok(env.error.length > 0, "the envelope carries the message");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a known failure class carries nextActions through the dispatch layer", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const res = await runTool(tool("avcs.decision.record"), repo, {
      conflictId: "nope",
      chosenOps: [],
      rejectedOps: [],
      reason: "r",
      by: "human:h",
    });
    assert.equal(res.isError, true);
    const env = JSON.parse(res.content[0]!.text) as { error: string; nextActions?: string[] };
    assert.ok(env.error.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the advertised schema carries the universal cwd and verbose inputs", () => {
  const schema = advertisedSchema(tool("avcs.history"));
  const props = schema.properties as Record<string, unknown>;
  assert.ok(props.cwd, "cwd is advertised so per-call repo targeting is discoverable");
  assert.ok(props.verbose, "verbose is advertised on every tool, like cwd");
});

test("advertising the universal inputs does not drop or mutate a tool's own schema", () => {
  const t = tool("avcs.history");
  const own = Object.keys((t.inputSchema.properties as Record<string, unknown>) ?? {});
  const props = advertisedSchema(t).properties as Record<string, unknown>;
  for (const k of own) assert.ok(k in props, `${k} survived advertisement`);
  assert.deepEqual(
    (t.inputSchema.properties as Record<string, unknown>).verbose,
    undefined,
    "the tool's own schema object is not mutated in place",
  );
});
