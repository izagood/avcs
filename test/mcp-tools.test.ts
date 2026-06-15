// Tests for the MCP tool surface — AVCS's primary, agent-facing interface. We drive
// the exported TOOLS handlers directly against a real temp Repo (no stdio/SDK needed),
// the same Repo facade the CLI and demo use, so this exercises the agent flow end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { TOOLS, actorOf } from "../src/mcp/server.ts";

function tool(name: string) {
  const t = TOOLS.find((t) => t.name === name);
  assert.ok(t, `tool ${name} is registered`);
  return t!;
}

async function tmpRepo(): Promise<{ repo: Repo; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-mcp-"));
  const repo = await Repo.init(dir);
  return { repo, dir };
}

test("every tool exposes a name, description and an object inputSchema", () => {
  assert.ok(TOOLS.length > 0);
  const names = new Set<string>();
  for (const t of TOOLS) {
    assert.equal(typeof t.name, "string");
    assert.ok(t.name.startsWith("avcs."), `${t.name} is namespaced`);
    assert.ok(t.description.length > 0, `${t.name} has a description`);
    assert.equal((t.inputSchema as { type?: string }).type, "object");
    assert.equal(typeof t.handler, "function");
    assert.ok(!names.has(t.name), `${t.name} is unique`);
    names.add(t.name);
  }
});

test("actorOf defaults to an ai_agent and preserves provided identity/model", () => {
  assert.deepEqual(actorOf({}), { kind: "ai_agent", id: "ai:unknown" });
  assert.deepEqual(actorOf({ actor: { kind: "human", id: "human:h" } }), { kind: "human", id: "human:h" });
  assert.deepEqual(actorOf({ actor: { id: "ai:x", model: "opus" } }), { kind: "ai_agent", id: "ai:x", model: "opus" });
});

test("agent flow: create intent → start session → propose → materialize", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const intentOid = (await tool("avcs.intent.create").handler(repo, {
      title: "add cache",
      owner: "human:h",
    })) as string;
    assert.equal(typeof intentOid, "string");

    const listed = (await tool("avcs.intent.list").handler(repo, {})) as unknown[];
    assert.equal(listed.length, 1);

    const sessionOid = (await tool("avcs.session.start").handler(repo, {
      intentOid,
      actor: { kind: "ai_agent", id: "ai:a" },
    })) as string;
    assert.equal(typeof sessionOid, "string");

    const opOid = (await tool("avcs.operation.propose").handler(repo, {
      sessionOid,
      intentOid,
      actor: { kind: "ai_agent", id: "ai:a" },
      path: "cache.ts",
      content: "export const x = 1;\n",
      declaredPurpose: "seed cache module",
    })) as string;
    assert.equal(typeof opOid, "string");

    const view = (await tool("avcs.view.materialize").handler(repo, {})) as {
      treeHash: string;
      files: string[];
      status: Record<string, string>;
      conflicts: unknown[];
    };
    assert.deepEqual(view.files, ["cache.ts"]);
    assert.equal(view.conflicts.length, 0);
    assert.ok(view.treeHash.length > 0);
    assert.equal(view.status[opOid], "accepted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evidence.attach + repair.context reflect a failing check", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const intentOid = (await tool("avcs.intent.create").handler(repo, { title: "t", owner: "human:h" })) as string;
    const sessionOid = (await tool("avcs.session.start").handler(repo, {
      intentOid,
      actor: { kind: "ai_agent", id: "ai:a" },
    })) as string;
    const opOid = (await tool("avcs.operation.propose").handler(repo, {
      sessionOid,
      intentOid,
      actor: { kind: "ai_agent", id: "ai:a" },
      path: "f.ts",
      content: "boom\n",
      declaredPurpose: "p",
    })) as string;

    await tool("avcs.evidence.attach").handler(repo, {
      forOps: [opOid],
      kind: "unit_test",
      result: "fail",
      actor: { kind: "ci_bot", id: "ci:runner" },
      detail: "AssertionError: expected 1",
    });

    const ctx = (await tool("avcs.repair.context").handler(repo, { ops: [opOid] })) as {
      failures: { kind: string; result: string; detail?: string }[];
      suggestion: string;
    };
    assert.equal(ctx.failures.length, 1);
    assert.equal(ctx.failures[0]!.result, "fail");
    assert.match(ctx.failures[0]!.detail!, /AssertionError/);
    assert.match(ctx.suggestion, /unit_test/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("history and metrics tools return structured data", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const intentOid = (await tool("avcs.intent.create").handler(repo, { title: "t", owner: "human:h" })) as string;
    const sessionOid = (await tool("avcs.session.start").handler(repo, {
      intentOid,
      actor: { kind: "ai_agent", id: "ai:a" },
    })) as string;
    const opOid = (await tool("avcs.operation.propose").handler(repo, {
      sessionOid,
      intentOid,
      actor: { kind: "ai_agent", id: "ai:a" },
      path: "h.ts",
      content: "1\n",
      declaredPurpose: "write h",
    })) as string;

    const history = (await tool("avcs.history").handler(repo, { entityKey: "file:h.ts" })) as {
      op: string;
      actor: string;
      purpose: string;
    }[];
    assert.equal(history.length, 1);
    assert.equal(history[0]!.op, opOid);
    assert.equal(history[0]!.actor, "ai:a");
    assert.equal(history[0]!.purpose, "write h");

    const metrics = (await tool("avcs.metrics").handler(repo, {})) as Record<string, unknown>;
    assert.equal(typeof metrics, "object");
    assert.ok(metrics !== null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
