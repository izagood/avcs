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

test("object.show returns a blob's decoded text and an operation's structure (issue #12)", async () => {
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
      path: "s.ts",
      content: "export const x = 1;\n",
      declaredPurpose: "seed",
    })) as string;

    // op oid → the structured operation, carrying the put_file blobOid
    const opObj = (await tool("avcs.object.show").handler(repo, { oid: opOid })) as {
      kind: string;
      object: { body: { kind: string; blobOid: string } };
    };
    assert.equal(opObj.kind, "operation");
    assert.equal(opObj.object.body.kind, "put_file");
    const blobOid = opObj.object.body.blobOid;
    assert.ok(blobOid, "operation carries a blobOid");

    // blob oid → decoded utf8 text (the MCP equivalent of CLI `show`)
    const blob = (await tool("avcs.object.show").handler(repo, { oid: blobOid })) as {
      kind: string;
      encoding: string;
      binary: boolean;
      text: string;
    };
    assert.equal(blob.kind, "blob");
    assert.equal(blob.binary, false);
    assert.equal(blob.encoding, "utf8");
    assert.equal(blob.text, "export const x = 1;\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("operation.propose routes to a 3-way-mergeable edit_file when a base is declared (issue #20)", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const intentOid = (await tool("avcs.intent.create").handler(repo, { title: "t", owner: "human:h" })) as string;
    const sessionOid = (await tool("avcs.session.start").handler(repo, {
      intentOid,
      actor: { kind: "ai_agent", id: "ai:a" },
    })) as string;
    const base = "alpha\nbeta\ngamma\n";
    const propose = (args: Record<string, unknown>) =>
      tool("avcs.operation.propose").handler(repo, {
        sessionOid,
        intentOid,
        actor: { kind: "ai_agent", id: "ai:a" },
        ...args,
      }) as Promise<string>;

    // a real base must exist in the tree first (put_file), then two disjoint edits over it
    const scaffold = await propose({ path: "m.ts", content: base, declaredPurpose: "scaffold" });
    const opA = await propose({
      path: "m.ts",
      content: "ALPHA\nbeta\ngamma\n",
      baseText: base,
      causalDeps: [scaffold],
      declaredPurpose: "edit line 1",
    });
    const opB = await propose({
      path: "m.ts",
      content: "alpha\nbeta\nGAMMA\n",
      baseText: base,
      causalDeps: [scaffold],
      declaredPurpose: "edit line 3",
    });

    // a declared base routes to edit_file (not the whole-file put_file) and carries a 3-way merge base
    const aObj = (await tool("avcs.object.show").handler(repo, { oid: opA })) as {
      object: { body: { kind: string; baseBlobOid?: string } };
    };
    assert.equal(aObj.object.body.kind, "edit_file");
    assert.ok(aObj.object.body.baseBlobOid, "edit_file carries a baseBlobOid");

    // disjoint concurrent edits against the same base auto-merge — no conflict, both lines applied
    const res = await repo.materialize("main");
    assert.equal(res.conflicts.length, 0, "disjoint edits merge without conflict");
    const got = (await repo.materializedFiles(res)).find((f) => f.path === "m.ts")?.content;
    assert.equal(got, "ALPHA\nbeta\nGAMMA\n", "both disjoint edits survive the auto-merge");
    assert.equal(res.statuses.get(opB), "accepted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("view.materialize includeStatuses projects gated ops and reports the dropped (issue #13)", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const intentOid = (await tool("avcs.intent.create").handler(repo, { title: "t", owner: "human:h" })) as string;
    const sessionOid = (await tool("avcs.session.start").handler(repo, {
      intentOid,
      actor: { kind: "ai_agent", id: "ai:a" },
    })) as string;
    // a behavior-changing op with no passing-test evidence stays gated (not accepted)
    const opOid = (await tool("avcs.operation.propose").handler(repo, {
      sessionOid,
      intentOid,
      actor: { kind: "ai_agent", id: "ai:a" },
      path: "impl.ts",
      content: "export const f = () => 2;\n",
      declaredPurpose: "behavior change",
      effects: { changesBehavior: true },
    })) as string;

    // default (accepted only): the gated op is NOT in the tree, but IS surfaced as dropped (no silent omission)
    const def = (await tool("avcs.view.materialize").handler(repo, {})) as {
      files: string[];
      status: Record<string, string>;
      dropped: { oid: string; status: string }[];
    };
    assert.ok(!def.files.includes("impl.ts"), "gated op omitted from the default tree");
    assert.notEqual(def.status[opOid], "accepted");
    assert.ok(def.dropped.some((d) => d.oid === opOid), "gated op surfaced in `dropped`");

    // opt-in: include the gated op's status → it projects into the tree, so its merge is inspectable
    const incl = (await tool("avcs.view.materialize").handler(repo, {
      includeStatuses: ["accepted", def.status[opOid]],
    })) as { files: string[]; dropped: { oid: string }[] };
    assert.ok(incl.files.includes("impl.ts"), "gated op projected once its status is included");
    assert.ok(!incl.dropped.some((d) => d.oid === opOid), "no longer dropped once included");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("operation.propose workspace + workspace.land/list manage isolation → convergence (docs/16, #26)", async () => {
  const { repo, dir } = await tmpRepo();
  try {
    const intentOid = (await tool("avcs.intent.create").handler(repo, { title: "t", owner: "human:h" })) as string;
    const sessionOid = (await tool("avcs.session.start").handler(repo, {
      intentOid,
      actor: { kind: "ai_agent", id: "ai:a" },
    })) as string;
    await tool("avcs.operation.propose").handler(repo, {
      sessionOid,
      intentOid,
      actor: { kind: "ai_agent", id: "ai:a" },
      path: "w.ts",
      content: "ws\n",
      declaredPurpose: "ws work",
      workspace: "wsA",
    });

    // base view excludes the un-landed workspace op; landed list empty
    const base1 = (await tool("avcs.view.materialize").handler(repo, {})) as { files: string[] };
    assert.ok(!base1.files.includes("w.ts"), "base view excludes un-landed workspace op");
    assert.deepEqual(((await tool("avcs.workspace.list").handler(repo, {})) as { landed: string[] }).landed, []);

    // land via the tool → returns the landed set
    const landed = (await tool("avcs.workspace.land").handler(repo, { name: "wsA" })) as { landed: string[] };
    assert.deepEqual(landed.landed, ["wsA"]);
    assert.deepEqual(((await tool("avcs.workspace.list").handler(repo, {})) as { landed: string[] }).landed, ["wsA"]);

    // base view now includes the landed workspace's op
    const base2 = (await tool("avcs.view.materialize").handler(repo, {})) as { files: string[] };
    assert.ok(base2.files.includes("w.ts"), "base view includes the landed workspace op");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
