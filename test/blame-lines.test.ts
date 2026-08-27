import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";

/**
 * Per-line provenance: "why is THIS line here" answered with the operation
 * that last wrote it — plus its intent and purpose. Entity-level `blame`
 * answers only "who owns the file now".
 */

const alice = { id: "alice", kind: "human" as const };
const bob = { id: "bob", kind: "human" as const };

async function repoWithFile(): Promise<Repo> {
  const repo = await Repo.init(await mkdtemp(join(tmpdir(), "avcs-blame-lines-")));
  await repo.provisionOwnerKey(alice);
  return repo;
}

/**
 * Author a sequential edit: anchored on the current frontier via causalDeps,
 * the way commitWorkingTree (and every real client) does. Without the anchor
 * two writes to one file are concurrent and land as needs_decision.
 */
async function write(
  repo: Repo,
  actor: { id: string; kind: "human" },
  title: string,
  path: string,
  content: string,
): Promise<string> {
  const res = await repo.materialize();
  const intentOid = await repo.createIntent({ title, owner: actor.id });
  const sessionOid = await repo.startSession({ intentOid, actor });
  return repo.proposeFileWrite({
    sessionOid,
    intentOid,
    actor,
    path,
    content,
    declaredPurpose: title,
    causalDeps: res.headOps,
  });
}

test("attributes each line to the operation that last wrote it", async () => {
  const repo = await repoWithFile();
  const op1 = await write(repo, alice, "seed the file", "a.ts", "one\ntwo\nthree\n");
  const op2 = await write(repo, bob, "change the middle line", "a.ts", "one\nTWO\nthree\n");

  const lines = await repo.blameLines("file:a.ts", "a.ts");
  assert.equal(lines.length, 3);

  assert.deepEqual(
    lines.map((l) => l.text),
    ["one", "TWO", "three"],
  );
  assert.deepEqual(
    lines.map((l) => l.line),
    [1, 2, 3],
  );

  // Untouched lines keep their original author; the edited one moves to bob.
  assert.equal(lines[0]!.op, op1);
  assert.equal(lines[0]!.actor.id, "alice");
  assert.equal(lines[0]!.intentTitle, "seed the file");

  assert.equal(lines[1]!.op, op2);
  assert.equal(lines[1]!.actor.id, "bob");
  assert.equal(lines[1]!.intentTitle, "change the middle line");
  assert.equal(lines[1]!.purpose, "change the middle line");

  assert.equal(lines[2]!.op, op1);
  assert.equal(lines[2]!.actor.id, "alice");
});

test("attributes inserted lines to the inserting op, not its neighbours", async () => {
  const repo = await repoWithFile();
  const op1 = await write(repo, alice, "seed", "b.ts", "head\ntail\n");
  const op2 = await write(repo, bob, "insert a middle", "b.ts", "head\nmiddle\ntail\n");

  const lines = await repo.blameLines("file:b.ts", "b.ts");
  assert.deepEqual(
    lines.map((l) => [l.text, l.op]),
    [
      ["head", op1],
      ["middle", op2],
      ["tail", op1],
    ],
  );
});

test("returns an empty list for a path not in the projection", async () => {
  const repo = await repoWithFile();
  await write(repo, alice, "seed", "c.ts", "x\n");
  assert.deepEqual(await repo.blameLines("file:missing.ts", "missing.ts"), []);
});
