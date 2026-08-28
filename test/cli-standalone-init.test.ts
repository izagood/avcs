// `avcs init` outside a git repo — the standalone case, which docs/16 §2-1 calls the
// primary one ("avcs는 git 없이 완전해야 한다. 물리 격리도 avcs가 제공한다. git은 브리지일 뿐").
//
// The bridge hooks are already conditional: `init` probes for a git hooks dir and the
// catch says "not a git repo — fine". But the probe inherited stderr, so git printed
// `fatal: not a git repository` for an error the CLI had deliberately decided to ignore.
// A standalone user's very first command therefore ended in a red `fatal:`, and the
// obvious reading — that git is required, or that `--no-hooks` is the standalone flag —
// is exactly backwards from what avcs is.
//
// Every other git probe in the CLI already routes through `gitCmd`, which sets
// stdio: ["ignore", "pipe", "ignore"]. These two call sites just did not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

/** Run the CLI capturing both streams separately — the point of these tests is stderr. */
const run = (cwd: string, ...a: string[]) =>
  spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...a], { cwd, encoding: "utf8" });

const mkdir_ = () => mkdtemp(join(tmpdir(), "avcs-solo-"));

test("init outside a git repo says nothing about git on stderr", async () => {
  const dir = await mkdir_();
  try {
    await writeFile(join(dir, "greet.py"), "def greet(n):\n    return n\n", "utf8");

    const r = run(dir, "init", ".");

    assert.equal(r.status, 0, `init should succeed without git\n${r.stderr}`);
    assert.equal(
      r.stderr.trim(),
      "",
      "a probe whose failure the CLI deliberately ignores must not print git's error to the user",
    );
    assert.match(r.stdout, /initialized AVCS repo/);
    // …and it is a real, usable repo, not a half-made one.
    assert.ok(existsSync(join(dir, ".avcs")), "store exists");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the standalone loop needs no flags: init → commit → status", async () => {
  const dir = await mkdir_();
  try {
    await writeFile(join(dir, "greet.py"), "def greet(n):\n    return n\n", "utf8");

    // Plain `avcs init .` — no --no-hooks. Standalone is the default shape, not an opt-out.
    assert.equal(run(dir, "init", ".").status, 0);

    const c = run(dir, "commit", "-m", "feat: greet");
    assert.equal(c.status, 0, c.stderr);
    assert.equal(c.stderr.trim(), "");
    assert.match(c.stdout, /A greet\.py/);

    const s = run(dir, "status");
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.stderr.trim(), "");
    assert.match(s.stdout, /files: 1\b/);
    assert.match(s.stdout, /conflicts: 0\b/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("install-hooks outside a git repo explains itself instead of leaking git's error", async () => {
  const dir = await mkdir_();
  try {
    assert.equal(run(dir, "init", ".").status, 0);

    const r = run(dir, "install-hooks");

    // Whatever it decides to do, it must not hand the user a raw `fatal:` from a probe.
    assert.doesNotMatch(r.stderr, /fatal: not a git repository/,
      "the CLI knows there is no git here; it should say so in its own words");
    // Asking for the git bridge where there is no git is a real mistake, so it should be
    // reported as one — but in terms the user can act on.
    if (r.status !== 0) assert.match(r.stderr, /git/i, "the message should name what is missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inside a git repo, init still installs the bridge hooks", { skip: !hasGit }, async () => {
  const dir = await mkdir_();
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: dir, stdio: "ignore" });
    await writeFile(join(dir, "greet.py"), "def greet(n):\n    return n\n", "utf8");

    const r = run(dir, "init", ".");

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /installed git hooks/, "the bridge is still opt-out, not opt-in");
    assert.ok(existsSync(join(dir, ".git", "hooks", "pre-commit")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
