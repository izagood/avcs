// A linked working tree gets no `.avcs` of its own: the store lives in the main checkout
// and nothing above the linked tree points at it, so every entry point that resolves a
// store by walking upward comes up empty there. These tests pin the fix — a `.avcs`
// *pointer file* naming the store, resolved by the one place that computes the store path,
// with no git anywhere in the picture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStore } from "../src/store/objectStore.ts";
import { Repo } from "../src/api/repo.ts";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "avcs-wt-"));
}

test("a .avcs pointer file resolves to the store it names", async () => {
  const main = await tmp();
  await Repo.init(main);
  const linked = await tmp();
  await writeFile(join(linked, ".avcs"), `avcsdir: ${join(main, ".avcs")}\n`);

  assert.equal(ObjectStore.resolveStoreDir(linked), join(main, ".avcs"));
  assert.equal(ObjectStore.isRepo(linked), true);
  assert.equal(ObjectStore.findRepoRoot(linked), linked, "the working tree stays the repo root");
});

test("a pointer file may hold a path relative to itself", async () => {
  const base = await tmp();
  const main = join(base, "main");
  const linked = join(base, "linked");
  await mkdir(main, { recursive: true });
  await mkdir(linked, { recursive: true });
  await Repo.init(main);
  await writeFile(join(linked, ".avcs"), "avcsdir: ../main/.avcs\n");

  assert.equal(ObjectStore.resolveStoreDir(linked), join(main, ".avcs"));
  assert.equal(ObjectStore.isRepo(linked), true);
});

test("a repo opened through a pointer shares the store but keeps its own root", async () => {
  const main = await tmp();
  const repo = await Repo.init(main);
  await repo.createLine("feature-x");

  const linked = await tmp();
  await writeFile(join(linked, ".avcs"), `avcsdir: ${join(main, ".avcs")}\n`);
  const viaPointer = await Repo.open(linked);

  assert.ok(await viaPointer.store.getRef("view:feature-x"), "sees the main store's refs");
  assert.equal(viaPointer.store.root, join(main, ".avcs"), "store lives in the main checkout");
});

test("a malformed or dangling pointer is not a repo, and never throws", async () => {
  const linked = await tmp();
  await writeFile(join(linked, ".avcs"), "this is not a pointer\n");
  assert.equal(ObjectStore.isRepo(linked), false);

  const dangling = await tmp();
  await writeFile(join(dangling, ".avcs"), "avcsdir: /nope/does/not/exist/.avcs\n");
  assert.equal(ObjectStore.isRepo(dangling), false);
});

test("a plain repo directory is unaffected", async () => {
  const main = await tmp();
  await Repo.init(main);
  assert.equal(ObjectStore.resolveStoreDir(main), join(main, ".avcs"));
  assert.equal(ObjectStore.isRepo(main), true);
});
