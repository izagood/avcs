// docs/16 — workspace scope: physical isolation for build/verify. A base-line view
// EXCLUDES workspace-tagged ops; each workspace view sees base ops + only its own.
// (land — promoting a workspace's ops onto its base — is a later slice.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const A: Actor = { kind: "ai_agent", id: "ai:a" };
const mk = () => mkdtemp(join(tmpdir(), "avcs-ws-"));

test("workspace isolation: base view excludes workspace ops; each workspace view sees only its own (docs/16)", async () => {
  const dir = await mk();
  const repo = await Repo.init(dir);
  try {
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: A });

    // a base op (no workspace) + two workspaces editing the SAME file differently
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: A, path: "shared.ts", content: "base\n", declaredPurpose: "base file" });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: A, path: "f.ts", content: "from A\n", declaredPurpose: "A work", workspace: "wsA" });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: A, path: "f.ts", content: "from B\n", declaredPurpose: "B work", workspace: "wsB" });

    const filesOf = async (opts?: { workspace?: string }) =>
      (await repo.materializedFiles(await repo.materialize("main", opts))).map((f) => f.path).sort();
    const contentOf = async (path: string, opts?: { workspace?: string }) =>
      (await repo.materializedFiles(await repo.materialize("main", opts))).find((f) => f.path === path)?.content;

    // base view: only the base op — both workspaces are isolated out
    assert.deepEqual(await filesOf(), ["shared.ts"]);

    // workspace A view: base + A's op, never B's
    assert.deepEqual(await filesOf({ workspace: "wsA" }), ["f.ts", "shared.ts"]);
    assert.equal(await contentOf("f.ts", { workspace: "wsA" }), "from A\n");

    // workspace B view: base + B's op
    assert.deepEqual(await filesOf({ workspace: "wsB" }), ["f.ts", "shared.ts"]);
    assert.equal(await contentOf("f.ts", { workspace: "wsB" }), "from B\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent same-file workspaces are isolated, not merged — no conflict surfaced (docs/16)", async () => {
  const dir = await mk();
  const repo = await Repo.init(dir);
  try {
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: A });
    // Same file, same line, two workspaces — without isolation these would contend.
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: A, path: "f.ts", content: "A\n", declaredPurpose: "A", workspace: "wsA" });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: A, path: "f.ts", content: "B\n", declaredPurpose: "B", workspace: "wsB" });

    const rA = await repo.materialize("main", { workspace: "wsA" });
    const rB = await repo.materialize("main", { workspace: "wsB" });
    assert.equal(rA.conflicts.length, 0, "workspace A view is clean");
    assert.equal(rB.conflicts.length, 0, "workspace B view is clean");
    // base view sees neither, so the concurrent same-file writes never collide there
    const base = await repo.materialize("main");
    assert.equal(base.conflicts.length, 0, "base view has no workspace ops, no collision");
    assert.equal(base.tree.size, 0, "base tree is empty (both ops are workspace-isolated)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("land promotes a workspace's ops onto the base view (docs/16)", async () => {
  const dir = await mk();
  const repo = await Repo.init(dir);
  try {
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: A });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: A, path: "f.ts", content: "from A\n", declaredPurpose: "A", workspace: "wsA" });

    const baseFiles = async () => (await repo.materializedFiles(await repo.materialize("main"))).map((f) => f.path);

    // before land: base view excludes the workspace op
    assert.deepEqual(await baseFiles(), []);
    assert.deepEqual(await repo.landedWorkspaces(), []);

    // land → base view now includes it; landed set reflects it; idempotent
    await repo.landWorkspace("wsA");
    await repo.landWorkspace("wsA"); // idempotent
    assert.deepEqual(await repo.landedWorkspaces(), ["wsA"]);
    const files = await repo.materializedFiles(await repo.materialize("main"));
    assert.deepEqual(files.map((f) => f.path), ["f.ts"]);
    assert.equal(files.find((f) => f.path === "f.ts")?.content, "from A\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two landed workspaces with disjoint edits auto-merge on base — no rebase (docs/16)", async () => {
  const dir = await mk();
  const repo = await Repo.init(dir);
  try {
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: A });
    const base = "alpha\nbeta\ngamma\n";
    const scaffold = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: A, path: "m.ts", content: base, declaredPurpose: "scaffold" });
    // two workspaces edit disjoint lines off the same base
    await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: A, path: "m.ts", baseText: base, newText: "ALPHA\nbeta\ngamma\n", causalDeps: [scaffold], declaredPurpose: "A", workspace: "wsA" });
    await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: A, path: "m.ts", baseText: base, newText: "alpha\nbeta\nGAMMA\n", causalDeps: [scaffold], declaredPurpose: "B", workspace: "wsB" });

    await repo.landWorkspace("wsA");
    await repo.landWorkspace("wsB");
    const res = await repo.materialize("main");
    assert.equal(res.conflicts.length, 0, "disjoint landed edits auto-merge, no conflict");
    const got = (await repo.materializedFiles(res)).find((f) => f.path === "m.ts")?.content;
    assert.equal(got, "ALPHA\nbeta\nGAMMA\n", "both landed edits survive the merge on base");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
