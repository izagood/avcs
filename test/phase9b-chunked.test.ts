// Phase 9b: large blobs are chunked + deduped; reads round-trip exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Blob } from "../src/objects/types.ts";

test("a large blob is stored chunked and round-trips byte-for-byte", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const big = "A".repeat(700 * 1024) + "Z"; // > threshold
  const oid = await repo.putBlob(big);
  const manifest = await repo.store.get<Blob>(oid);
  assert.equal(manifest.chunked, true);
  assert.ok((manifest.chunks?.length ?? 0) >= 10, "split into many chunks");
  assert.equal((await repo.readBlob(oid)).toString("utf8"), big, "exact round-trip");
  await rm(dir, { recursive: true, force: true });
});

test("small blobs stay inline (unchanged)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const oid = await repo.putBlob("hello");
  assert.equal((await repo.store.get<Blob>(oid)).chunked, undefined);
  assert.equal((await repo.readBlob(oid)).toString("utf8"), "hello");
  await rm(dir, { recursive: true, force: true });
});

test("identical chunks dedup (shared content stored once)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const a = "X".repeat(600 * 1024);
  const o1 = await repo.putBlob(a);
  const o2 = await repo.putBlob(a + "tail");
  const m1 = await repo.store.get<Blob>(o1);
  const m2 = await repo.store.get<Blob>(o2);
  // the all-X chunks are shared between the two manifests
  const shared = (m1.chunks ?? []).filter((c) => (m2.chunks ?? []).includes(c));
  assert.ok(shared.length >= 9, "common chunks are the same oids (deduped)");
  await rm(dir, { recursive: true, force: true });
});
