// `avcs clone --at <cp>` — clone a specific checkpoint.
//
// clone always projected the DEFAULT view. A caller that wanted a different one had to
// clone and then `checkout`, and that composition is not a checkout: `projectInto` writes
// the target tree's files and **removes nothing**, so the working directory ends up the
// UNION of both trees. Files from the default view that the target does not contain stay
// on disk.
//
// git needs only one of two safeguards to avoid this, and has both: `clone -b <name>`
// lands the right tree in one step, and `checkout` removes tracked files the target lacks
// (its index says which files are its own). avcs has neither, so the union is not an edge
// case — it is what clone-then-checkout always produces.
//
// This closes the first gap. Writing one tree into an empty directory needs no knowledge
// of what was there before, so it is correct by construction: exactly the operation a
// consumer that wants "give me this tree" is asking for.
//
// An unknown `--at` must fail loudly rather than fall back to the default view: a caller
// that named a checkpoint and silently got a different tree has no way to notice.
//
// `--view <name>` is NOT here, and the reason is a separate gap: a clone cannot resolve a
// view name at all, because `view:*` refs stay local and are never transferred (see the
// comment on the refs loop in hubClient — "Working refs (view:*/checkpoint:*) stay local").
// A checkpoint needs no ref: it is a content address, so `--at` works with objects alone.
// Advertising views over the protocol is its own question and is out of scope here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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
const run = promisify(execFile);

/** The real CLI. Async on purpose — the hub runs in this process, so a sync spawn deadlocks. */
async function cli(cwd: string, ...a: string[]): Promise<string> {
  const { stdout, stderr } = await run(
    process.execPath,
    ["--experimental-strip-types", CLI, ...a],
    { cwd, encoding: "utf8" },
  );
  return `${stdout}${stderr}`;
}
async function cliFails(cwd: string, ...a: string[]): Promise<string> {
  try {
    await cli(cwd, ...a);
    return "";
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
}

/**
 * A hub whose default view and second view differ in a way the union would hide.
 *
 * The separating file exists ONLY on the default view. If clone projects the default
 * view and a checkout is layered on top, that file survives — which is exactly the
 * pollution these tests must detect. A test where both views hold the same paths would
 * pass either way, so the fork order below matters and is measured.
 */
async function twoViewHub(): Promise<{
  url: string;
  view: string;
  checkpoint: string;
  onlyInMain: string;
  onlyInOther: string;
  close: () => Promise<void>;
}> {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-cva-hub-"));
  const srcDir = await mkdtemp(join(tmpdir(), "avcs-cva-src-"));
  const hub = await startHub({ repoDir: hubDir });
  const src = await Repo.init(srcDir);
  await src.provisionOwnerKey({ kind: "human", id: "human:h" });

  const write = async (path: string, body: string, line?: string): Promise<void> => {
    const intent = await src.createIntent({ title: `add ${path}`, owner: "human:h" });
    const sess = await src.startSession({ intentOid: intent, actor: ai });
    await src.proposeFileWrite({
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

  // Fork FIRST, then write to each side. A line inherits its base up to the fork point,
  // so a file authored on main BEFORE the fork is on both views — measured, and it makes
  // the union undetectable. Writing to main AFTER the fork is what separates the trees:
  //
  //   main    → added-to-main-after-fork.ts, shared.ts
  //   feature → only-in-other.ts,            shared.ts
  await src.createLine("feature", "main");
  await write("only-in-other.ts", "export const o = 1\n", "feature");
  await write("added-to-main-after-fork.ts", "export const m = 1\n");

  const checkpoint = await src.createCheckpoint("feature", "human:h");
  await src.pushHub(hub.url, { as: "human:h" });

  return {
    url: hub.url,
    view: "feature",
    checkpoint,
    onlyInMain: "added-to-main-after-fork.ts",
    onlyInOther: "only-in-other.ts",
    close: async () => {
      await hub.close();
      for (const d of [hubDir, srcDir]) await rm(d, { recursive: true, force: true });
    },
  };
}

test("clone --at lands that checkpoint's frozen tree", async () => {
  const h = await twoViewHub();
  const dest = await mkdtemp(join(tmpdir(), "avcs-cva-dest2-"));
  try {
    const out = await cli(dest, "clone", h.url, ".", "--at", h.checkpoint);

    assert.ok(existsSync(join(dest, h.onlyInOther)), `${h.onlyInOther} must be present:\n${out}`);
    assert.equal(
      existsSync(join(dest, h.onlyInMain)),
      false,
      `a checkpoint names one frozen tree; the default view's extra file must not appear:\n${out}`,
    );
  } finally {
    await rm(dest, { recursive: true, force: true });
    await h.close();
  }
});

test("an unknown checkpoint fails loudly", async () => {
  const h = await twoViewHub();
  const dest = await mkdtemp(join(tmpdir(), "avcs-cva-dest5-"));
  try {
    const out = await cliFails(dest, "clone", h.url, ".", "--at", "checkpoint_deadbeef");
    assert.match(out, /checkpoint_deadbeef|checkpoint/i, `the error must say what failed:\n${out}`);
  } finally {
    await rm(dest, { recursive: true, force: true });
    await h.close();
  }
});
