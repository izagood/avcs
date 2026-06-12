// The git-replacement workflow over a hub: dev authors + pushes; a fresh repo clones
// (init + pull) and sees the work. Mirrors `avcs serve` / `avcs push` / `avcs clone`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

test("serve + push + clone: a fresh repo clones a hub and sees the work", async () => {
  const centralDir = await mkdtemp(join(tmpdir(), "avcs-central-"));
  const devDir = await mkdtemp(join(tmpdir(), "avcs-dev-"));
  const cloneDir = await mkdtemp(join(tmpdir(), "avcs-clone-"));
  await Repo.init(centralDir);
  const hub = await startHub({ repoDir: centralDir, port: 0 });
  try {
    // dev repo authors a file and pushes to the hub
    const dev = await Repo.init(devDir);
    const intent = await dev.createIntent({ title: "feature", owner: "human:h" });
    const sess = await dev.startSession({ intentOid: intent, actor: ai });
    await dev.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "src/app.ts", content: "export const v = 1\n", declaredPurpose: "app" });
    const pushed = await dev.pushHub(hub.url);
    assert.ok(pushed.pushed > 0);

    // clone = a brand-new repo that pulls everything from the hub
    const cloned = await Repo.init(cloneDir);
    await cloned.pullHub(hub.url);
    const files = (await cloned.materializedFiles(await cloned.materialize())).map((f) => f.path);
    assert.deepEqual(files, ["src/app.ts"], "clone sees the pushed work");
    assert.equal((await cloned.materialize()).treeHash, (await dev.materialize()).treeHash, "clone converges with dev");
  } finally {
    await hub.close();
    await Promise.all([centralDir, devDir, cloneDir].map((d) => rm(d, { recursive: true, force: true })));
  }
});
