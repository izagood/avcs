// A projection that never removes is not a projection.
//
// The working tree in a sidecar repo is DERIVED: the view decides what is there. But
// `checkoutInto` only ever wrote — it iterated the target tree and never looked at the
// directory — so a file the previous projection put on disk stayed after switching to a
// view that does not contain it. Two projections layered on each other produce their
// UNION, and `clone` + `checkout` is exactly that composition (clone lands the default
// view; checkout lands the target on top).
//
// git avoids this with the index: it knows which files are its own, so `checkout` removes
// the ones the target lacks and leaves untracked and ignored files alone. avcs had no
// equivalent — and did not need to invent one, because `projectInto` already COMPUTES the
// list of files it wrote and then threw it away.
//
// So the record is that list. `checkout` deletes (previously projected) − (target), which
// gives git's semantics with the projection record standing in for the index:
//
//   - projected before, absent from target  → removed
//   - never projected (node_modules, ignored, a file the user just created) → untouched
//   - projected before, edited since        → kept, and reported: an uncaptured edit is
//                                             work, and losing it silently is worse than
//                                             leaving one stale file behind
//
// That last rule is why the record stores each file's blob oid and not only its path:
// without it, "unchanged since I wrote it" and "the user edited it" are indistinguishable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

/**
 * A repo with two lines whose trees genuinely differ.
 *
 * The fork must come BEFORE the main-only write: a line inherits its base up to the fork
 * point, so a file authored on main first appears on both views and the union becomes
 * undetectable. Measured, not assumed.
 */
async function twoLineRepo(): Promise<{
  repo: Repo;
  dir: string;
  onlyOnMain: string;
  onlyOnFeature: string;
  close: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-stale-"));
  const repo = await Repo.init(dir);
  await repo.provisionOwnerKey({ kind: "human", id: "human:h" });

  const write = async (path: string, body: string, line?: string): Promise<void> => {
    const intent = await repo.createIntent({ title: `add ${path}`, owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    await repo.proposeFileWrite({
      sessionOid: sess,
      intentOid: intent,
      actor: ai,
      path,
      content: body,
      declaredPurpose: "seed",
      ...(line ? { line } : {}),
    });
  };

  await write("shared.ts", "export const shared = 1\n");
  await repo.createLine("feature", "main");
  await write("only-on-feature.ts", "export const f = 1\n", "feature");
  await write("only-on-main.ts", "export const m = 1\n");

  return {
    repo,
    dir,
    onlyOnMain: "only-on-main.ts",
    onlyOnFeature: "only-on-feature.ts",
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

test("switching views removes a file the target does not contain", async () => {
  const t = await twoLineRepo();
  try {
    await t.repo.checkoutInto(t.dir, "main");
    assert.ok(existsSync(join(t.dir, t.onlyOnMain)), "main's file must be projected first");

    await t.repo.checkoutInto(t.dir, "feature");
    assert.ok(existsSync(join(t.dir, t.onlyOnFeature)), "the target's file must be present");
    // The defect this file exists for.
    assert.equal(
      existsSync(join(t.dir, t.onlyOnMain)),
      false,
      "a file only the previous view had must not survive — that is the union",
    );
    assert.ok(existsSync(join(t.dir, "shared.ts")), "a file both views have must stay");
  } finally {
    await t.close();
  }
});

test("a file avcs never projected is left alone", async () => {
  const t = await twoLineRepo();
  try {
    await t.repo.checkoutInto(t.dir, "main");

    // The two shapes that must survive: a build artifact directory, and a file the user
    // just created and has not captured yet.
    await mkdir(join(t.dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(t.dir, "node_modules", "pkg", "index.js"), "module.exports = 1\n");
    await writeFile(join(t.dir, "scratch.txt"), "mine\n");

    await t.repo.checkoutInto(t.dir, "feature");

    assert.ok(existsSync(join(t.dir, "node_modules", "pkg", "index.js")), "node_modules must survive");
    assert.ok(existsSync(join(t.dir, "scratch.txt")), "an uncaptured new file must survive");
  } finally {
    await t.close();
  }
});

test("a projected file the user edited is kept, not silently deleted", async () => {
  const t = await twoLineRepo();
  try {
    await t.repo.checkoutInto(t.dir, "main");
    // An edit that has not been captured yet is WORK. The target view does not contain
    // this path, so a naive "remove what the target lacks" would delete it.
    await writeFile(join(t.dir, t.onlyOnMain), "export const m = 2 // my edit\n");

    await t.repo.checkoutInto(t.dir, "feature");

    assert.ok(
      existsSync(join(t.dir, t.onlyOnMain)),
      "an edited file must not be removed — losing uncaptured work is worse than one stale file",
    );
    assert.match(
      await readFile(join(t.dir, t.onlyOnMain), "utf8"),
      /my edit/,
      "the user's bytes must be intact",
    );
  } finally {
    await t.close();
  }
});

test("exporting to a fresh directory removes nothing and records nothing", async () => {
  const t = await twoLineRepo();
  const out = await mkdtemp(join(tmpdir(), "avcs-stale-out-"));
  try {
    await t.repo.checkoutInto(t.dir, "main");
    await writeFile(join(out, "pre-existing.txt"), "not mine\n");

    // `materialize --out` / `workspace project` go through projectInto directly. They are
    // exports, not the repo's own working tree, so they must not delete and must not
    // disturb the in-place record.
    await t.repo.projectInto(out, "feature");
    assert.ok(existsSync(join(out, "pre-existing.txt")), "an export must not delete");

    // The in-place record still describes main, so this switch still cleans up.
    await t.repo.checkoutInto(t.dir, "feature");
    assert.equal(
      existsSync(join(t.dir, t.onlyOnMain)),
      false,
      "an export in between must not have consumed the in-place record",
    );
  } finally {
    await rm(out, { recursive: true, force: true });
    await t.close();
  }
});

test("the record survives a fresh Repo handle — it is on disk, not in memory", async () => {
  const t = await twoLineRepo();
  try {
    await t.repo.checkoutInto(t.dir, "main");

    // A new process is the normal case: the git hook, the CLI and the daemon are all
    // separate invocations. A record held only in memory would never clean anything.
    const reopened = await Repo.open(t.dir);
    await reopened.checkoutInto(t.dir, "feature");

    assert.equal(existsSync(join(t.dir, t.onlyOnMain)), false, "a reopened repo must clean up");
  } finally {
    await t.close();
  }
});

test("re-projecting the same view is a no-op, not a delete-and-rewrite", async () => {
  const t = await twoLineRepo();
  try {
    await t.repo.checkoutInto(t.dir, "main");
    // git-sync reprojects on every hook. If that path deleted and rewrote, it would churn
    // mtimes (the thing issue #64 fixed) and race any tool watching the tree.
    await t.repo.checkoutInto(t.dir, "main");
    assert.ok(existsSync(join(t.dir, t.onlyOnMain)), "the view's own files must remain");
    assert.ok(existsSync(join(t.dir, "shared.ts")), "and so must the rest");
  } finally {
    await t.close();
  }
});
