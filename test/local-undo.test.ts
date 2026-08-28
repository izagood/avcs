// Local undo (issue #91): the pre-share escape hatch for a mistaken commit.
//
// `redact` is the SHARED case — admin-gated, because evicting bytes another holder
// already has is a governance act. This is the other case: nothing has left this
// machine, so the only person the eviction can hurt is the one asking for it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor, Operation } from "../src/objects/types.ts";

const dev: Actor = { kind: "human", id: "human:dev" };
const SECRET = "AWS_SECRET_ACCESS_KEY=SUPERSECRET123\n";

/** The issue's repro: one legitimate commit, then one that slipped `.env` in. */
async function repoWithLeak(): Promise<{
  dir: string;
  repo: Repo;
  bad: string[];
  secretBlob: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-undo-"));
  const repo = await Repo.init(dir);
  await writeFile(join(dir, "app.ts"), "export const v = 1\n", "utf8");
  await repo.commitWorkingTree(dir, { message: "ok", actor: dev });
  await writeFile(join(dir, ".env"), SECRET, "utf8");
  const bad = await repo.commitWorkingTree(dir, { message: "oops", actor: dev });
  const op = await repo.store.get<Operation>(bad.ops[0] as string);
  return { dir, repo, bad: bad.ops, secretBlob: op.body.blobOid as string };
}

test("undo drops the ops from the projection but keeps the bytes (reversible)", async () => {
  const { dir, repo, bad, secretBlob } = await repoWithLeak();
  assert.ok((await repo.materialize()).tree.has(".env"), "the leak is in the tree to begin with");

  const r = await repo.undo({ ops: bad, by: dev.id, reason: "committed .env by mistake" });
  assert.deepEqual(r.excluded, bad, "the named ops left the view");
  assert.deepEqual(r.purged, [], "no --purge ⇒ no byte eviction");

  const after = await repo.materialize();
  assert.ok(!after.tree.has(".env"), ".env is gone from the projection");
  assert.ok(after.tree.has("app.ts"), "the earlier legitimate commit is untouched");
  // Reversible: the ops and their bytes are still there, so re-including them restores.
  assert.match((await repo.readBlob(secretBlob)).toString("utf8"), /SUPERSECRET123/);
  await rm(dir, { recursive: true, force: true });
});

test("undoing already-undone ops is idempotent, not an error", async () => {
  const { dir, repo, bad } = await repoWithLeak();
  await repo.undo({ ops: bad, by: dev.id });
  const again = await repo.undo({ ops: bad, by: dev.id });
  assert.deepEqual(again.excluded, [], "nothing new to exclude");
  assert.deepEqual(again.alreadyExcluded, bad);
  assert.equal(again.undoOid, null, "a no-op authors no record");
  assert.ok(!(await repo.materialize()).tree.has(".env"), "still undone");
  await rm(dir, { recursive: true, force: true });
});

test("the undo is recorded as a first-class, queryable object", async () => {
  const { dir, repo, bad } = await repoWithLeak();
  const r = await repo.undo({ ops: bad, by: dev.id, reason: "committed .env by mistake" });

  const undos = await repo.listUndos();
  assert.equal(undos.length, 1);
  const u = undos[0]!;
  assert.equal(u.oid, r.undoOid);
  assert.equal(u.type, "undo");
  assert.equal(u.view, "main");
  assert.deepEqual(u.ops, bad);
  assert.equal(u.by, dev.id);
  assert.equal(u.reason, "committed .env by mistake");
  assert.equal(u.purged, undefined, "no --purge ⇒ nothing recorded as evicted");
  assert.ok(u.createdAt);
  await rm(dir, { recursive: true, force: true });
});
