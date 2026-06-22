// docs/16 §5 — evidence binds to a treeHash, and trust requires author ≠ signer
// (self-produced evidence is provisional only, regardless of actor kind).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const mk = () => mkdtemp(join(tmpdir(), "avcs-ev-"));
const human: Actor = { kind: "human", id: "human:h" };
const ci: Actor = { kind: "ci_bot", id: "ci:runner" };

test("evidence records the treeHash it was produced against (docs/16 §5)", async () => {
  const dir = await mk();
  const repo = await Repo.init(dir);
  try {
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: human });
    const op = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: human, path: "f.ts", content: "1\n", declaredPurpose: "p" });
    const evOid = await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "pass", producedBy: ci, treeHash: "deadbeef" });
    const ev = (await repo.store.get(evOid)) as { treeHash?: string };
    assert.equal(ev.treeHash, "deadbeef", "treeHash is persisted on the evidence object");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("self-produced evidence does not satisfy the gate for ANY actor kind; independent evidence does (docs/16 §5)", async () => {
  const dir = await mk();
  const repo = await Repo.init(dir);
  try {
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: human });
    // a behavior-changing op authored by human:h
    const op = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: human, path: "impl.ts", content: "export const f = () => 2;\n", declaredPurpose: "behavior", effects: { changesBehavior: true } });

    // self evidence (same actor id, human) — must NOT satisfy the gate (author ≠ signer)
    await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "pass", producedBy: human });
    assert.notEqual((await repo.materialize("main")).statuses.get(op), "accepted", "self-produced evidence is ignored even for a human author");

    // independent evidence (different id) — now the gate can accept
    await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "pass", producedBy: ci });
    assert.equal((await repo.materialize("main")).statuses.get(op), "accepted", "independent evidence satisfies the gate");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
