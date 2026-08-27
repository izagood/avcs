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
