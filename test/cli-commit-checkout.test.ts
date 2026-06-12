// git-like working-tree round trip: edit files → commit (=ops) → checkout reproduces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const dev: Actor = { kind: "human", id: "human:dev" };

test("commit authors ops for working-tree changes; checkout reproduces them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);

  // edit working tree, commit
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/app.ts"), "export const v = 1\n", "utf8");
  await writeFile(join(dir, "README.md"), "# hi\n", "utf8");
  let r = await repo.commitWorkingTree(dir, { message: "init", actor: dev });
  assert.deepEqual(r.added, ["README.md", "src/app.ts"]);
  assert.equal(r.ops.length, 2);

  // materialize matches the working tree
  const files = (await repo.materializedFiles(await repo.materialize())).map((f) => f.path).sort();
  assert.deepEqual(files, ["README.md", "src/app.ts"]);

  // modify + delete, commit again
  await writeFile(join(dir, "src/app.ts"), "export const v = 2\n", "utf8");
  await unlink(join(dir, "README.md"));
  r = await repo.commitWorkingTree(dir, { message: "update", actor: dev });
  assert.deepEqual(r.modified, ["src/app.ts"]);
  assert.deepEqual(r.removed, ["README.md"]);

  // a fresh checkout into a clean dir reproduces the latest state
  const work2 = await mkdtemp(join(tmpdir(), "avcs-wt-"));
  const written = await repo.checkoutInto(work2, "main");
  assert.deepEqual(written, ["src/app.ts"], "README deleted, app present");
  assert.match(await readFile(join(work2, "src/app.ts"), "utf8"), /v = 2/);

  // nothing to commit when the tree matches
  const noop = await repo.commitWorkingTree(work2, { message: "x", actor: dev });
  assert.equal(noop.ops.length, 0);
  await rm(dir, { recursive: true, force: true });
  await rm(work2, { recursive: true, force: true });
});
