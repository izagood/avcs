// issue #118 — `undo` is the moment a git-trained user first meets the projection model
// (working dir = materialized view), and the CLI said nothing about it:
//
//   (a) `undo --last` leaves the working tree as it was — correct, but surprising — with
//       no hint that `avcs checkout` re-projects the view. The output must END with that
//       working-tree consequence, except where the purge path already printed its own
//       (the leak warning / git-plane message), where a checkout hint would mislead.
//   (b) `avcs log` afterwards lists the undone op unmarked, so history reads as if the
//       undo never happened. The display layer must mark it `(undone by undo_…)` —
//       storage and object model unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Run the CLI, returning `{ status, out }` — never throwing, so exit codes are assertable. */
function cli(cwd: string, ...a: string[]): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ["--experimental-strip-types", CLI, ...a], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/** Standalone repo (no git) with two commits: `a\n` then `a\nb\n` — the issue's repro. */
async function seeded(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-undo-cli-"));
  cli(dir, "init", ".");
  await writeFile(join(dir, "f.txt"), "a\n", "utf8");
  cli(dir, "commit", "-m", "initial import");
  await writeFile(join(dir, "f.txt"), "a\nb\n", "utf8");
  cli(dir, "commit", "-m", "add b");
  return dir;
}

test("undo names the working-tree consequence and the checkout that settles it", async () => {
  const dir = await seeded();
  try {
    const r = cli(dir, "undo", "--last");
    assert.equal(r.status, 0, r.out);
    // The tree really was left alone — the premise of the hint.
    assert.equal(await readFile(join(dir, "f.txt"), "utf8"), "a\nb\n");
    assert.match(r.out, /working tree not touched/, `undo must state the tree consequence:\n${r.out}`);
    assert.match(r.out, /avcs checkout/, `undo must name the command that re-projects:\n${r.out}`);
    // It is the LAST thing said — the consequence, not an aside buried mid-output.
    const lines = r.out.trim().split("\n");
    assert.match(lines[lines.length - 1] as string, /avcs checkout/, `hint must end the output:\n${r.out}`);
    // And the named command actually settles the tree.
    const c = cli(dir, "checkout");
    assert.equal(c.status, 0, c.out);
    assert.equal(await readFile(join(dir, "f.txt"), "utf8"), "a\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("log marks the undone op — and only it", async () => {
  const dir = await seeded();
  try {
    const u = cli(dir, "undo", "--last");
    assert.equal(u.status, 0, u.out);
    const undoOid = /recorded as (undo_[0-9a-f]+)/.exec(u.out)?.[1];
    assert.ok(undoOid, `undo must report its oid:\n${u.out}`);
    const r = cli(dir, "log");
    assert.equal(r.status, 0, r.out);
    const marked = r.out.split("\n").filter((l) => l.includes("undone by"));
    assert.equal(marked.length, 1, `exactly the undone op is marked:\n${r.out}`);
    assert.match(marked[0] as string, new RegExp(`undone by ${undoOid.slice(0, 16)}`), r.out);
    // The first commit's op stays unmarked — history is annotated, not rewritten.
    assert.doesNotMatch(r.out.split("undone by")[0] as string, /undo_/, r.out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("purge already states the tree consequence — no second, contradicting hint", async () => {
  const dir = await seeded();
  try {
    const r = cli(dir, "undo", "--last", "--purge");
    assert.equal(r.status, 0, r.out);
    // The leak warning is the working-tree consequence on this path (issue #97)…
    assert.match(r.out, /still on disk/, r.out);
    // …so the checkout hint must not pile on top and muddle which instruction to follow.
    assert.doesNotMatch(r.out, /avcs checkout/, `purge path must not add the checkout hint:\n${r.out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
