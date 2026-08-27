// docs/20 §1.3 — a LANDED workspace's ops are base-accepted, so every view must see them,
// including another workspace's view. Before this fix a workspace view excluded every
// foreign workspace op regardless of landing, so workspace B kept working against a base
// that had already moved — the late-conflict-discovery this track exists to remove.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const A: Actor = { kind: "ai_agent", id: "ai:a" };
const mk = () => mkdtemp(join(tmpdir(), "avcs-wsland-"));

test("W5: a landed workspace's ops are visible from ANOTHER workspace's view (docs/20 §1.3)", async () => {
  const dir = await mk();
  const repo = await Repo.init(dir);
  try {
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: A });
    const propose = (path: string, content: string, workspace?: string) =>
      repo.proposeFileWrite({
        sessionOid: sess, intentOid: intent, actor: A, path, content,
        declaredPurpose: `write ${path}`, ...(workspace ? { workspace } : {}),
      });

    await propose("a.txt", "trunk\n");            // base op, no workspace tag
    await propose("b.txt", "from A\n", "wsA");
    await propose("c.txt", "from B\n", "wsB");

    const filesOf = async (workspace?: string) =>
      (await repo.materializedFiles(await repo.materialize("main", workspace ? { workspace } : undefined)))
        .map((f) => f.path)
        .sort();

    // Before landing: strict isolation both ways (unchanged behaviour).
    assert.deepEqual(await filesOf(), ["a.txt"], "base view sees neither workspace");
    assert.deepEqual(await filesOf("wsB"), ["a.txt", "c.txt"], "wsB sees base + its own");

    await repo.landWorkspace("wsA");

    // The point of the fix: wsA is now base-accepted, so wsB must see it.
    assert.deepEqual(
      await filesOf("wsB"),
      ["a.txt", "b.txt", "c.txt"],
      "wsB view = base + landed wsA + its own",
    );
    // Symmetry: the base view gained wsA and still excludes the unlanded wsB.
    assert.deepEqual(await filesOf(), ["a.txt", "b.txt"], "base view = base + landed wsA only");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("W5b: landing does not leak an unlanded workspace into a sibling workspace view", async () => {
  const dir = await mk();
  const repo = await Repo.init(dir);
  try {
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: A });
    const propose = (path: string, content: string, workspace?: string) =>
      repo.proposeFileWrite({
        sessionOid: sess, intentOid: intent, actor: A, path, content,
        declaredPurpose: `write ${path}`, ...(workspace ? { workspace } : {}),
      });
    await propose("a.txt", "trunk\n");
    await propose("b.txt", "from A\n", "wsA");
    await propose("c.txt", "from B\n", "wsB");
    await propose("d.txt", "from C\n", "wsC");

    await repo.landWorkspace("wsA");
    const files = (await repo.materializedFiles(await repo.materialize("main", { workspace: "wsB" })))
      .map((f) => f.path)
      .sort();
    // wsC never landed, so it stays invisible to wsB even though wsA became visible.
    assert.deepEqual(files, ["a.txt", "b.txt", "c.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
