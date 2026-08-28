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
  // `-b main` pins the branch name instead of inheriting it. `git init` takes the default
  // from `init.defaultBranch`, which is a machine setting: a dev box that set it to `main`
  // and a CI runner that never set it produce `main` and `master` respectively. The
  // assertions below quote the branch name back, so without this the suite passes locally
  // and fails in CI on a difference that has nothing to do with the behaviour under test.
  git(dir, "init", "-q", "-b", "main", ".");
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
  const repo = await Repo.open(dir);
  const tree = (await repo.materialize()).tree;
  assert.ok(tree.has("app.ts"), "avcs kept the good commit");
  // ④ the two planes agree with reality: the file is STILL ON DISK (the user has to fix it),
  //    and neither plane claims to hold it. `--mixed` never touched the working tree.
  assert.match(await readFile(join(dir, "src/config.ts"), "utf8"), new RegExp(GSECRET), "still on disk to fix");
  assert.ok(!tree.has("src/config.ts"), "the avcs view does not select it");
  assert.equal(git(dir, "status", "--porcelain", "--", "src"), "?? src/", "and git calls it untracked");
  assert.match(out, /still on disk and no longer tracked/, "and the output says so");

  await rm(dir, { recursive: true, force: true });
});

/** The op that wrote `path`, so a refusal can be provoked by naming ops explicitly —
 *  `--last` would name a different commit once later work sits on top. */
async function opFor(dir: string, path: string): Promise<string> {
  const repo = await Repo.open(dir);
  for (const op of await repo.store.collect<Operation>("operation")) {
    if ((op.body.path ?? op.target.entityId) === path) return op.oid as string;
  }
  throw new Error(`no op for ${path}`);
}

/** Every refusal below asserts the same two things: the AVCS side still COMPLETED (a refusal
 *  on the git plane must not cost the user the eviction they asked for), and the message
 *  names the remedy that actually fits their situation. */
const avcsSideDone = async (dir: string, out: string): Promise<void> => {
  assert.match(out, /purged 1 blob/, "the avcs side still ran");
  assert.equal(grepAvcs(dir, GSECRET), false, "and really evicted the bytes");
};

test("refuses a pushed commit — rotation is the remedy, never a force-push", { skip: !hasGit }, async () => {
  const dir = await bridged();
  await gitCommit(dir, "ok", { "app.ts": "export const v = 1\n" });
  await gitCommit(dir, "oops", { "src/config.ts": LEAK });
  const bare = await mkdtemp(join(tmpdir(), "avcs-undo-remote-"));
  git(bare, "init", "-q", "--bare", ".");
  git(dir, "remote", "add", "origin", bare);
  git(dir, "push", "-q", "-u", "origin", "HEAD:refs/heads/main");

  const out = avcs(dir, "undo", "--last", "--purge");
  await avcsSideDone(dir, out);
  assert.match(out, /did NOT remove them — the commit is already on a remote/);
  assert.match(out, /origin\/main/);
  assert.match(out, /ROTATE THE CREDENTIAL/);
  assert.match(out, /force-push/, "and says plainly that it will not do the theatre");
  assert.doesNotMatch(out, /--force/, "no force-push is ever offered, not even behind a flag");
  // The git plane is untouched: refusing means refusing, not half-doing it.
  assert.match(git(dir, "log", "--all", "-S", GSECRET, "--oneline"), /oops/);
  await rm(dir, { recursive: true, force: true });
  await rm(bare, { recursive: true, force: true });
});

test("refuses a secret buried under a later commit — filter-repo, not a reset", { skip: !hasGit }, async () => {
  const dir = await bridged();
  await gitCommit(dir, "oops", { "src/config.ts": LEAK });
  await gitCommit(dir, "later work", { "app.ts": "export const v = 1\n" });

  const out = avcs(dir, "undo", "--purge", await opFor(dir, "src/config.ts"));
  await avcsSideDone(dir, out);
  assert.match(out, /did NOT remove them — the commit is not at the tip/);
  assert.match(out, /1 later commit\(s\) sit on top of it/);
  assert.match(out, /git filter-repo --path src\/config\.ts --invert-paths/);
  assert.match(out, /filter-branch/, "and the fallback for repos without filter-repo");
  assert.match(git(dir, "log", "--all", "-S", GSECRET, "--oneline"), /oops/, "git untouched");
  await rm(dir, { recursive: true, force: true });
});

test("refuses when the same commit carries work the user did not undo", { skip: !hasGit }, async () => {
  const dir = await bridged();
  await gitCommit(dir, "seed", { "app.ts": "export const v = 1\n" });
  await gitCommit(dir, "oops + real work", { "src/config.ts": LEAK, "lib.ts": "export const w = 2\n" });

  const out = avcs(dir, "undo", "--purge", await opFor(dir, "src/config.ts"));
  await avcsSideDone(dir, out);
  assert.match(out, /also carries work you did not undo/);
  assert.match(out, /it changes lib\.ts, which no undone op covers/);
  assert.match(out, /git filter-repo --path src\/config\.ts --invert-paths/);
  assert.match(git(dir, "log", "-1", "--pretty=%s"), /oops \+ real work/, "the commit is still there");
  assert.equal(git(dir, "show", "HEAD:lib.ts"), "export const w = 2", "and so is the work");
  await rm(dir, { recursive: true, force: true });
});

test("refuses a dirty tree, and the retry it prints finishes the git half", { skip: !hasGit }, async () => {
  const dir = await bridged();
  await gitCommit(dir, "ok", { "app.ts": "export const v = 1\n" });
  const bad = await gitCommit(dir, "oops", { "src/config.ts": LEAK });
  await writeFile(join(dir, "app.ts"), "export const v = 99\n", "utf8"); // uncommitted work

  const out = avcs(dir, "undo", "--last", "--purge");
  await avcsSideDone(dir, out);
  assert.match(out, /did NOT remove them — the git tree is not clean/);
  assert.match(out, /app\.ts/);
  assert.match(out, /Moving HEAD out from under uncommitted work/);
  const retry = /re-run:\s+(avcs undo --purge [\w ]+)/.exec(out);
  assert.ok(retry, `the refusal prints an explicit retry, got:\n${out}`);
  assert.doesNotMatch(retry[1] as string, /--last/, "never --last: after the undo it names another commit");
  assert.match(git(dir, "log", "--all", "-S", GSECRET, "--oneline"), /oops/, "git untouched so far");

  // Clean the tree and run exactly what it told the user to run. The avcs side has already
  // converged, so this run exists only to finish the git side.
  git(dir, "checkout", "--", "app.ts");
  const again = avcs(dir, ...(retry[1] as string).split(/\s+/).slice(1));
  assert.match(again, /nothing to undo/, "the avcs side does not repeat itself");
  assert.match(again, /removed 1 commit\(s\) holding those bytes from `main`/);
  assert.equal(git(dir, "log", "--all", "-S", GSECRET, "--oneline"), "", "and now git is clean too");
  assert.equal(gitFails(dir, "cat-file", "-e", `${bad}^{commit}`), true);
  await rm(dir, { recursive: true, force: true });
});

test("refuses when another local ref would keep the bytes reachable", { skip: !hasGit }, async () => {
  const dir = await bridged();
  await gitCommit(dir, "ok", { "app.ts": "export const v = 1\n" });
  await gitCommit(dir, "oops", { "src/config.ts": LEAK });
  git(dir, "tag", "keepme");

  const out = avcs(dir, "undo", "--last", "--purge");
  await avcsSideDone(dir, out);
  assert.match(out, /another ref still points into that history/);
  assert.match(out, /refs\/tags\/keepme/);
  assert.match(git(dir, "log", "--all", "-S", GSECRET, "--oneline"), /oops/, "git untouched");
  await rm(dir, { recursive: true, force: true });
});

test("--no-git leaves git alone and says so", { skip: !hasGit }, async () => {
  const dir = await bridged();
  await gitCommit(dir, "ok", { "app.ts": "export const v = 1\n" });
  await gitCommit(dir, "oops", { "src/config.ts": LEAK });

  const out = avcs(dir, "undo", "--last", "--purge", "--no-git");
  await avcsSideDone(dir, out);
  assert.match(out, /--no-git — git still holds its own copy/);
  assert.match(git(dir, "log", "--all", "-S", GSECRET, "--oneline"), /oops/, "git untouched, as asked");
  await rm(dir, { recursive: true, force: true });
});

test("a leak in the very first commit: the branch goes, nothing else is lost", { skip: !hasGit }, async () => {
  const dir = await bridged();
  const only = await gitCommit(dir, "oops", { "src/config.ts": LEAK });

  const out = avcs(dir, "undo", "--last", "--purge");
  await avcsSideDone(dir, out);
  assert.match(out, /main is unborn now — that run was its whole history/);
  assert.equal(git(dir, "log", "--all", "-S", GSECRET, "--oneline"), "");
  assert.equal(gitFails(dir, "cat-file", "-e", `${only}^{commit}`), true);
  assert.equal(git(dir, "status", "--porcelain", "--", "src"), "?? src/", "the file is on disk, untracked");
  await rm(dir, { recursive: true, force: true });
});
