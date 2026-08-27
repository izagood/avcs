// The CLI side of linked-working-tree support: writing the `.avcs` pointer, keeping it out
// of git, attaching new trees automatically, and refusing to fork the history by accident.
// Unlike worktree-pointer.test.ts (core, git-free), these exercise the git bridge, so they
// drive the real CLI through a real git repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

function avcs(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", CLI, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
/** stderr of a CLI call expected to fail; throws if it unexpectedly succeeds. */
function avcsErr(cwd: string, args: string[]): string {
  try {
    avcs(cwd, args);
  } catch (e) {
    return String((e as { stderr?: Buffer | string }).stderr ?? e);
  }
  throw new Error(`expected \`avcs ${args.join(" ")}\` to fail, but it succeeded`);
}

/** A git repo with one commit, an AVCS store, and a linked working tree on a branch.
 *  Hooks are off by default so each test opts into the automation it means to exercise. */
async function fixture(opts?: { hooks?: boolean }): Promise<{ main: string; linked: string }> {
  const base = await mkdtemp(join(tmpdir(), "avcs-wt-cli-"));
  const main = join(base, "main");
  await mkdir(main, { recursive: true });
  for (const a of [
    ["init", "-q", "-b", "main", main],
    ["-C", main, "config", "user.email", "t@example.com"],
    ["-C", main, "config", "user.name", "t"],
    ["-C", main, "commit", "-q", "--allow-empty", "-m", "root"],
  ]) execFileSync("git", a, { stdio: "ignore" });
  avcs(main, opts?.hooks ? ["init"] : ["init", "--no-hooks"]);
  const linked = join(base, "linked");
  execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "topic", linked], { stdio: "ignore" });
  return { main, linked };
}

test("attach writes a pointer at the main checkout and makes the tree usable", async () => {
  const { main, linked } = await fixture();
  assert.match(avcsErr(linked, ["status"]), /not an AVCS repo/);

  assert.match(avcs(linked, ["worktree", "attach"]), /attached/);
  assert.equal(
    await readFile(join(linked, ".avcs"), "utf8"),
    `avcsdir: ${join(realpathSync(main), ".avcs")}\n`, // git reports the realpath (macOS /var -> /private/var)
  );
  assert.match(avcs(linked, ["status"]), /view:/);
});

test("attach git-ignores the pointer so the working tree stays clean", async () => {
  const { linked } = await fixture();
  avcs(linked, ["worktree", "attach"]);
  assert.equal(git(linked, ["status", "--porcelain"]), "");
});

test("attach is idempotent, and refuses to shadow a real store", async () => {
  const { linked } = await fixture();
  avcs(linked, ["worktree", "attach"]);
  avcs(linked, ["worktree", "attach"]);
  assert.match(avcs(linked, ["status"]), /view:/);

  const solo = await mkdtemp(join(tmpdir(), "avcs-solo-"));
  avcs(solo, ["init", "--no-hooks"]);
  assert.match(avcsErr(solo, ["worktree", "attach", "--to", solo]), /already has its own store/);
});

test("--to attaches with no git in the picture", async () => {
  const base = await mkdtemp(join(tmpdir(), "avcs-nogit-"));
  const main = join(base, "m");
  const linked = join(base, "l");
  await mkdir(main, { recursive: true });
  await mkdir(linked, { recursive: true });
  avcs(main, ["init", "--no-hooks"]);
  avcs(linked, ["worktree", "attach", "--to", main]);
  assert.match(avcs(linked, ["status"]), /view:/);
});

test("attach says what it needs when there is nothing to infer from", async () => {
  const lonely = await mkdtemp(join(tmpdir(), "avcs-lonely-"));
  assert.match(avcsErr(lonely, ["worktree", "attach"]), /--to/);
});

test("status reports where the store lives; detach removes the pointer", async () => {
  const { main, linked } = await fixture();
  avcs(linked, ["worktree", "attach"]);
  const st = avcs(linked, ["worktree", "status"]);
  assert.match(st, /attached/);
  assert.ok(st.includes(join(realpathSync(main), ".avcs")), `status should name the store, got: ${st}`);

  assert.match(avcs(linked, ["worktree", "detach"]), /detached/);
  assert.equal(existsSync(join(linked, ".avcs")), false);
  assert.match(avcs(main, ["worktree", "status"]), /own store/);
});

test("detach refuses to delete a real store", async () => {
  const { main } = await fixture();
  assert.match(avcsErr(main, ["worktree", "detach"]), /real store/);
  assert.equal(statSync(join(main, ".avcs")).isDirectory(), true);
});

test("attach refuses committed git mode, where git already delivers the store", async () => {
  const { main, linked } = await fixture();
  avcs(main, ["git-mode", "committed"]);
  assert.match(avcsErr(linked, ["worktree", "attach"]), /committed/);
});
