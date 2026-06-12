// Hardening (docs/10 WS-F): git import (existing tree → ops) + bundle backup/restore.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const dev: Actor = { kind: "human", id: "human:dev" };

test("import an existing tree (skipping .git/.avcs) as ops", async () => {
  const src = await mkdtemp(join(tmpdir(), "src-"));
  await mkdir(join(src, ".git"), { recursive: true });
  await writeFile(join(src, ".git/config"), "ignore me", "utf8");
  await mkdir(join(src, "src"), { recursive: true });
  await writeFile(join(src, "src/a.ts"), "export const a = 1\n", "utf8");
  await writeFile(join(src, "README.md"), "# proj\n", "utf8");

  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const r = await repo.commitWorkingTree(src, { message: "import", actor: dev });
  assert.deepEqual(r.added, ["README.md", "src/a.ts"], ".git skipped");
  const files = (await repo.materializedFiles(await repo.materialize())).map((f) => f.path).sort();
  assert.deepEqual(files, ["README.md", "src/a.ts"]);
  await rm(src, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

test("bundle export/import round-trips the whole repo", async () => {
  const a = await mkdtemp(join(tmpdir(), "avcs-a-"));
  const repo = await Repo.init(a);
  const intent = await repo.createIntent({ title: "t", owner: dev.id });
  const sess = await repo.startSession({ intentOid: intent, actor: dev });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: dev, path: "x.ts", content: "1\n", declaredPurpose: "x" });
  const treeHash = (await repo.materialize()).treeHash;
  const bundle = await repo.exportBundle();
  assert.ok(bundle.objects.length > 0);

  const b = await mkdtemp(join(tmpdir(), "avcs-b-"));
  const restored = await Repo.init(b);
  const imp = await restored.importBundle(bundle);
  assert.equal(imp.objects, bundle.objects.length);
  assert.equal((await restored.materialize()).treeHash, treeHash, "restored repo materializes identically");
  // entity index was rebuilt → blame/history work
  assert.equal((await restored.historyOf("file:x.ts")).length, 1);
  await rm(a, { recursive: true, force: true });
  await rm(b, { recursive: true, force: true });
});
