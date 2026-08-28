// Local undo (issue #91): the pre-share escape hatch for a mistaken commit.
//
// `redact` is the SHARED case — admin-gated, because evicting bytes another holder
// already has is a governance act. This is the other case: nothing has left this
// machine, so the only person the eviction can hurt is the one asking for it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { decodeCbor } from "../src/core/cbor.ts";
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
const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const SECRET = "AWS_SECRET_ACCESS_KEY=SUPERSECRET123\n";
/** True when `git <a…>` exits non-zero — the shape a "the object is gone" probe needs. */
const gitFails = (cwd: string, ...a: string[]): boolean => {
  try { execFileSync("git", a, { cwd, stdio: "ignore" }); return false; } catch { return true; }
};
/** True when any byte under `.avcs/` still contains `needle` (the eviction's own proof). */
const grepAvcs = (cwd: string, needle: string): boolean =>
  spawnSync("grep", ["-rq", needle, ".avcs"], { cwd }).status === 0;

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

  // The standalone message must stay clean: no caution about a tool that is not here.
  assert.doesNotMatch(out, /git/i, "no git bridge ⇒ nothing to say about git");

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

test("a later op carrying the secret forward keeps it in the tree — undo both, and --purge says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-undo-"));
  const repo = await Repo.init(dir);
  await writeFile(join(dir, ".env"), SECRET, "utf8");
  const c1 = await repo.commitWorkingTree(dir, { message: "leak", actor: dev });
  await writeFile(join(dir, ".env"), SECRET + "PORT=3000\n", "utf8");
  const c2 = await repo.commitWorkingTree(dir, { message: "add port", actor: dev });

  // Undoing only the op that INTRODUCED the secret is not enough: the later edit's own
  // content still carries it, and that op is still selected.
  const partial = await repo.undo({ ops: c1.ops, purge: true, by: dev.id });
  assert.deepEqual(partial.purged, [], "nothing evicted — the later edit needs it as its base");
  assert.equal(partial.retained.length, 1, "and --purge reports that it kept it");
  const mid = await repo.materialize();
  assert.ok(mid.tree.has(".env"));
  assert.match((await repo.materializedFiles(mid)).find((f) => f.path === ".env")!.content, /SUPERSECRET123/);

  // Naming EVERY op that carries the content does the job: with both in the target set,
  // neither protects the other's blob any more. Naming only the later one would leave the
  // earlier blob alive — purge is relative to the target set, deliberately and visibly.
  assert.deepEqual((await repo.undo({ ops: c2.ops, purge: true, by: dev.id })).purged.length, 1);
  const full = await repo.undo({ ops: [...c1.ops, ...c2.ops], purge: true, by: dev.id });
  assert.equal(full.purged.length, 1, "the earlier blob, now that nothing else claims it");
  assert.ok(!(await repo.materialize()).tree.has(".env"));
  for (const b of [...full.purged, ...partial.retained]) {
    assert.doesNotMatch((await repo.readBlob(b)).toString("utf8"), /SUPERSECRET123/, "every copy is gone");
  }
  await rm(dir, { recursive: true, force: true });
});

/** Every byte a persisted compaction snapshot holds as merged content (`synthBlobs`). */
async function snapshotBytes(dir: string, view = "main"): Promise<Buffer[] | null> {
  const p = join(dir, ".avcs", "snapshot", `${view}.cbor`);
  if (!existsSync(p)) return null;
  const raw = decodeCbor(await readFile(p)) as { snapshot: { result: { synthBlobs: [string, Record<string, number>][] } } };
  return raw.snapshot.result.synthBlobs.map(([, bytes]) => Buffer.from(Object.values(bytes)));
}

test("--purge also scrubs the derived copies: a persisted snapshot holds merged CONTENT", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-undo-"));
  const repo = await Repo.init(dir);
  // Two concurrent disjoint edits over one base ⇒ the tree content is a MERGE result, which
  // the reducer keeps as a synthetic blob — bytes, not an oid.
  const intent = await repo.createIntent({ title: "t", owner: dev.id });
  const sess = await repo.startSession({ intentOid: intent, actor: dev });
  const seed = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: dev, path: ".env", content: SECRET + "B\nC\n", declaredPurpose: "seed" });
  const baseBlob = (await repo.materialize()).tree.get(".env") as string;
  const e1 = await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: dev, path: ".env", newText: SECRET + "B1\nC\n", baseBlobOid: baseBlob, declaredPurpose: "b", causalDeps: [seed] });
  const e2 = await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: dev, path: ".env", newText: SECRET + "B\nC2\n", baseBlobOid: baseBlob, declaredPurpose: "c", causalDeps: [seed] });
  await repo.compact("main");

  const before = await snapshotBytes(dir);
  assert.ok(before?.some((b) => b.includes("SUPERSECRET123")), "the hazard: the snapshot holds the merged plaintext");

  await repo.undo({ ops: [seed, e1, e2], purge: true, by: dev.id });
  assert.equal(await snapshotBytes(dir), null, "the snapshot the eviction invalidated is gone, plaintext with it");
  // …and the repo still works: the cache was rebuildable, that was the whole point.
  assert.equal((await repo.materialize()).tree.size, 0);
  await rm(dir, { recursive: true, force: true });
});

// ── the git plane (docs/23 §3.1) ───────────────────────────────────────────────
//
// `undo --purge` used to stop at the AVCS store and merely NAME git's surviving copy. It
// no longer does: a command that says "bytes evicted, not recoverable" while the secret
// sits in a git object is a trap, and handing the user `filter-repo` gives back the hardest
// part of the job. So `--purge` finishes the job in git too — but ONLY when it can prove
// doing so is safe and local, and it says exactly what is left when it cannot.

/** A git repo with the avcs bridge hooks installed, so `git commit` ingests into AVCS. */
async function bridged(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-undo-git-"));
  git(dir, "init", "-q", ".");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  avcs(dir, "init", ".");
  return dir;
}

/** Commit `files` through git, so both planes record it. */
async function gitCommit(dir: string, message: string, files: Record<string, string>): Promise<string> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), content, "utf8");
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

// NOT `.env` anywhere below: a global gitignore commonly ignores it, which would make git
// stage nothing and these tests silently prove nothing. An ordinary source filename is
// always tracked.
const GSECRET = "GITMODE456SECRET";
const LEAK = `export const TOKEN = "${GSECRET}"\n`;

test("undo --last --purge clears the secret from BOTH planes (the whole point)", { skip: !hasGit }, async () => {
  const dir = await bridged();
  await gitCommit(dir, "ok", { "app.ts": "export const v = 1\n" });
  const bad = await gitCommit(dir, "oops", { "src/config.ts": LEAK });

  const out = avcs(dir, "undo", "--last", "--purge", "--reason", "hardcoded token");
  assert.match(out, /purged 1 blob/);

  // ① the AVCS plane: no byte of it anywhere under .avcs/
  assert.equal(grepAvcs(dir, GSECRET), false, "no copy left in .avcs/");
  // ② the git plane: the pickaxe finds nothing, and the object is really gone (not merely
  //    unreachable — the reflog and a lost-found fsck would still hand it back).
  assert.equal(git(dir, "log", "--all", "-S", GSECRET, "--oneline"), "", "git holds no commit with it");
  assert.equal(gitFails(dir, "cat-file", "-e", `${bad}^{commit}`), true, "the commit object is pruned");
  // ③ the earlier legitimate commit survives in both planes
  assert.match(git(dir, "log", "--oneline"), /ok$/m);
  assert.ok((await (await Repo.open(dir)).materialize()).tree.has("app.ts"), "avcs kept the good commit");

  await rm(dir, { recursive: true, force: true });
});
