// The post-merge hook rebuilt every index and log on every pull, in every mode (#184). Only
// committed mode can have objects that arrived outside the store's own writes — git unioning
// `.avcs/objects` onto disk — so only there is there anything to reindex. In sidecar mode the
// rebuild re-read every op for nothing: 29 s of a 32 s hook on a 9k-op store, most of the
// deadline gone before the capture even started.
//
// `reindex()` starts by removing `.avcs/indexes/` wholesale, so a sentinel file placed inside
// it is a deterministic witness: gone ⇒ reindex ran, present ⇒ it did not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Repo } from "../src/api/repo.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const run = (cwd: string, ...a: string[]) =>
  spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...a], { cwd, encoding: "utf8", env: { ...process.env, AVCS_HOOK_TIMEOUT_MS: "0" } });

async function gitRepoWithStore(): Promise<{ dir: string; repo: Repo; sentinel: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-postmerge-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  const repo = await Repo.init(dir);
  await writeFile(join(dir, "a.txt"), "a\n");
  await repo.commitWorkingTree(dir, { message: "seed", actor: { kind: "human", id: "human:t" } });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: dir });
  const indexes = join(dir, ".avcs", "indexes");
  await mkdir(indexes, { recursive: true });
  const sentinel = join(indexes, "SENTINEL");
  await writeFile(sentinel, "if reindex ran, I am gone\n");
  return { dir, repo, sentinel };
}

test("sidecar: post-merge does not reindex — nothing arrived outside the store", { skip: !hasGit }, async () => {
  const { dir, sentinel } = await gitRepoWithStore();
  try {
    const r = run(dir, "git-hook", "post-merge");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(sentinel), "reindex must not run in sidecar mode");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("committed: post-merge still reindexes — git may have unioned objects onto disk", { skip: !hasGit }, async () => {
  const { dir, repo, sentinel } = await gitRepoWithStore();
  try {
    await repo.setGitMode("committed");
    const r = run(dir, "git-hook", "post-merge");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(sentinel), "reindex must run in committed mode");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
