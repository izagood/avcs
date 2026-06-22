// docs/16 §8 — validate_run redefinition: bind evidence to the materialized treeHash, and
// allow running IN PLACE (project:false) in a dir that already has the build env, so Node/
// pnpm checks work without avcs owning install (issue #11).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { runChecks } from "../src/validation/runner.ts";
import type { Actor } from "../src/objects/types.ts";

const mk = () => mkdtemp(join(tmpdir(), "avcs-vr-"));
const human: Actor = { kind: "human", id: "human:h" };
const ci: Actor = { kind: "ci_bot", id: "ci:runner" };

test("runChecks binds evidence to the materialized treeHash (docs/16 §8)", async () => {
  const dir = await mk();
  const wsdir = await mk();
  const repo = await Repo.init(dir);
  try {
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: human });
    const op = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: human, path: "f.ts", content: "1\n", declaredPurpose: "p" });
    const result = await repo.materialize("main");
    const [evOid] = await runChecks(repo, {
      ops: [op],
      workspaceDir: wsdir,
      ciActor: ci,
      checks: [{ kind: "unit_test", command: "true" }],
    });
    const ev = (await repo.store.get(evOid!)) as { treeHash?: string; result: string };
    assert.equal(ev.result, "pass");
    assert.equal(ev.treeHash, result.treeHash, "evidence is bound to the materialized treeHash");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(wsdir, { recursive: true, force: true });
  }
});

test("runChecks project:false runs in place — preserves the dir's build env, no reproject (issue #11)", async () => {
  const dir = await mk();
  const wsdir = await mk();
  const repo = await Repo.init(dir);
  try {
    // wsdir already holds a "build env" marker (stand-in for an installed node_modules)
    await writeFile(join(wsdir, "node_modules_marker"), "deps\n");
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: human });
    const op = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: human, path: "src.ts", content: "1\n", declaredPurpose: "p" });

    const [evOid] = await runChecks(repo, {
      ops: [op],
      workspaceDir: wsdir,
      project: false, // run in place — do NOT reproject into wsdir
      ciActor: ci,
      checks: [{ kind: "unit_test", command: "test -f node_modules_marker" }],
    });
    const ev = (await repo.store.get(evOid!)) as { result: string };
    assert.equal(ev.result, "pass", "ran in place; the pre-existing build env was preserved");
    assert.equal(existsSync(join(wsdir, "src.ts")), false, "project:false does not reproject the view into the dir");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(wsdir, { recursive: true, force: true });
  }
});
