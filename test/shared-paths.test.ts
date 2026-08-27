// docs/21 — shared-paths: the half of "ignore" the core did not have.
//
// Ignoring a path means "do not record it as an op". A SHARED path means "do not record it
// AND still have it in the directory". Without the second half a projected workspace has no
// dependency tree, so it cannot build, so real projects keep using git worktrees for build
// isolation — and docs/16 §2-1 ("물리 격리도 avcs가 제공한다") does not hold in practice.
//
// The matrix below is docs/21 §5 (S1–S15 + S8b).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir, lstat, symlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const dev: Actor = { kind: "human", id: "human:dev" };
const mk = () => mkdtemp(join(tmpdir(), "avcs-shared-"));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const avcs = (cwd: string, ...a: string[]) =>
  execFileSync(process.execPath, ["--experimental-strip-types", CLI, ...a], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

/** Where a symlink points, absolutised — the assertion S4/S6 actually care about. */
async function readlinkOf(p: string): Promise<string> {
  const { readlink } = await import("node:fs/promises");
  const dest = await readlink(p);
  const { isAbsolute, resolve: res, dirname } = await import("node:path");
  return isAbsolute(dest) ? dest : res(dirname(p), dest);
}

/** Author one file into the base view, the way a capture would. */
async function put(repo: Repo, path: string, content: string, workspace?: string): Promise<void> {
  const intent = await repo.createIntent({ title: `write ${path}`, owner: dev.id });
  const sess = await repo.startSession({ intentOid: intent, actor: dev });
  await repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: dev, path, content,
    declaredPurpose: `write ${path}`, ...(workspace ? { workspace } : {}),
  });
}

// ── Slice 1: the config surface (.avcs/shared-paths.json) ────────────────────

test("shared-paths config: absent ⇒ empty, and round-trips through the aux file", async () => {
  const dir = await mk();
  try {
    const repo = await Repo.init(dir);
    assert.deepEqual(await repo.readSharedPaths(), [], "no config file ⇒ no shared paths (S1's precondition)");
    assert.equal(existsSync(join(dir, ".avcs", "shared-paths.json")), false, "reading must not CREATE the file");

    await repo.setSharedPaths([{ path: "node_modules", keyFrom: ["pnpm-lock.yaml"] }]);
    assert.deepEqual(await repo.readSharedPaths(), [
      { path: "node_modules", keyFrom: ["pnpm-lock.yaml"], mode: "symlink" },
    ], "mode defaults to symlink (cost 0; copy is the opt-in escape hatch, docs/21 R1)");

    // Written as an aux file under .avcs/ — so sidecar mode never exposes it to git.
    const raw = JSON.parse(await readFile(join(dir, ".avcs", "shared-paths.json"), "utf8"));
    assert.equal(raw.version, 1);
    assert.equal(raw.shared.length, 1);

    const reopened = await Repo.open(dir);
    assert.equal((await reopened.readSharedPaths())[0]!.path, "node_modules", "survives a re-open");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shared-paths config: add/remove are read-modify-write, and escaping paths are rejected", async () => {
  const dir = await mk();
  try {
    const repo = await Repo.init(dir);
    await repo.addSharedPath({ path: "node_modules", keyFrom: ["pnpm-lock.yaml"] });
    await repo.addSharedPath({ path: "packages/web/node_modules", keyFrom: ["pnpm-lock.yaml"], mode: "copy" });
    assert.deepEqual((await repo.readSharedPaths()).map((e) => e.path), ["node_modules", "packages/web/node_modules"]);

    // Re-adding the same path replaces it rather than duplicating.
    await repo.addSharedPath({ path: "node_modules", keyFrom: ["package-lock.json"] });
    const entries = await repo.readSharedPaths();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.find((e) => e.path === "node_modules")!.keyFrom, ["package-lock.json"]);

    assert.equal(await repo.removeSharedPath("node_modules"), true);
    assert.equal(await repo.removeSharedPath("node_modules"), false, "removing what is not there says so");
    assert.deepEqual((await repo.readSharedPaths()).map((e) => e.path), ["packages/web/node_modules"]);

    // A shared path is resolved under the projection root and slugged into the store, so
    // anything that could escape either is refused at the door.
    for (const bad of ["/abs", "../up", "a/../../up", ".avcs/objects", ""]) {
      await assert.rejects(() => repo.addSharedPath({ path: bad }), /shared path/, `rejected: ${bad}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Slice 2: key derivation (S9, S10, S15) ───────────────────────────────────

test("S15 — the key is a pure function of the PROJECTED content of the declared files", async () => {
  // A tree is `path → blobOid`, and a blob object is `{type,data,encoding}` — content and
  // nothing else. So equal content means an equal oid means an equal key, with no disk read
  // and no clock in the way. Determinism buys cache correctness for free.
  const a = new Map([["pnpm-lock.yaml", "oid-lock"], ["src/a.ts", "oid-a"]]);
  const b = new Map([["src/a.ts", "oid-a"], ["pnpm-lock.yaml", "oid-lock"]]); // different insertion order
  const k1 = Repo.deriveSharedKey(["pnpm-lock.yaml"], a);
  const k2 = Repo.deriveSharedKey(["pnpm-lock.yaml"], b);
  assert.equal(k1.key, k2.key, "insertion order of the tree must not move the key");
  assert.match(k1.key, /^[0-9a-f]{32}$/);
  assert.deepEqual(k1.missing, []);

  // Order and duplication of keyFrom itself are also normalised away (§3.2 sorts).
  assert.equal(
    Repo.deriveSharedKey(["b.lock", "a.lock", "a.lock"], new Map([["a.lock", "1"], ["b.lock", "2"]])).key,
    Repo.deriveSharedKey(["a.lock", "b.lock"], new Map([["b.lock", "2"], ["a.lock", "1"]])).key,
  );

  // S4's mechanism: different declared content ⇒ different key.
  assert.notEqual(k1.key, Repo.deriveSharedKey(["pnpm-lock.yaml"], new Map([["pnpm-lock.yaml", "oid-lock-v2"]])).key);
  // A file NOT declared cannot move the key, however much it changes.
  assert.equal(k1.key, Repo.deriveSharedKey(["pnpm-lock.yaml"], new Map([["pnpm-lock.yaml", "oid-lock"], ["src/a.ts", "changed"]])).key);
});

test("S9/S10 — a missing declared file hashes as empty and says so; `keyFrom: []` is a named constant", async () => {
  // S9: silently deriving a DIFFERENT key would split the cache for a lockfile that has not
  // been written yet, and nobody would know why the install ran twice. So it participates as
  // empty content and the absence is reported.
  const missing = Repo.deriveSharedKey(["pnpm-lock.yaml"], new Map([["src/a.ts", "oid-a"]]));
  assert.deepEqual(missing.missing, ["pnpm-lock.yaml"], "the absence is reported, not swallowed");
  assert.equal(missing.key, Repo.deriveSharedKey(["pnpm-lock.yaml"], new Map()).key, "absent ⇒ empty content, deterministically");
  assert.notEqual(missing.key, Repo.deriveSharedKey(["pnpm-lock.yaml"], new Map([["pnpm-lock.yaml", "oid-lock"]])).key);

  // S10: an empty declaration is the explicit choice "every workspace shares one cache".
  // Dangerous, and the user's to make — so it is allowed, named, and flagged.
  const unkeyed = Repo.deriveSharedKey([], new Map([["pnpm-lock.yaml", "oid-lock"]]));
  assert.equal(unkeyed.key, "unkeyed");
  assert.equal(unkeyed.unkeyed, true);
  assert.equal(Repo.deriveSharedKey(undefined, new Map([["x", "y"]])).key, "unkeyed", "no keyFrom at all reads the same way");
});

// ── Slice 3: linking at projection (S2–S6, S11, S12) ─────────────────────────

/** A repo with one lockfile + one source file in the base view, and `node_modules` shared. */
async function projectable(opts: { mode?: "symlink" | "copy"; keyFrom?: string[] } = {}): Promise<{ dir: string; repo: Repo }> {
  const dir = await mk();
  const repo = await Repo.init(dir);
  await put(repo, "pnpm-lock.yaml", "lockfileVersion: 1\n");
  await put(repo, "src/a.ts", "export const a = 1;\n");
  await repo.addSharedPath({ path: "node_modules", keyFrom: opts.keyFrom ?? ["pnpm-lock.yaml"], ...(opts.mode ? { mode: opts.mode } : {}) });
  return { dir, repo };
}

test("S2 — the first projection creates the cache, links it, and reports populated:false", async () => {
  const { dir, repo } = await projectable();
  const out = await mkdtemp(join(tmpdir(), "avcs-ws-"));
  try {
    const res = await repo.projectInto(out, "main");
    assert.deepEqual(res.written, ["pnpm-lock.yaml", "src/a.ts"], "the tree itself is written as before");
    assert.equal(res.shared.length, 1);
    const [link] = res.shared;
    assert.equal(link!.path, "node_modules");
    assert.equal(link!.linked, true);
    assert.equal(link!.populated, false, "an empty cache is what 'an install is needed' MEANS (docs/21 §2-2)");
    assert.equal(link!.warning, undefined);

    // The cache is store-local: cleanup is one `.avcs` away and no home directory is touched.
    assert.equal(link!.cache, join(dir, ".avcs", "shared", link!.key, "node_modules"));
    assert.equal((await stat(link!.cache)).isDirectory(), true, "created empty, not populated");
    assert.equal((await readdir(link!.cache)).length, 0);

    // The projection reaches it through a symlink — the default, cost 0.
    const st = await lstat(join(out, "node_modules"));
    assert.equal(st.isSymbolicLink(), true);
    assert.equal((await stat(join(out, "node_modules"))).isDirectory(), true, "and it resolves");

    // populated flips as soon as ANYTHING is in the cache. The core never asks what.
    await writeFile(join(link!.cache, "installed-by-the-caller"), "x");
    assert.equal((await repo.projectInto(out, "main")).shared[0]!.populated, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("S3 — a second workspace with the same declared content gets the SAME cache, already populated", async () => {
  // This is the resolution of #11: install once per lock-hash, not once per workspace.
  const { dir, repo } = await projectable();
  const a = await mkdtemp(join(tmpdir(), "avcs-ws-a-"));
  const b = await mkdtemp(join(tmpdir(), "avcs-ws-b-"));
  try {
    const first = (await repo.projectInto(a, "main", { workspace: "feat-a" })).shared[0]!;
    assert.equal(first.populated, false);
    await writeFile(join(first.cache, "dep.js"), "// installed once"); // the caller's install

    const second = (await repo.projectInto(b, "main", { workspace: "feat-b" })).shared[0]!;
    assert.equal(second.key, first.key, "same declared content ⇒ same key, by construction");
    assert.equal(second.cache, first.cache);
    assert.equal(second.populated, true, "the second workspace needs no install at all");
    assert.equal(await readFile(join(b, "node_modules", "dep.js"), "utf8"), "// installed once");
  } finally {
    for (const d of [dir, a, b]) await rm(d, { recursive: true, force: true });
  }
});

test("S4 — changing a declared file re-points to a NEW cache and keeps the old one", async () => {
  const { dir, repo } = await projectable();
  const out = await mkdtemp(join(tmpdir(), "avcs-ws-"));
  try {
    const before = (await repo.projectInto(out, "main")).shared[0]!;
    await writeFile(join(before.cache, "old.js"), "old");

    await put(repo, "pnpm-lock.yaml", "lockfileVersion: 2\n"); // the environment changed
    const after = (await repo.projectInto(out, "main")).shared[0]!;
    assert.notEqual(after.key, before.key, "a different declared content is a different environment");
    assert.equal(after.populated, false, "so it needs its own install");
    // Old cache PRESERVED: bouncing between branches must not re-install (docs/21 §3.6).
    assert.equal(existsSync(join(before.cache, "old.js")), true);
    // …and the projection now reaches the NEW cache, not the stale one. Re-pointing a symlink
    // we ourselves put inside our own shared root is safe; anything else is left alone.
    assert.equal(await readlinkOf(join(out, "node_modules")), after.cache);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("S5 — re-projecting an already-correct link is a silent no-op", async () => {
  const { dir, repo } = await projectable();
  const out = await mkdtemp(join(tmpdir(), "avcs-ws-"));
  try {
    const first = (await repo.projectInto(out, "main")).shared[0]!;
    const inode = (await lstat(join(out, "node_modules"))).ino;
    const again = (await repo.projectInto(out, "main")).shared[0]!;
    assert.equal(again.linked, true);
    assert.equal(again.warning, undefined, "idempotent: nothing to say, so nothing is said");
    assert.equal(again.key, first.key);
    assert.equal((await lstat(join(out, "node_modules"))).ino, inode, "the link was not recreated");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("S6 — a real directory already at the shared path is left alone, with a warning", async () => {
  // User data outranks the cache. Silently replacing a populated `node_modules` with an empty
  // symlink would destroy an install the core cannot recreate (it does not know how).
  const { dir, repo } = await projectable();
  const out = await mkdtemp(join(tmpdir(), "avcs-ws-"));
  try {
    await mkdir(join(out, "node_modules"), { recursive: true });
    await writeFile(join(out, "node_modules", "mine.js"), "do not touch me");

    const link = (await repo.projectInto(out, "main")).shared[0]!;
    assert.equal(link.linked, false, "not linked — and it says so rather than pretending");
    assert.match(link.warning ?? "", /exists/);
    assert.equal((await lstat(join(out, "node_modules"))).isSymbolicLink(), false);
    assert.equal(await readFile(join(out, "node_modules", "mine.js"), "utf8"), "do not touch me");

    // A symlink to somewhere that is NOT our cache tree is equally the user's to keep.
    const elsewhere = await mkdtemp(join(tmpdir(), "avcs-elsewhere-"));
    await rm(join(out, "node_modules"), { recursive: true, force: true });
    await symlink(elsewhere, join(out, "node_modules"), "dir");
    const foreign = (await repo.projectInto(out, "main")).shared[0]!;
    assert.equal(foreign.linked, false);
    assert.match(foreign.warning ?? "", /symlink/);
    assert.equal(await readlinkOf(join(out, "node_modules")), elsewhere);
    await rm(elsewhere, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("S11 — `mode: copy` copies recursively and never overwrites what is already there", async () => {
  const { dir, repo } = await projectable({ mode: "copy" });
  const out = await mkdtemp(join(tmpdir(), "avcs-ws-"));
  try {
    // Populate the cache first so there is something to copy (the caller's job, §2-2).
    const dry = (await repo.projectInto(out, "main")).shared[0]!;
    await rm(join(out, "node_modules"), { recursive: true, force: true });
    await mkdir(join(dry.cache, "pkg", "deep"), { recursive: true });
    await writeFile(join(dry.cache, "pkg", "deep", "index.js"), "module.exports = 1;");

    const link = (await repo.projectInto(out, "main")).shared[0]!;
    assert.equal(link.mode, "copy");
    assert.equal(link.linked, true);
    assert.equal((await lstat(join(out, "node_modules"))).isSymbolicLink(), false, "copy puts a REAL directory there");
    assert.equal(await readFile(join(out, "node_modules", "pkg", "deep", "index.js"), "utf8"), "module.exports = 1;");

    // Local edits inside the copy survive a re-projection: the copy is not re-run over it.
    await writeFile(join(out, "node_modules", "pkg", "deep", "index.js"), "patched locally");
    await repo.projectInto(out, "main");
    assert.equal(await readFile(join(out, "node_modules", "pkg", "deep", "index.js"), "utf8"), "patched locally");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("S12 — a linked working tree shares the MAIN store's cache through the .avcs pointer", async () => {
  const { dir, repo } = await projectable();
  const linked = await mk();
  const out = await mkdtemp(join(tmpdir(), "avcs-ws-"));
  try {
    const main = (await repo.projectInto(out, "main")).shared[0]!;
    await writeFile(join(main.cache, "dep.js"), "installed in the main store");

    // The pointer form `avcs worktree attach` writes — no git needed to exercise it.
    await writeFile(join(linked, ".avcs"), `avcsdir: ${join(dir, ".avcs")}\n`);
    const attached = await Repo.open(linked);
    assert.deepEqual((await attached.readSharedPaths()).map((e) => e.path), ["node_modules"], "config comes from the main store too");

    const out2 = await mkdtemp(join(tmpdir(), "avcs-ws2-"));
    const via = (await attached.projectInto(out2, "main")).shared[0]!;
    assert.equal(via.cache, main.cache, "one store ⇒ one cache (docs/14's model)");
    assert.equal(via.populated, true, "which is the point: no second install");
    assert.equal(await readFile(join(out2, "node_modules", "dep.js"), "utf8"), "installed in the main store");
    await rm(out2, { recursive: true, force: true });
  } finally {
    for (const d of [dir, linked, out]) await rm(d, { recursive: true, force: true });
  }
});

test("`avcs workspace project` tells the human whether an install is owed", async () => {
  const { dir, repo } = await projectable();
  const out = await mkdtemp(join(tmpdir(), "avcs-ws-"));
  try {
    const first = avcs(dir, "workspace", "project", "feat-x", "--out", out);
    assert.match(first, /shared: node_modules/);
    assert.match(first, /EMPTY/, "the one thing a human needs to know on the first projection");

    const key = (await repo.readSharedPaths()).length ? (await repo.projectInto(out, "main")).shared[0]!.cache : "";
    await writeFile(join(key, "dep.js"), "x");
    const second = avcs(dir, "workspace", "project", "feat-x", "--out", out);
    assert.match(second, /shared: node_modules/);
    assert.doesNotMatch(second, /EMPTY/, "and on the second, nothing is owed");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

// ── Slice 4: capture contamination is structurally impossible (S1, S7, S8, S8b) ──

test("S1 — with no shared-paths.json, projection and capture behave exactly as before", async () => {
  // The backward-compatibility gate. Everything this track adds must be inert when nothing
  // is configured, and "inert" is asserted directly rather than assumed.
  const dir = await mk();
  try {
    const repo = await Repo.init(dir);
    await put(repo, "pnpm-lock.yaml", "lockfileVersion: 1\n");
    await put(repo, "src/a.ts", "export const a = 1;\n");

    const res = await repo.materialize("main");
    const projected = await repo.projectInto(dir, "main");
    assert.deepEqual(projected.written, [...res.tree.keys()].sort(), "every tree entry written, none skipped");
    assert.deepEqual(projected.shared, [], "no shared paths ⇒ nothing linked");
    assert.deepEqual(projected.skipped, []);
    assert.equal(existsSync(join(dir, ".avcs", "shared")), false, "no cache tree is created");
    assert.equal(existsSync(join(dir, ".avcs", "shared-paths.json")), false, "and no config file appears");

    // Byte-level: the projection is what materializedBytes says it is.
    for (const f of await repo.materializedBytes(res)) {
      assert.deepEqual(await readFile(join(dir, f.path)), f.bytes, f.path);
    }

    // `checkoutInto` still answers with the same list it always did.
    assert.deepEqual(await repo.checkoutInto(dir, "main"), projected.written);

    // Capture: a directory that LOOKS like a build environment is still captured, because
    // nothing declared it shared. The core has no built-in list of "obviously shared" names,
    // and this is what proves it (docs/21 §2-1: path rules only, no ecosystem knowledge).
    await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
    await writeFile(join(dir, "node_modules", "dep", "index.js"), "module.exports = 1;");
    const cap = await repo.commitWorkingTree(dir, { message: "capture", actor: dev });
    assert.deepEqual(cap.added, ["node_modules/dep/index.js"], "unconfigured ⇒ captured, as always");

    // Round trip: projecting that capture reproduces the identical tree, treeHash included.
    const after = await repo.materialize("main");
    const back = await mkdtemp(join(tmpdir(), "avcs-back-"));
    await repo.projectInto(back, "main");
    for (const f of await repo.materializedBytes(after)) {
      assert.deepEqual(await readFile(join(back, f.path)), f.bytes, f.path);
    }
    assert.equal((await repo.commitWorkingTree(back, { message: "no-op", actor: dev })).ops.length, 0, "and re-capturing it is a no-op");
    await rm(back, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S7 — files inside a shared path are never captured, even absent from .avcsignore", async () => {
  // Principle 5: contamination must be structurally impossible. Forgetting to list
  // `node_modules` in `.avcsignore` must not be able to capture 50k files, so the shared
  // paths are folded into the ignore predicate IN THE CORE.
  const { dir, repo } = await projectable();
  try {
    await repo.projectInto(dir, "main");
    assert.equal(existsSync(join(dir, ".avcsignore")), false, "nothing is written to .avcsignore — the config is not the defence");

    // A REAL directory at the shared path (not the symlink) is the hard case: the walk can
    // descend into it, so only the ignore composition stops it.
    await rm(join(dir, "node_modules"), { recursive: true, force: true });
    await mkdir(join(dir, "node_modules", ".pnpm", "lodash@4"), { recursive: true });
    for (const n of ["a", "b", "c"]) await writeFile(join(dir, "node_modules", ".pnpm", "lodash@4", `${n}.js`), "x");
    await writeFile(join(dir, "node_modules", ".modules.yaml"), "hoisted: true");

    const cap = await repo.commitWorkingTree(dir, { message: "capture", actor: dev });
    assert.deepEqual(cap.ops, [], "op 0개");
    assert.deepEqual([cap.added, cap.modified, cap.removed], [[], [], []]);

    // A file OUTSIDE the shared path still captures — the predicate is scoped, not global.
    await writeFile(join(dir, "src", "b.ts"), "export const b = 2;\n");
    assert.deepEqual((await repo.commitWorkingTree(dir, { message: "real change", actor: dev })).added, ["src/b.ts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S8 — a symlinked shared path is not captured because Dirent means lstat (regression pin)", async () => {
  // This is a DEPENDENCE, not a change: `#readWorkTree` branches on `Dirent`, whose type
  // predicates are lstat-based, so a symlink is neither isDirectory() nor isFile() and the
  // walk never enters or reads it. docs/21 R3 calls this an implicit dependency; the point of
  // this test is to make a refactor to `stat` fail loudly instead of capturing a whole cache.
  const { dir, repo } = await projectable();
  try {
    const link = (await repo.projectInto(dir, "main")).shared[0]!;
    // Fill the cache the way an install would — through the link, from the workspace's side.
    await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
    await writeFile(join(dir, "node_modules", "dep", "index.js"), "module.exports = 1;");
    assert.equal(existsSync(join(link.cache, "dep", "index.js")), true, "the write landed in the cache");

    // The pin: Dirent must classify the entry as neither a directory nor a file.
    const ent = (await readdir(dir, { withFileTypes: true })).find((e) => e.name === "node_modules")!;
    assert.equal(ent.isSymbolicLink(), true);
    assert.equal(ent.isDirectory(), false, "if this ever becomes true the walk will capture the whole cache");
    assert.equal(ent.isFile(), false);

    // And the consequence: capture skips it EVEN WITH NO SHARED CONFIG AT ALL, which is what
    // isolates this test to the lstat dependency rather than the ignore composition (S8b).
    assert.equal(await repo.removeSharedPath("node_modules"), true);
    assert.deepEqual((await repo.readSharedPaths()), []);
    const cap = await repo.commitWorkingTree(dir, { message: "capture", actor: dev });
    assert.deepEqual(cap.ops, [], "op 0개 — the symlink alone was enough");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S8b — `mode: copy` puts a REAL directory there, and the ignore composition is its only defence", async () => {
  const { dir, repo } = await projectable({ mode: "copy" });
  try {
    const link = (await repo.projectInto(dir, "main")).shared[0]!;
    await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
    await writeFile(join(dir, "node_modules", "dep", "index.js"), "module.exports = 1;");
    assert.equal((await lstat(join(dir, "node_modules"))).isSymbolicLink(), false, "a real directory: the walk CAN descend");

    assert.deepEqual((await repo.commitWorkingTree(dir, { message: "capture", actor: dev })).ops, [], "op 0개");

    // Ablation, in the test itself: drop the shared path and the same files DO get captured.
    // That is the proof that the composition — not the filesystem — is what held here.
    await repo.removeSharedPath("node_modules");
    const leaked = await repo.commitWorkingTree(dir, { message: "unguarded", actor: dev });
    assert.deepEqual(leaked.added, ["node_modules/dep/index.js"], "unguarded, copy mode leaks — hence S8b exists");
    assert.equal(link.mode, "copy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("`avcs shared` lists, adds and removes", async () => {
  const dir = await mk();
  try {
    await Repo.init(dir);
    assert.match(avcs(dir, "shared", "ls"), /no shared paths/);
    avcs(dir, "shared", "add", "node_modules", "--key-from", "pnpm-lock.yaml", "--mode", "copy");
    const ls = avcs(dir, "shared", "ls");
    assert.match(ls, /node_modules/);
    assert.match(ls, /pnpm-lock\.yaml/);
    assert.match(ls, /copy/);
    avcs(dir, "shared", "rm", "node_modules");
    assert.match(avcs(dir, "shared", "ls"), /no shared paths/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
