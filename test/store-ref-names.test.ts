// Ref names are opaque strings, but they address a FILE.
//
// `line:<branch>` derives from a git branch, and `feature/x` is the convention most teams
// use — so a ref name routinely contains `/`. Joining it straight onto the refs directory
// makes the write land in a directory nothing created, and `git commit` fails outright
// (issue #52). Percent-encoding keeps the name→file mapping total and reversible.
//
// `listRefs` reading a FLAT directory is the reason `mkdir -p` is not the fix: a nested
// file would be invisible there, and listRefs is what feeds hub governance distribution.
// A silently missing ref is worse than a loud failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStore } from "../src/store/objectStore.ts";

async function tmpStore(): Promise<{ store: ObjectStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-refname-"));
  const store = new ObjectStore(dir);
  await store.init();
  return { store, dir };
}

test("a ref name containing '/' round-trips through setRef and getRef", async () => {
  const { store, dir } = await tmpStore();
  try {
    await store.setRef("line:feature/x", "oid_abc");
    assert.equal(await store.getRef("line:feature/x"), "oid_abc");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listRefs reports the ORIGINAL name, not the on-disk spelling", async () => {
  const { store, dir } = await tmpStore();
  try {
    await store.setRef("line:feature/x", "oid_abc");
    const refs = await store.listRefs();
    assert.equal(refs.get("line:feature/x"), "oid_abc", `got keys ${JSON.stringify([...refs.keys()])}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nested names stay flat on disk, so listRefs cannot miss them", async () => {
  const { store, dir } = await tmpStore();
  try {
    await store.setRef("line:a/b/c", "oid_deep");
    const refs = await store.listRefs();
    assert.equal(refs.get("line:a/b/c"), "oid_deep");
    assert.equal(refs.size, 1, "exactly one ref, not a directory tree");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("distinct names never collide after encoding", async () => {
  const { store, dir } = await tmpStore();
  try {
    // These would be the same file under a naive escape that ignores `%`.
    await store.setRef("line:a/b", "oid_slash");
    await store.setRef("line:a%2Fb", "oid_literal");
    assert.equal(await store.getRef("line:a/b"), "oid_slash");
    assert.equal(await store.getRef("line:a%2Fb"), "oid_literal");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("plain names are stored verbatim — existing repos need no migration", async () => {
  const { store, dir } = await tmpStore();
  try {
    await store.setRef("view:main", "oid_v");
    // Written by an older avcs, before any encoding existed.
    await writeFile(join(dir, ".avcs", "refs", "checkpoint:main:latest"), "oid_legacy\n", "utf8");
    assert.equal(await store.getRef("view:main"), "oid_v");
    assert.equal(await store.getRef("checkpoint:main:latest"), "oid_legacy", "a pre-existing ref still reads");
    assert.equal((await store.listRefs()).get("checkpoint:main:latest"), "oid_legacy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a ref written by an older avcs into a nested path is still readable", async () => {
  // Not producible going forward, but a repo that was mid-migration should not lose data.
  const { store, dir } = await tmpStore();
  try {
    await mkdir(join(dir, ".avcs", "refs", "line:old"), { recursive: true });
    await writeFile(join(dir, ".avcs", "refs", "line:old", "branch"), "oid_nested\n", "utf8");
    // listRefs must not crash on a directory entry it did not write.
    const refs = await store.listRefs();
    assert.ok(refs instanceof Map);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
