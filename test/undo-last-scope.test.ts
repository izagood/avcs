// `undo --last` on a workspace or a line must target THAT scope's most recent commit (#183).
// It picked the newest op the view selects — and a workspace view selects every base op, a
// line view every op inherited at its fork — so a fresher base commit was undone from a branch.
// Observed twice in one afternoon: a workspace `undo --last` removed a 111-op base capture, and
// the base `undo --last` meant to repair that removed the next-newest base commit instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";

const dev = { kind: "human" as const, id: "human:dev" };
const mk = () => mkdtemp(join(tmpdir(), "avcs-undo-scope-"));

test("workspace: --last undoes the workspace's own last commit, not a newer base commit", async () => {
  const store = await mk();
  const wsDir = await mk();
  try {
    const repo = await Repo.init(store);
    await writeFile(join(store, "a.txt"), "a\n");
    await repo.commitWorkingTree(store, { message: "base A", actor: dev });

    // The workspace's commit, then a NEWER base commit.
    await writeFile(join(wsDir, "a.txt"), "a\n");
    await writeFile(join(wsDir, "b.txt"), "b\n");
    const ws = await repo.commitWorkingTree(wsDir, { message: "ws B", actor: dev, workspace: "feat" });
    await writeFile(join(store, "c.txt"), "c\n");
    const base = await repo.commitWorkingTree(store, { message: "base C", actor: dev });
    assert.ok(base.ops.length > 0 && ws.ops.length > 0);

    const r = await repo.undo({ last: true, workspace: "feat", by: dev.id });
    assert.deepEqual([...r.excluded].sort(), [...ws.ops].sort(), "the workspace's commit, not base C");

    // Base is untouched: its view still projects c.txt.
    const baseTree = [...(await repo.materialize("main")).tree.keys()].sort();
    assert.deepEqual(baseTree, ["a.txt", "c.txt"]);
    // And the workspace no longer projects b.txt.
    const wsTree = [...(await repo.materialize("main", { workspace: "feat" })).tree.keys()].sort();
    assert.ok(!wsTree.includes("b.txt"));
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(wsDir, { recursive: true, force: true });
  }
});

test("workspace with no commit of its own: --last refuses instead of reaching into base", async () => {
  const store = await mk();
  try {
    const repo = await Repo.init(store);
    await writeFile(join(store, "a.txt"), "a\n");
    await repo.commitWorkingTree(store, { message: "base A", actor: dev });
    await assert.rejects(
      repo.undo({ last: true, workspace: "empty", by: dev.id }),
      /no commit of its own left to undo/,
    );
    assert.deepEqual([...(await repo.materialize("main")).tree.keys()], ["a.txt"], "base was not touched");
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("line: --last undoes the line's own last commit, not an inherited base op", async () => {
  const store = await mk();
  const lineDir = await mk();
  try {
    const repo = await Repo.init(store);
    await writeFile(join(store, "a.txt"), "a\n");
    const baseA = await repo.commitWorkingTree(store, { message: "base A", actor: dev });
    await repo.createLine("feat");
    await repo.checkoutInto(lineDir, "feat");
    await writeFile(join(lineDir, "l.txt"), "l\n");
    const onLine = await repo.commitWorkingTree(lineDir, { message: "line L", actor: dev, line: "feat" });

    const r = await repo.undo({ last: true, view: "feat", by: dev.id });
    assert.deepEqual([...r.excluded].sort(), [...onLine.ops].sort());
    assert.ok(!r.excluded.some((o) => baseA.ops.includes(o)), "the inherited base op is not a candidate");

    // Nothing else on the line → refuse rather than undo the inherited base op.
    await assert.rejects(repo.undo({ last: true, view: "feat", by: dev.id }), /line feat has no commit of its own/);
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(lineDir, { recursive: true, force: true });
  }
});

test("base: --last still walks base's own commits (unchanged behaviour)", async () => {
  const store = await mk();
  try {
    const repo = await Repo.init(store);
    await writeFile(join(store, "a.txt"), "a\n");
    const c1 = await repo.commitWorkingTree(store, { message: "one", actor: dev });
    await writeFile(join(store, "b.txt"), "b\n");
    const c2 = await repo.commitWorkingTree(store, { message: "two", actor: dev });
    assert.deepEqual([...(await repo.undo({ last: true, by: dev.id })).excluded].sort(), [...c2.ops].sort());
    assert.deepEqual([...(await repo.undo({ last: true, by: dev.id })).excluded].sort(), [...c1.ops].sort());
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});
