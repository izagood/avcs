// Phase 3: validation runner. A check whose command exits 0 yields a "pass"
// Evidence; a command that exits non-zero yields a "fail" Evidence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { runChecks } from "../src/validation/runner.ts";
import type { Actor, Evidence } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const ci: Actor = { kind: "ci_bot", id: "ci:runner" };

test("runChecks attaches pass and fail evidence from real commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-runner-"));
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "phase3", owner: human.id });
    const session = await repo.startSession({ intentOid: intent, actor: ai });
    const op = await repo.proposeFileWrite({
      sessionOid: session,
      intentOid: intent,
      actor: ai,
      path: "ok.txt",
      content: "hello\n",
      declaredPurpose: "add ok.txt",
    });

    const workspaceDir = join(dir, "work");
    const oids = await runChecks(repo, {
      ops: [op],
      view: "main",
      workspaceDir,
      ciActor: ci,
      checks: [
        { kind: "unit_test", command: 'node -e "process.exit(0)"' },
        { kind: "lint", command: 'node -e "process.exit(1)"' },
      ],
    });

    assert.equal(oids.length, 2, "one evidence oid per check");

    const passEv = await repo.store.get<Evidence>(oids[0]!);
    const failEv = await repo.store.get<Evidence>(oids[1]!);

    assert.equal(passEv.type, "evidence");
    assert.equal(passEv.kind, "unit_test");
    assert.equal(passEv.result, "pass");
    assert.deepEqual(passEv.forOps, [op]);
    assert.equal(passEv.producedBy.id, ci.id);

    assert.equal(failEv.kind, "lint");
    assert.equal(failEv.result, "fail");

    // Cross-check via collect(): both evidence objects are persisted.
    const all = await repo.store.collect<Evidence>("evidence");
    const byOid = new Map(all.map((e) => [e.oid as string, e]));
    assert.ok(byOid.has(oids[0]!));
    assert.ok(byOid.has(oids[1]!));
    assert.equal(byOid.get(oids[0]!)!.result, "pass");
    assert.equal(byOid.get(oids[1]!)!.result, "fail");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChecks treats command-not-found as fail, not a throw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-runner-"));
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "phase3", owner: human.id });
    const session = await repo.startSession({ intentOid: intent, actor: ai });
    const op = await repo.proposeFileWrite({
      sessionOid: session,
      intentOid: intent,
      actor: ai,
      path: "ok.txt",
      content: "hello\n",
      declaredPurpose: "add ok.txt",
    });

    const oids = await runChecks(repo, {
      ops: [op],
      workspaceDir: join(dir, "work"),
      ciActor: ci,
      checks: [{ kind: "typecheck", command: "this-binary-does-not-exist-xyz --version" }],
    });

    assert.equal(oids.length, 1);
    const ev = await repo.store.get<Evidence>(oids[0]!);
    assert.equal(ev.result, "fail", "a missing command must produce a fail, never throw");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
