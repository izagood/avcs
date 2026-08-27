import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import {
  importGitHistory,
  gitCliSource,
  type GitHistorySource,
  type GitCommitRecord,
} from "../src/importer/gitHistory.ts";

// git is optional for the suite (same pattern as git-bridge.test.ts): the CLI
// source shells out to git, so those tests skip without it. The pure-source
// test runs everywhere — that is the point of the GitHistorySource seam.
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", dir, "-c", "user.name=Imp Orter", "-c", "user.email=imp@example.com", ...args],
    { encoding: "utf8" },
  );
}

/** A real git repo with adds, edits, a delete, binary content, a co-author, and a merge. */
async function gitFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-git-src-"));
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "a.txt"), "one\n");
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs", "b.md"), "# b\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "add a and b");

  await writeFile(join(dir, "a.txt"), "one\ntwo\n");
  await writeFile(join(dir, "bin.dat"), Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "grow a, add binary");

  git(dir, "rm", "-q", "docs/b.md");
  git(
    dir,
    "commit",
    "-q",
    "-m",
    "drop b\n\nCo-authored-by: Pair Person <pair@example.com>",
  );

  // A merge: the importer replays first-parent history, so the merge commit's
  // diff against its first parent must carry the side branch's file.
  git(dir, "checkout", "-q", "-b", "feature");
  await writeFile(join(dir, "f.txt"), "from feature\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "feature file");
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
  return dir;
}

/** All files at git HEAD as path → bytes (the ground truth to converge on). */
function gitHeadFiles(dir: string): Map<string, Buffer> {
  const names = git(dir, "ls-tree", "-r", "HEAD", "--name-only").split("\n").filter(Boolean);
  const out = new Map<string, Buffer>();
  for (const name of names) {
    out.set(
      name,
      execFileSync("git", ["-C", dir, "show", `HEAD:${name}`], { maxBuffer: 1 << 26 }),
    );
  }
  return out;
}

test("replays first-parent git history into an operation graph", { skip: !hasGit }, async () => {
  const src = await gitFixture();
  const repoDir = await mkdtemp(join(tmpdir(), "avcs-import-"));
  const repo = await Repo.init(repoDir);

  const seen: string[] = [];
  const result = await importGitHistory(repo, src, {
    actor: { id: "importer", kind: "ci_bot" },
    onCommit: (done, sha) => seen.push(`${done}:${sha.slice(0, 4)}`),
  });

  // First-parent line: add / grow / drop / merge — the feature commit itself
  // is squashed into the merge's first-parent diff.
  assert.equal(result.commits, 4);
  assert.ok(result.operations >= 5); // 3 adds + 1 edit + 1 delete + 1 merge write
  assert.equal(seen.length, 4);

  // The materialized tree converges byte-for-byte on git HEAD.
  const res = await repo.materialize();
  const files = new Map(
    (await repo.materializedBytes(res)).map((f) => [f.path, Buffer.from(f.bytes)]),
  );
  const truth = gitHeadFiles(src);
  assert.deepEqual([...files.keys()].sort(), [...truth.keys()].sort());
  for (const [path, bytes] of truth) {
    assert.ok(files.get(path)!.equals(bytes), `content mismatch: ${path}`);
  }

  // Provenance: one intent per non-empty commit, titled by the commit subject;
  // ops carry the git author identity and the sha inside declaredPurpose.
  const intents = await repo.listIntents();
  const titles = intents.map((i) => i.title);
  assert.ok(titles.includes("add a and b"));
  assert.ok(titles.includes("merge feature"));

  const blame = await repo.blame("file:a.txt");
  assert.equal(blame?.actor.id, "git:imp@example.com");

  const history = await repo.historyOf("file:docs/b.md");
  const last = history[history.length - 1]!;
  assert.ok(last.declaredPurpose.includes("[git "));
  assert.deepEqual(last.coAuthors?.map((a) => a.id), ["git:pair@example.com"]);

  await rm(src, { recursive: true, force: true });
});

test("a pure GitHistorySource needs no git binary", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "avcs-import-pure-"));
  const repo = await Repo.init(repoDir);

  const commits: GitCommitRecord[] = [
    {
      sha: "a".repeat(40),
      subject: "seed",
      message: "seed",
      authorName: "Pure",
      authorEmail: "pure@example.com",
      authorDate: "2026-01-01T00:00:00Z",
      coAuthors: [],
      changes: [
        { path: "x.ts", kind: "write", read: async () => Buffer.from("export const x = 1;\n") },
      ],
    },
    {
      sha: "b".repeat(40),
      subject: "drop x, add y",
      message: "drop x, add y",
      authorName: "Pure",
      authorEmail: "pure@example.com",
      authorDate: "2026-01-02T00:00:00Z",
      coAuthors: [],
      changes: [
        { path: "x.ts", kind: "delete" },
        { path: "y.ts", kind: "write", read: async () => Buffer.from("export const y = 2;\n") },
      ],
    },
  ];
  const source: GitHistorySource = {
    async *commits() {
      yield* commits;
    },
  };

  const result = await importGitHistory(repo, source, { actor: { id: "importer", kind: "ci_bot" } });
  assert.equal(result.commits, 2);
  assert.equal(result.operations, 3);

  const res = await repo.materialize();
  const files = await repo.materializedFiles(res);
  assert.deepEqual(files.map((f) => f.path), ["y.ts"]);
});

test("gitCliSource resolves a bare clone from a bundle", { skip: !hasGit }, async () => {
  const src = await gitFixture();
  const bundle = join(await mkdtemp(join(tmpdir(), "avcs-bundle-")), "src.bundle");
  git(src, "bundle", "create", bundle, "--all");

  const source = await gitCliSource({ bundle });
  let count = 0;
  for await (const c of source.commits()) {
    assert.match(c.sha, /^[0-9a-f]{40}$/);
    count += 1;
  }
  await source.close?.();
  assert.equal(count, 4); // first-parent of main

  await rm(src, { recursive: true, force: true });
});
