// Tests for MCP/CLI repo discovery: a single server (or a CLI run from a subdirectory)
// must locate the owning AVCS repo without being pinned to one cwd at boot. Covers the
// upward `.avcs` root-finding and the per-call resolution precedence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { ObjectStore } from "../src/store/objectStore.ts";
import { resolveRepoDir } from "../src/mcp/server.ts";

async function tmpRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-disco-"));
  await Repo.init(dir);
  return dir;
}

const noRoots = async (): Promise<string[]> => [];

test("findRepoRoot resolves a repo dir, an ancestor of a subdir, and null otherwise", async () => {
  const dir = await tmpRepo();
  try {
    assert.equal(ObjectStore.findRepoRoot(dir), dir, "the repo dir itself");
    const deep = join(dir, "src", "nested");
    await mkdir(deep, { recursive: true });
    assert.equal(ObjectStore.findRepoRoot(deep), dir, "a subdirectory ascends to the repo");
    const outside = await mkdtemp(join(tmpdir(), "avcs-none-"));
    try {
      assert.equal(ObjectStore.findRepoRoot(outside), null, "no .avcs at or above → null");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRepoDir honors the per-call cwd, including a subdirectory of the repo", async () => {
  const dir = await tmpRepo();
  try {
    assert.equal(await resolveRepoDir(dir, noRoots), dir);
    const sub = join(dir, "pkg", "a");
    await mkdir(sub, { recursive: true });
    assert.equal(await resolveRepoDir(sub, noRoots), dir, "subdir cwd resolves to the repo");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRepoDir falls back to client-advertised workspace roots when cwd misses", async () => {
  const dir = await tmpRepo();
  const elsewhere = await mkdtemp(join(tmpdir(), "avcs-elsew-"));
  try {
    // callCwd is a non-repo dir; the repo is only discoverable via the client roots.
    const roots = async (): Promise<string[]> => [elsewhere, dir];
    assert.equal(await resolveRepoDir(elsewhere, roots), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

// Run `fn` with process.cwd() pointed at a guaranteed non-repo dir, so the final
// `process.cwd()` fallback in resolveRepoDir can't accidentally resolve to the repo this
// test suite itself lives in. Restores the original cwd afterward.
async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

test("resolveRepoDir throws an actionable error listing where it searched", async () => {
  const a = await mkdtemp(join(tmpdir(), "avcs-x-"));
  const b = await mkdtemp(join(tmpdir(), "avcs-y-"));
  try {
    await withCwd(a, () =>
      assert.rejects(
        () => resolveRepoDir(a, async () => [b]),
        (e: Error) => {
          assert.match(e.message, /could not locate an AVCS repo/);
          assert.match(e.message, new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          assert.match(e.message, /AVCS_REPO|avcs init/);
          return true;
        },
      ),
    );
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("non-repo client roots are tried and skipped, then cwd resolves the repo", async () => {
  const dir = await tmpRepo();
  const miss = await mkdtemp(join(tmpdir(), "avcs-miss-"));
  try {
    const sub = join(dir, "w");
    await mkdir(sub, { recursive: true });
    // The client advertises a non-repo root; resolution must skip it and not fail. Here cwd
    // (a subdir of the repo) is checked before roots, so it resolves first.
    assert.equal(await resolveRepoDir(sub, async () => [miss]), dir);
    // When a client lacks the `roots` capability the server's wrapper yields [] (no throw);
    // with cwd also missing (and the process cwd neutralized), resolution surfaces the error.
    await withCwd(miss, () => assert.rejects(() => resolveRepoDir(miss, noRoots), /could not locate an AVCS repo/));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(miss, { recursive: true, force: true });
  }
});
