// `avcs clone` and the working tree (issue #96).
//
// clone fetched the object DAG and stopped: the target directory held only `.avcs`. Nothing
// said so, and the next `avcs commit` read that empty directory as "every tracked file was
// deleted" — on a ~360-file repo, one command authored ~360 delete ops and collapsed the
// view to a single file. `undo` restores the exact prior treeHash, so it was recoverable,
// but a `sync` before noticing propagates the deletion, and the output gave no hint.
//
// Two things are fixed here, and the second one matters on its own: materializing at clone
// closes the path that produced the report, and a mass-delete guard closes the same trap
// reached another way (a tree moved aside, a directory emptied, a clone from before this
// change). Both are tested.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import type { Actor } from "../src/objects/types.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const ai: Actor = { kind: "ai_agent", id: "ai:a" };

/**
 * Run the real CLI, so these cover what a user types rather than an API shortcut.
 *
 * ASYNC on purpose. `execFileSync` blocks the event loop, and the hub these tests clone from
 * runs IN THIS PROCESS — so a synchronous spawn deadlocks: the child's `GET /have` can never
 * be served, and the test fails with `fetch failed` after the timeout rather than telling you
 * why. Cost me a 10-minute run to find.
 */
const run = promisify(execFile);
async function cli(cwd: string, ...a: string[]): Promise<string> {
  const { stdout, stderr } = await run(process.execPath, ["--experimental-strip-types", CLI, ...a], { cwd, encoding: "utf8" });
  return `${stdout}${stderr}`;
}
/** The same, for a command expected to fail: returns its combined output. */
async function cliFails(cwd: string, ...a: string[]): Promise<string> {
  try {
    await cli(cwd, ...a);
    return "";
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
}

/** A hub holding a small repo — several files, so "most of them" is meaningful. */
async function seededHub(): Promise<{
  url: string;
  paths: string[];
  close: () => Promise<void>;
}> {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-96-hub-"));
  const srcDir = await mkdtemp(join(tmpdir(), "avcs-96-src-"));
  const hub = await startHub({ repoDir: hubDir });
  const src = await Repo.init(srcDir);
  await src.provisionOwnerKey({ kind: "human", id: "human:h" });

  const intent = await src.createIntent({ title: "seed", owner: "human:h" });
  const sess = await src.startSession({ intentOid: intent, actor: ai });
  const paths = ["a.ts", "b.ts", "c.ts", "src/d.ts", "src/e.ts", "docs/f.md"];
  for (const p of paths) {
    await src.proposeFileWrite({
      sessionOid: sess, intentOid: intent, actor: ai,
      path: p, content: `// ${p}\nexport const x = "${p}"\n`, declaredPurpose: "seed",
    });
  }
  await src.pushHub(hub.url, { as: "human:h" });

  return {
    url: hub.url,
    paths,
    close: async () => {
      await hub.close();
      for (const d of [hubDir, srcDir]) await rm(d, { recursive: true, force: true });
    },
  };
}

test("clone leaves a usable working tree, not just .avcs", async () => {
  const h = await seededHub();
  const dest = await mkdtemp(join(tmpdir(), "avcs-96-dest-"));
  try {
    const out = await cli(dest, "clone", h.url, ".");

    const entries = (await readdir(dest)).filter((e) => e !== ".avcs");
    assert.ok(entries.length > 0, `clone left only .avcs — output was:\n${out}`);
    for (const p of h.paths) {
      assert.ok(existsSync(join(dest, p)), `${p} is on disk`);
      assert.equal(await readFile(join(dest, p), "utf8"), `// ${p}\nexport const x = "${p}"\n`);
    }
    // And it says what it wrote, not only what it fetched.
    assert.match(out, /file|wrote/i, "the output accounts for the working tree");
  } finally {
    await h.close();
    await rm(dest, { recursive: true, force: true });
  }
});

// The reported bug, end to end: this is the sequence that destroyed the view.
test("committing right after a clone does not author a mass deletion", async () => {
  const h = await seededHub();
  const dest = await mkdtemp(join(tmpdir(), "avcs-96-dest-"));
  try {
    await cli(dest, "clone", h.url, ".");
    const before = await Repo.open(dest);
    const filesBefore = (await before.materialize("main")).tree.size;
    assert.equal(filesBefore, h.paths.length, "the clone's view has every file");

    await writeFile(join(dest, "note.md"), "// a note\n", "utf8");
    const out = await cli(dest, "commit", "-m", "chore: a note");

    assert.doesNotMatch(out, /^\s*D /m, `no deletions should be authored:\n${out}`);
    const after = await Repo.open(dest);
    assert.equal(
      (await after.materialize("main")).tree.size,
      filesBefore + 1,
      "the view gained one file and lost none",
    );
  } finally {
    await h.close();
    await rm(dest, { recursive: true, force: true });
  }
});

// The guard, reached a different way: materializing at clone does not help a tree that was
// emptied afterwards, and a repo cloned by an older avcs is already in that state.
test("commit refuses when almost every tracked file vanished from disk", async () => {
  const h = await seededHub();
  const dest = await mkdtemp(join(tmpdir(), "avcs-96-dest-"));
  try {
    await cli(dest, "clone", h.url, ".");
    for (const e of (await readdir(dest)).filter((x) => x !== ".avcs")) {
      await rm(join(dest, e), { recursive: true, force: true });
    }

    const out = await cliFails(dest, "commit", "-m", "chore: oops");
    assert.notEqual(out, "", "commit must refuse rather than author the deletions");
    assert.match(out, /delet/i, "the message names what it refused to do");
    // The user's real next step is one of two things; both must be reachable from the text.
    assert.match(out, /materialize|--allow/i, "and how to proceed either way");

    // Nothing was authored: the view is untouched.
    const repo = await Repo.open(dest);
    assert.equal((await repo.materialize("main")).tree.size, h.paths.length);
  } finally {
    await h.close();
    await rm(dest, { recursive: true, force: true });
  }
});

test("a deliberate mass deletion is still possible, explicitly", async () => {
  const h = await seededHub();
  const dest = await mkdtemp(join(tmpdir(), "avcs-96-dest-"));
  try {
    await cli(dest, "clone", h.url, ".");
    for (const e of (await readdir(dest)).filter((x) => x !== ".avcs")) {
      await rm(join(dest, e), { recursive: true, force: true });
    }

    // Deleting a whole tree IS a legitimate operation; it just must not happen by accident.
    await cli(dest, "commit", "-m", "chore: remove everything", "--allow-mass-delete");

    const repo = await Repo.open(dest);
    assert.equal((await repo.materialize("main")).tree.size, 0, "the deletion was authored");
  } finally {
    await h.close();
    await rm(dest, { recursive: true, force: true });
  }
});

// Ordinary work must not trip the guard — that would be worse than the bug.
test("deleting a few files among many is ordinary work and is not blocked", async () => {
  const h = await seededHub();
  const dest = await mkdtemp(join(tmpdir(), "avcs-96-dest-"));
  try {
    await cli(dest, "clone", h.url, ".");
    await rm(join(dest, "a.ts"));
    await rm(join(dest, "b.ts"));

    const out = await cli(dest, "commit", "-m", "chore: drop two files");
    assert.match(out, /D a\.ts/);
    assert.match(out, /D b\.ts/);

    const repo = await Repo.open(dest);
    assert.equal((await repo.materialize("main")).tree.size, h.paths.length - 2);
  } finally {
    await h.close();
    await rm(dest, { recursive: true, force: true });
  }
});

// A deletion that comes WITH other work is a refactor, not an accident.
test("a large deletion accompanied by edits is not blocked", async () => {
  const h = await seededHub();
  const dest = await mkdtemp(join(tmpdir(), "avcs-96-dest-"));
  try {
    await cli(dest, "clone", h.url, ".");
    for (const e of (await readdir(dest)).filter((x) => x !== ".avcs")) {
      await rm(join(dest, e), { recursive: true, force: true });
    }
    // The tree was replaced, not emptied.
    await writeFile(join(dest, "rewritten.ts"), "export const v = 2\n", "utf8");

    const out = await cli(dest, "commit", "-m", "refactor: replace the tree");
    assert.match(out, /A rewritten\.ts/);

    const repo = await Repo.open(dest);
    assert.equal((await repo.materialize("main")).tree.size, 1);
  } finally {
    await h.close();
    await rm(dest, { recursive: true, force: true });
  }
});

// An empty repo has no files to lose, so the guard must not fire on a first commit.
test("the guard does not fire on a repo with nothing tracked yet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-96-fresh-"));
  try {
    await cli(dir, "init", ".");
    await writeFile(join(dir, "first.ts"), "export const a = 1\n", "utf8");
    const out = await cli(dir, "commit", "-m", "feat: first");
    assert.match(out, /A first\.ts/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
