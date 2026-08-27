// T0-2 — the early conflict warning must be able to see ACROSS lines.
//
// The git bridge maps every git branch to its own AVCS line (`lineFor()` in src/cli.ts),
// so with N parallel sessions on N branches every other session's ops sit on a different
// line — structurally invisible to the line-scoped filter in `Repo.contention`. The
// early-warning system therefore never fired in the exact scenario it was built for.
//
// `acrossLines: true` (opt-in; the default stays strictly line-scoped) drops the line
// filter and reports which line the competing op came from. The capture path
// (`commitWorkingTree`) asks for it, so `git commit` can warn the human.
//
//   node --experimental-strip-types --test test/contention-across-lines.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { TOOLS } from "../src/mcp/server.ts";
import type { Actor } from "../src/objects/types.ts";

const alice: Actor = { kind: "ai_agent", id: "ai:alice" };
const bob: Actor = { kind: "ai_agent", id: "ai:bob" };

const mkrepo = () => mkdtemp(join(tmpdir(), "avcs-xline-"));

async function author(repo: Repo, actor: Actor, path: string, content: string, line?: string): Promise<string> {
  const intent = await repo.createIntent({ title: `work by ${actor.id}`, owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor });
  return repo.proposeFileWrite({
    sessionOid: sess,
    intentOid: intent,
    actor,
    path,
    content,
    declaredPurpose: `write ${path} as ${actor.id}`,
    ...(line ? { line } : {}),
  });
}

test("cross-line contention is invisible by default and reported (with its line) opt-in", async () => {
  const dir = await mkrepo();
  try {
    const repo = await Repo.init(dir);
    await repo.createLine("feat-a");
    await repo.createLine("feat-b");
    await author(repo, alice, "shared.ts", "alice\n", "feat-a");
    const bobOp = await author(repo, bob, "shared.ts", "bob\n", "feat-b");

    // Default (line-scoped): from alice's branch, bob's op on another line is not seen.
    const scoped = await repo.contention({ keys: ["file:shared.ts"], actorId: alice.id, line: "feat-a" });
    assert.deepEqual(scoped, [], "the line filter hides every other branch's work");

    // Opt-in: the competing op reports, and names the line it lives on.
    const across = await repo.contention({ keys: ["file:shared.ts"], actorId: alice.id, line: "feat-a", acrossLines: true });
    assert.equal(across.length, 1);
    assert.equal(across[0]!.key, "file:shared.ts");
    assert.deepEqual(across[0]!.theirs.map((t) => t.op), [bobOp]);
    assert.equal(across[0]!.theirs[0]!.actor, bob.id);
    assert.equal(across[0]!.theirs[0]!.line, "feat-b", "the caller must be able to say WHICH branch contends");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acrossLines reports the default `main` line explicitly, and stays additive", async () => {
  const dir = await mkrepo();
  try {
    const repo = await Repo.init(dir);
    await repo.createLine("feat");
    const bobOp = await author(repo, bob, "m.ts", "bob on main\n"); // no line ⇒ main
    await author(repo, alice, "m.ts", "alice on feat\n", "feat");

    const across = await repo.contention({ keys: ["file:m.ts"], actorId: alice.id, line: "feat", acrossLines: true });
    assert.equal(across.length, 1);
    assert.deepEqual(across[0]!.theirs.map((t) => t.op), [bobOp]);
    assert.equal(across[0]!.theirs[0]!.line, "main", "a line-less op is reported as the default line");
    // The rest of the warning shape is untouched.
    assert.equal(typeof across[0]!.theirs[0]!.lamport, "number");
    assert.deepEqual(across[0]!.leaseHolders, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("own ops never warn, even across lines", async () => {
  const dir = await mkrepo();
  try {
    const repo = await Repo.init(dir);
    await repo.createLine("feat");
    await author(repo, alice, "own.ts", "alice on main\n");
    await author(repo, alice, "own.ts", "alice on feat\n", "feat");

    assert.deepEqual(
      await repo.contention({ keys: ["file:own.ts"], actorId: alice.id, line: "feat", acrossLines: true }),
      [],
      "my own causal closure is history, not contention — on any line",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the capture path surfaces a cross-line contention warning at commit time", async () => {
  const store = await mkrepo();
  const workA = await mkrepo();
  const workB = await mkrepo();
  try {
    const repo = await Repo.init(store);
    // A file both branches will touch, established on main first.
    await writeFile(join(workA, "hot.ts"), "v0\n", "utf8");
    await repo.commitWorkingTree(workA, { message: "scaffold", actor: { kind: "human", id: "human:h" } });
    await repo.createLine("branch-x");
    await repo.createLine("branch-y");
    await repo.checkoutInto(workA, "branch-x");
    await repo.checkoutInto(workB, "branch-y");

    // Session X captures on its branch — nothing else is in flight, so no warning.
    await writeFile(join(workA, "hot.ts"), "v0 + alice\n", "utf8");
    const capX = await repo.commitWorkingTree(workA, { message: "alice edits", actor: alice, line: "branch-x" });
    assert.deepEqual(capX.contention, [], "the first capture has nothing to contend with");

    // Session Y captures the same file on ANOTHER branch — that is the warning we want.
    await writeFile(join(workB, "hot.ts"), "v0 + bob\n", "utf8");
    const capY = await repo.commitWorkingTree(workB, { message: "bob edits", actor: bob, line: "branch-y" });
    assert.equal(capY.contention.length, 1, "capture must see the competing branch");
    assert.equal(capY.contention[0]!.key, "file:hot.ts");
    assert.deepEqual(capY.contention[0]!.theirs.map((t) => t.op), capX.ops);
    assert.equal(capY.contention[0]!.theirs[0]!.actor, alice.id);
    assert.equal(capY.contention[0]!.theirs[0]!.line, "branch-x");
  } finally {
    for (const d of [store, workA, workB]) await rm(d, { recursive: true, force: true });
  }
});

test("MCP avcs.contention.check exposes acrossLines additively", async () => {
  const dir = await mkrepo();
  try {
    const repo = await Repo.init(dir);
    await repo.createLine("feat");
    const bobOp = await author(repo, bob, "mcp.ts", "bob on main\n");
    await author(repo, alice, "mcp.ts", "alice on feat\n", "feat");

    const check = TOOLS.find((t) => t.name === "avcs.contention.check")!;
    assert.ok("acrossLines" in (check.inputSchema.properties as Record<string, unknown>), "the option is advertised");

    const scoped = (await check.handler(repo, { keys: ["file:mcp.ts"], actor: alice.id, line: "feat" })) as unknown[];
    assert.deepEqual(scoped, [], "default response unchanged");

    const across = (await check.handler(repo, { keys: ["file:mcp.ts"], actor: alice.id, line: "feat", acrossLines: true })) as {
      theirs: { op: string; line?: string }[];
    }[];
    assert.equal(across.length, 1);
    assert.deepEqual(across[0]!.theirs.map((t) => t.op), [bobOp]);
    assert.equal(across[0]!.theirs[0]!.line, "main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
