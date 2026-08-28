// A purge tombstone must never become file content (issue #97).
//
// `undo --purge` evicts a blob's bytes and leaves the deterministic `[PURGED: …]` stub AT
// the oid. That is the eviction working, and content-addressing is exactly what stops the
// secret from coming back. What was missing was the WARNING: the next `commit` re-added the
// file still sitting on disk, the new op resolved to the SAME — now tombstoned — oid, and
// materialize wrote the sentinel string into the file and exited 0. The bytes stayed gone;
// integrity did not.
//
// Both guards below key on `undoOid`, NOT on `redacted`. Both stub makers set `redacted` —
// it is the flag that tells the store and `fsck` that this oid≠content mismatch is
// sanctioned — so guarding on it would refuse an admin-signed REDACTION, which is designed
// to propagate and whose stub a replica is supposed to materialize. `undoOid` marks a purely
// LOCAL undo, which is a broken derivation by construction. The redaction tests at the
// bottom pin that distinction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir, readFile, stat } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { Repo } from "../src/api/repo.ts";
import { PurgedBlobError } from "../src/store/applyRedactions.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor, Blob, Operation } from "../src/objects/types.ts";

const dev: Actor = { kind: "human", id: "human:dev" };
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const avcs = (cwd: string, ...a: string[]): string =>
  execFileSync(process.execPath, ["--experimental-strip-types", CLI, ...a], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
const avcsRaw = (cwd: string, ...a: string[]): { status: number | null; stdout: string; stderr: string } =>
  spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...a], { cwd, encoding: "utf8" });

const SECRET = 'export const KEY = "sk-live-97TOMBSTONE97";\n';

// ── the scanner ───────────────────────────────────────────────────────────────
//
// A plaintext `grep` over `.avcs/` proves NOTHING: objects are canonical CBOR and a blob's
// payload is a base64 string inside one, so the needle is never on disk verbatim whether or
// not the bytes are there. So the scan has to try the base64 encoding too — and at ALL THREE
// byte alignments, because base64 packs 3 bytes into 4 characters and a substring's encoding
// therefore depends on its offset mod 3.
//
// `scannerSeesKnownContent` below is the self-check that makes a NEGATIVE result mean
// anything at all: it points the same scanner at content that is definitely present, at each
// of the three alignments, and fails if the scanner cannot find it.

/** Every base64 fragment `needle` could appear as, one per byte alignment. */
function base64Fragments(needle: Buffer): string[] {
  const out: string[] = [];
  for (let align = 0; align < 3; align++) {
    // `align` filler bytes shift the needle to that offset. Every base64 group holding a
    // filler byte is contaminated, so drop those 4 characters (none when align is 0); the
    // trailing group depends on whatever follows the needle in the real content, so drop it.
    const b64 = Buffer.concat([Buffer.alloc(align), needle]).toString("base64");
    const frag = b64.slice(align === 0 ? 0 : 4).replace(/=+$/, "").slice(0, -4);
    if (frag.length) out.push(frag);
  }
  return out;
}

/** True when any byte under `.avcs/` holds `needle` as plaintext or as base64. */
async function storeHolds(dir: string, needle: string): Promise<boolean> {
  const fragments = [needle, ...base64Fragments(Buffer.from(needle, "utf8"))];
  const walk = async (p: string): Promise<boolean> => {
    for (const entry of await readdir(p)) {
      const full = join(p, entry);
      if ((await stat(full)).isDirectory()) {
        if (await walk(full)) return true;
        continue;
      }
      const text = (await readFile(full)).toString("latin1");
      if (fragments.some((f) => text.includes(f))) return true;
    }
    return false;
  };
  return walk(join(dir, ".avcs"));
}

/** The scanner's own self-check: it must find content nobody evicted, at every alignment. */
async function scannerSeesKnownContent(dir: string, present: string): Promise<void> {
  for (let offset = 0; offset < 3; offset++) {
    const sub = present.slice(offset);
    assert.equal(
      await storeHolds(dir, sub),
      true,
      `scanner self-check failed at alignment ${offset}: it cannot see content that IS there, ` +
        "so a negative result from it would prove nothing",
    );
  }
}

// ── fixtures ──────────────────────────────────────────────────────────────────

/** The issue's setup: a good commit, a leaked commit, then `undo --last --purge`. */
async function purgedLeak(): Promise<{ dir: string; repo: Repo; blobOid: string; undoOid: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-97-"));
  const repo = await Repo.init(dir);
  await writeFile(join(dir, "a.ts"), "export const a = 1;\n", "utf8");
  await repo.commitWorkingTree(dir, { message: "feat: a", actor: dev });
  await writeFile(join(dir, "secret.ts"), SECRET, "utf8");
  const bad = await repo.commitWorkingTree(dir, { message: "chore: config", actor: dev });
  const blobOid = (await repo.store.get<Operation>(bad.ops[0] as string)).body.blobOid as string;

  const r = await repo.undo({ last: true, purge: true, by: dev.id });
  assert.deepEqual(r.purged, [blobOid], "the leaked blob is the one evicted");
  // As designed: the eviction does not touch the working tree, so the file is still there.
  assert.equal(await readFile(join(dir, "secret.ts"), "utf8"), SECRET);
  return { dir, repo, blobOid, undoOid: r.undoOid as string };
}

/** Put a tree entry on a purged oid WITHOUT going through `commitWorkingTree` — the state a
 *  store can already be in from before the commit guard existed, and the state any other
 *  route to a purged blob leaves behind. This is what keeps the materialize guard honest as
 *  a guard of its own rather than a duplicate of the commit one. */
async function reAddViaPropose(repo: Repo, path: string, content: string): Promise<string> {
  const intent = await repo.createIntent({ title: "re-add", owner: dev.id });
  const sess = await repo.startSession({ intentOid: intent, actor: dev });
  return repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: dev, path, content: Buffer.from(content, "utf8"), declaredPurpose: "re-add" });
}

// ── guard 1: commit refuses to re-add a purged path ───────────────────────────

test("#97 repro: commit refuses to silently re-add a purged path, naming the path and the undo", async () => {
  const { dir, repo, blobOid, undoOid } = await purgedLeak();

  // The user has not noticed, and commits unrelated work. The leaked file is still on disk.
  await writeFile(join(dir, "c.ts"), "export const c = 3;\n", "utf8");
  await assert.rejects(
    () => repo.commitWorkingTree(dir, { message: "feat: c", actor: dev }),
    (e: Error) => {
      assert.ok(e instanceof PurgedBlobError, `expected a PurgedBlobError, got ${e.name}`);
      assert.match(e.message, /secret\.ts/, "the message names the path");
      assert.match(e.message, new RegExp(blobOid), "and the oid");
      assert.match(e.message, new RegExp(undoOid), "and the undo that ordered the purge");
      assert.match(e.message, /fix or delete/i, "and the user's actual next step");
      return true;
    },
  );

  // A refusal is a refusal: nothing was captured, so `c.ts` is still uncommitted and the
  // view has not grown a tombstoned path.
  const tree = (await repo.materialize()).tree;
  assert.ok(!tree.has("secret.ts"), "the purged path did not get back into the view");
  assert.ok(!tree.has("c.ts"), "and the commit did not half-happen");

  // Removing the file is enough to unblock: the purge left the fix to the user, and doing it
  // works. `a.ts` and the new `c.ts` commit normally.
  await rm(join(dir, "secret.ts"));
  const ok = await repo.commitWorkingTree(dir, { message: "feat: c", actor: dev });
  assert.deepEqual(ok.added, ["c.ts"]);
  assert.deepEqual([...(await repo.materialize()).tree.keys()].sort(), ["a.ts", "c.ts"]);
  await rm(dir, { recursive: true, force: true });
});

test("the refusal reaches the CLI as a failure, not a success line", async () => {
  const { dir } = await purgedLeak();
  await writeFile(join(dir, "c.ts"), "export const c = 3;\n", "utf8");
  const r = avcsRaw(dir, "commit", "-m", "feat: c");
  assert.equal(r.status, 1, `commit must exit non-zero, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /secret\.ts/);
  assert.doesNotMatch(r.stdout, /committed \d+ change/, "and never claims to have committed");
  await rm(dir, { recursive: true, force: true });
});

test("the commit guard also catches content large enough to be chunked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-97-"));
  const repo = await Repo.init(dir);
  // Over CHUNK_THRESHOLD, so `putBlob` addresses it as a chunk MANIFEST rather than one blob.
  // The guard has to reproduce that addressing exactly, or it silently misses every large
  // file — and the two constants are different (threshold 256K, stride 64K), which is a real
  // way to get this wrong.
  const big = SECRET + "x".repeat(Repo.CHUNK_THRESHOLD * 2);
  await writeFile(join(dir, "big.ts"), big, "utf8");
  const bad = await repo.commitWorkingTree(dir, { message: "leak", actor: dev });
  const manifest = (await repo.store.get<Operation>(bad.ops[0] as string)).body.blobOid as string;
  assert.equal((await repo.store.get<Blob>(manifest)).chunked, true, "the fixture must exercise chunking");

  const r = await repo.undo({ last: true, purge: true, by: dev.id });
  assert.ok(r.purged.includes(manifest), "the manifest itself is evicted");
  await writeFile(join(dir, "other.ts"), "export const o = 1;\n", "utf8");
  await assert.rejects(
    () => repo.commitWorkingTree(dir, { message: "more work", actor: dev }),
    (e: Error) => e instanceof PurgedBlobError && /big\.ts/.test(e.message),
  );
  await rm(dir, { recursive: true, force: true });
});

// ── guard 2: materialize refuses to write a tombstone as content ──────────────

test("#97 repro: materialize refuses a purged blob rather than writing [PURGED: …] as content", async () => {
  const { dir, repo, blobOid, undoOid } = await purgedLeak();
  await reAddViaPropose(repo, "secret.ts", SECRET);

  // The view legitimately SELECTS the path — content-addressing resolved the new op to the
  // tombstoned oid, which is the mechanism working. Deriving bytes from it is what stops.
  const res = await repo.materialize();
  assert.equal(res.tree.get("secret.ts"), blobOid, "same content ⇒ same oid ⇒ the tombstone");

  for (const [what, run] of [
    ["materializedBytes", () => repo.materializedBytes(res)],
    ["materializedFiles", () => repo.materializedFiles(res)],
    ["writeWorkspace", () => repo.writeWorkspace(res, join(dir, "mat"))],
    ["projectInto", () => repo.projectInto(join(dir, "proj"), "main")],
    ["checkoutInto", () => repo.checkoutInto(join(dir, "co"), "main")],
  ] as const) {
    await assert.rejects(
      run,
      (e: Error) => {
        assert.ok(e instanceof PurgedBlobError, `${what}: expected PurgedBlobError, got ${e.name}`);
        assert.match(e.message, /secret\.ts/, `${what}: names the path`);
        assert.match(e.message, new RegExp(blobOid), `${what}: names the oid`);
        assert.match(e.message, new RegExp(undoOid), `${what}: names the undo`);
        return true;
      },
      `${what} must refuse a purge tombstone`,
    );
  }
  await rm(dir, { recursive: true, force: true });
});

test("`avcs materialize --out` fails instead of exiting 0 with a sentinel string on disk", async () => {
  const { dir, repo, blobOid } = await purgedLeak();
  await reAddViaPropose(repo, "secret.ts", SECRET);

  const r = avcsRaw(dir, "materialize", "--out", "mat");
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /secret\.ts/, "the diagnostic names the path");
  assert.match(r.stderr, new RegExp(blobOid), "and the oid");
  assert.doesNotMatch(r.stdout, /wrote \d+ files/, "no success line");
  // The old behaviour: a file whose whole content was `[PURGED: …]`. Never again.
  const wrote = await readFile(join(dir, "mat", "secret.ts"), "utf8").catch(() => null);
  assert.ok(wrote === null || !/PURGED/.test(wrote), `a tombstone was written as content: ${wrote}`);
  await rm(dir, { recursive: true, force: true });
});

test("a purged blob nothing selects is not a problem — the guard is about the VIEW", async () => {
  const { dir, repo } = await purgedLeak();
  // Nothing re-added it, so the tombstone is unreachable from the view and every derivation
  // still works. A guard that fired here would make an ordinary post-purge repo unusable.
  const res = await repo.materialize();
  assert.deepEqual((await repo.materializedFiles(res)).map((f) => f.path), ["a.ts"]);
  await repo.writeWorkspace(res, join(dir, "mat"));
  assert.equal(await readFile(join(dir, "mat", "a.ts"), "utf8"), "export const a = 1;\n");
  await rm(dir, { recursive: true, force: true });
});

// ── the security property the guards must not weaken ─────────────────────────

test("the evicted bytes stay evicted — through a refused commit and a re-add", async () => {
  const { dir, repo } = await purgedLeak();
  // Self-check FIRST, on content nobody evicted: without this a negative below is worthless.
  await scannerSeesKnownContent(dir, "export const a = 1;\n");
  assert.equal(await storeHolds(dir, SECRET), false, "the purge really evicted the bytes");

  await writeFile(join(dir, "c.ts"), "export const c = 3;\n", "utf8");
  await assert.rejects(() => repo.commitWorkingTree(dir, { message: "feat: c", actor: dev }), PurgedBlobError);
  assert.equal(await storeHolds(dir, SECRET), false, "a refused commit writes nothing back");

  // Even the route that bypasses the commit guard cannot resurrect them: `store.put` never
  // rewrites an oid it already holds, so the tombstone stands.
  await reAddViaPropose(repo, "secret.ts", SECRET);
  assert.equal(await storeHolds(dir, SECRET), false, "content-addressing keeps the bytes gone");
  await scannerSeesKnownContent(dir, "export const a = 1;\n");
  await rm(dir, { recursive: true, force: true });
});

test("undo --purge stays irreversible: re-including the ops does not bring the bytes back", async () => {
  const { dir, repo, blobOid } = await purgedLeak();
  const view = await repo.getView("main");
  await repo.createView("main", { ...view.query, excludeOps: [] }, view.oid as string);
  const res = await repo.materialize();
  assert.equal(res.tree.get("secret.ts"), blobOid, "the op is selected again");
  // …and that is precisely a broken view now, which is what the guard is for. The bytes are
  // not recoverable by any route.
  await assert.rejects(() => repo.materializedFiles(res), PurgedBlobError);
  assert.equal(await storeHolds(dir, SECRET), false);
  await rm(dir, { recursive: true, force: true });
});

// ── the missing warning on the standalone path ────────────────────────────────

test("standalone undo --purge warns that the leaked file is still on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-97-"));
  await Repo.init(dir);
  await writeFile(join(dir, "a.ts"), "export const a = 1;\n", "utf8");
  avcs(dir, "commit", "-m", "feat: a");
  await writeFile(join(dir, "secret.ts"), SECRET, "utf8");
  avcs(dir, "commit", "-m", "chore: config");

  const out = avcs(dir, "undo", "--last", "--purge");
  assert.match(out, /purged 1 blob/);
  assert.match(out, /still on disk/, "the warning the git plane already prints");
  assert.match(out, /before you commit again/, "and what to do about it");
  // The standalone message must stay clean: no caution about a tool that is not here.
  assert.doesNotMatch(out, /git/i, "no git bridge ⇒ nothing to say about git");
  // A plain undo evicts nothing, so there is nothing to warn about.
  assert.doesNotMatch(avcs(dir, "undo", "--last"), /still on disk/);
  await rm(dir, { recursive: true, force: true });
});

// ── REDACTION IS UNCHANGED (the test that keeps the guards honest) ────────────

/** A repo with governance: an admin who may `redact`, and `dev` as a trusted proposer so its
 *  ops are not quarantined out of the view. `redact` is admin-gated, so a redaction fixture
 *  cannot be built without this — which is exactly the asymmetry with a local `undo`. */
async function governedRepo(): Promise<{ dir: string; repo: Repo; sign: { keyId: string; privateKey: string } }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-97-red-"));
  const repo = await Repo.init(dir);
  const root = generateKeypair();
  const admin = generateKeypair();
  await repo.registerMembership({ actorId: "human:admin", publicKey: admin.publicKey, role: "admin", root: { keyId: "root", privateKey: root.privateKey } });
  await repo.registerMembership({ actorId: dev.id, publicKey: generateKeypair().publicKey, role: "proposer", root: { keyId: "root", privateKey: root.privateKey } });
  return { dir, repo, sign: { keyId: "human:admin", privateKey: admin.privateKey } };
}

test("an admin-signed redaction still propagates and still materializes its stub", async () => {
  const { dir, repo, sign } = await governedRepo();
  await writeFile(join(dir, "leak.env"), "AWS_KEY=AKIA_redaction_case\n", "utf8");
  await repo.commitWorkingTree(dir, { message: "oops", actor: dev });
  const blobOid = (await repo.materialize()).tree.get("leak.env") as string;

  await repo.redact(blobOid, "leaked AWS key", "human:admin", sign);

  // The stub carries `redacted` exactly as the purge stub does — and is materialized anyway.
  // A guard keyed on `redacted` instead of `undoOid` would break here, and that break is
  // the whole reason this test exists.
  const blob = await repo.store.get<Blob>(blobOid);
  assert.equal(blob.redacted, true, "the flag both stubs share");
  assert.equal(blob.redactionOid !== undefined, true, "a redaction's provenance pointer");
  assert.equal(blob.undoOid, undefined, "and NOT an undo's");

  const res = await repo.materialize();
  assert.equal(res.tree.get("leak.env"), blobOid, "the oid is preserved, so references hold");
  const files = await repo.materializedFiles(res);
  assert.equal(files.find((f) => f.path === "leak.env")?.content, "[REDACTED: leaked AWS key]");
  await repo.writeWorkspace(res, join(dir, "mat"));
  assert.equal(await readFile(join(dir, "mat", "leak.env"), "utf8"), "[REDACTED: leaked AWS key]");
  await rm(dir, { recursive: true, force: true });
});

test("committing a path back onto a REDACTED blob is still allowed (redaction ≠ purge)", async () => {
  const { dir, repo, sign } = await governedRepo();
  await writeFile(join(dir, "leak.env"), "AWS_KEY=AKIA_second_case\n", "utf8");
  await repo.commitWorkingTree(dir, { message: "oops", actor: dev });
  const blobOid = (await repo.materialize()).tree.get("leak.env") as string;
  await repo.redact(blobOid, "leaked AWS key", "human:admin", sign);
  await repo.undo({ last: true, by: dev.id }); // plain undo: the path leaves the view

  // The same bytes arriving again resolve to the redacted oid. `commit` must NOT refuse:
  // a redaction is a governance fact about a replicated blob, not a local broken
  // derivation, and its stub is what every replica is supposed to project.
  const again = await repo.commitWorkingTree(dir, { message: "back", actor: dev });
  assert.deepEqual(again.added, ["leak.env"]);
  const res = await repo.materialize();
  assert.equal(res.tree.get("leak.env"), blobOid);
  assert.equal((await repo.materializedFiles(res)).find((f) => f.path === "leak.env")?.content, "[REDACTED: leaked AWS key]");
  await rm(dir, { recursive: true, force: true });
});
