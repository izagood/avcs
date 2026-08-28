// Local undo (issue #91): the pre-share escape hatch for a mistaken commit.
//
// `redact` is the SHARED case — admin-gated, because evicting bytes another holder
// already has is a governance act. This is the other case: nothing has left this
// machine, so the only person the eviction can hurt is the one asking for it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { pushToHub } from "../src/hub/hubClient.ts";
import type { Actor, Operation } from "../src/objects/types.ts";

const dev: Actor = { kind: "human", id: "human:dev" };
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const avcs = (cwd: string, ...a: string[]): string =>
  execFileSync(process.execPath, ["--experimental-strip-types", CLI, ...a], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
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

test("undo --purge evicts the leaked bytes; the earlier commit still projects (issue #91 repro)", async () => {
  const { dir, repo, bad, secretBlob } = await repoWithLeak();

  const r = await repo.undo({ ops: bad, purge: true, by: dev.id, reason: "leaked AWS key" });
  assert.deepEqual(r.purged, [secretBlob], "the blob the bad op uniquely referenced");
  assert.deepEqual(r.retained, []);

  // The bytes are gone — this is the assertion the issue is about.
  assert.doesNotMatch((await repo.readBlob(secretBlob)).toString("utf8"), /SUPERSECRET123/);
  assert.match((await repo.readBlob(secretBlob)).toString("utf8"), /PURGED/);

  // …and the repo is still a working repo.
  const after = await repo.materialize();
  assert.ok(!after.tree.has(".env"));
  assert.equal((await repo.materializedFiles(after)).find((f) => f.path === "app.ts")?.content, "export const v = 1\n");
  await rm(dir, { recursive: true, force: true });
});

test("--purge spares a blob a still-selected op references (content-addressing shares blobs)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-undo-"));
  const repo = await Repo.init(dir);
  // Same bytes committed twice ⇒ ONE blob, referenced by two ops.
  await writeFile(join(dir, "keep.env"), SECRET, "utf8");
  await repo.commitWorkingTree(dir, { message: "keep", actor: dev });
  await writeFile(join(dir, ".env"), SECRET, "utf8");
  const bad = await repo.commitWorkingTree(dir, { message: "oops", actor: dev });
  const blob = (await repo.store.get<Operation>(bad.ops[0] as string)).body.blobOid as string;
  assert.equal((await repo.materialize()).tree.get("keep.env"), blob, "one blob, two ops");

  const r = await repo.undo({ ops: bad.ops, purge: true, by: dev.id });
  assert.deepEqual(r.purged, [], "not uniquely referenced ⇒ not evicted");
  assert.deepEqual(r.retained, [blob]);
  assert.match((await repo.readBlob(blob)).toString("utf8"), /SUPERSECRET123/, "keep.env still needs it");
  const after = await repo.materialize();
  assert.ok(!after.tree.has(".env"));
  assert.equal((await repo.materializedFiles(after)).find((f) => f.path === "keep.env")?.content, SECRET);
  await rm(dir, { recursive: true, force: true });
});

test("--purge spares a blob a remaining edit still needs as its 3-way merge base", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-undo-"));
  const repo = await Repo.init(dir);
  await writeFile(join(dir, "x.ts"), "v1\n", "utf8");
  const first = await repo.commitWorkingTree(dir, { message: "one", actor: dev });
  await writeFile(join(dir, "x.ts"), "v2\n", "utf8");
  const second = await repo.commitWorkingTree(dir, { message: "two", actor: dev });
  const v1 = (await repo.store.get<Operation>(first.ops[0] as string)).body.blobOid as string;
  assert.equal((await repo.store.get<Operation>(second.ops[0] as string)).body.baseBlobOid, v1);

  const r = await repo.undo({ ops: first.ops, purge: true, by: dev.id });
  assert.deepEqual(r.purged, [], "the later edit's merge base must survive");
  assert.deepEqual(r.retained, [v1]);
  assert.equal((await repo.readBlob(v1)).toString("utf8"), "v1\n");
  await rm(dir, { recursive: true, force: true });
});

test("--purge after a plain undo still evicts; a second --purge is a no-op", async () => {
  const { dir, repo, bad, secretBlob } = await repoWithLeak();
  await repo.undo({ ops: bad, by: dev.id });
  const purged = await repo.undo({ ops: bad, purge: true, by: dev.id, reason: "on reflection, evict it" });
  assert.deepEqual(purged.excluded, [], "already excluded");
  assert.deepEqual(purged.purged, [secretBlob], "but the bytes had not been evicted yet");
  assert.ok(purged.undoOid, "an eviction is always recorded");
  const rec = (await repo.listUndos()).find((u) => u.oid === purged.undoOid)!;
  assert.deepEqual(rec.purged, [secretBlob]);

  const again = await repo.undo({ ops: bad, purge: true, by: dev.id });
  assert.deepEqual(again.purged, []);
  assert.equal(again.undoOid, null, "nothing left to do ⇒ no record");
  await rm(dir, { recursive: true, force: true });
});

test("undo refuses ops that have already been pushed, and names redact as the answer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-undo-"));
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-hub-"));
  const repo = await Repo.init(dir);
  await writeFile(join(dir, "app.ts"), "export const v = 1\n", "utf8");
  const shared = await repo.commitWorkingTree(dir, { message: "ok", actor: dev });

  const hub = await startHub({ repoDir: hubDir, port: 0 });
  try {
    await pushToHub(dir, hub.url);
    // Committed AFTER the push ⇒ still local, still undoable.
    await writeFile(join(dir, ".env"), SECRET, "utf8");
    const bad = await repo.commitWorkingTree(dir, { message: "oops", actor: dev });

    assert.deepEqual((await repo.pushedOps()).get(shared.ops[0] as string), [hub.url.replace(/\/$/, "")]);
    await assert.rejects(
      () => repo.undo({ ops: shared.ops, by: dev.id }),
      (e: Error) => /already been pushed/.test(e.message) && /redact/.test(e.message),
      "a replicated op is a governance problem, not a local one",
    );
    // The unpushed one is untouched by the refusal.
    const r = await repo.undo({ ops: bad.ops, purge: true, by: dev.id });
    assert.equal(r.purged.length, 1);
  } finally {
    await hub.close();
  }
  await rm(dir, { recursive: true, force: true });
  await rm(hubDir, { recursive: true, force: true });
});

test("--last targets exactly the ops of the most recent commit, and walks back on repeat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-undo-"));
  const repo = await Repo.init(dir);
  await writeFile(join(dir, "a.ts"), "a\n", "utf8");
  const c1 = await repo.commitWorkingTree(dir, { message: "one", actor: dev });
  await writeFile(join(dir, "b.ts"), "b\n", "utf8");
  await writeFile(join(dir, "c.ts"), "c\n", "utf8");
  const c2 = await repo.commitWorkingTree(dir, { message: "two", actor: dev });
  assert.equal(c2.ops.length, 2, "a commit of two files is two ops in one session");

  const r = await repo.undo({ last: true, by: dev.id });
  assert.deepEqual([...r.excluded].sort(), [...c2.ops].sort(), "both ops of the last commit, no more");
  assert.deepEqual([...(await repo.materialize()).tree.keys()].sort(), ["a.ts"]);

  // Repeating walks back to the commit before it — the last one is no longer selected.
  const r2 = await repo.undo({ last: true, by: dev.id });
  assert.deepEqual([...r2.excluded].sort(), [...c1.ops].sort());
  assert.equal((await repo.materialize()).tree.size, 0);
  await rm(dir, { recursive: true, force: true });
});

test("--last and explicit oids are mutually exclusive", async () => {
  const { dir, repo, bad } = await repoWithLeak();
  await assert.rejects(() => repo.undo({ last: true, ops: bad, by: dev.id }), /either --last or explicit op oids/);
  await rm(dir, { recursive: true, force: true });
});

test("avcs undo --last --purge: the whole repro from the command line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-undo-"));
  const repo = await Repo.init(dir);
  await writeFile(join(dir, "app.ts"), "export const v = 1\n", "utf8");
  avcs(dir, "commit", "-m", "ok");
  await writeFile(join(dir, ".env"), SECRET, "utf8");
  avcs(dir, "commit", "-m", "wip");
  const leaked = (await repo.materialize()).tree.get(".env") as string;
  assert.match((await repo.readBlob(leaked)).toString("utf8"), /SUPERSECRET123/);

  const out = avcs(dir, "undo", "--last", "--purge", "--reason", "committed .env by mistake");
  assert.match(out, /purged 1 blob/);

  // Re-open: the CLI ran in another process, so this process's warm caches know nothing.
  const fresh = await Repo.open(dir);
  assert.doesNotMatch((await fresh.readBlob(leaked)).toString("utf8"), /SUPERSECRET123/, "bytes evicted");
  assert.ok(!(await fresh.materialize()).tree.has(".env"));
  assert.ok((await fresh.materialize()).tree.has("app.ts"), "the earlier commit survives");
  assert.equal((await fresh.listUndos()).length, 1, "the CLI path records the undo too");
  assert.equal((await fresh.listUndos())[0]?.reason, "committed .env by mistake");

  // `--reason <text>` must not be mistaken for an op oid.
  assert.match(avcs(dir, "undo", "--last", "--reason", "nope"), /undid 1 op/);
  await rm(dir, { recursive: true, force: true });
});

test("avcs undo needs a target", () => {
  const dir = mkdtempSync(join(tmpdir(), "avcs-undo-"));
  avcs(dir, "init");
  const r = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "undo"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /name the op oids, or pass --last/);
  rmSync(dir, { recursive: true, force: true });
});
