// Phase 13.2 (docs/17 §13.2) — lamport quality fixes, NOT an HLC. Correctness never
// depended on lamport (the reducer totally orders by (lamport, oid)); these fix the
// ORDERING QUALITY defects: imported history was not observed, and two processes
// sharing one .avcs could issue overlapping lamports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import type { Actor, Operation } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function author(repo: Repo, path: string, content: string): Promise<string> {
  const intent = await repo.createIntent({ title: "t", owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  return repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path, content, declaredPurpose: `write ${path}` });
}

async function lamportOf(repo: Repo, opOid: string): Promise<number> {
  return (await repo.store.get<Operation>(opOid)).lamport;
}

test("observe-on-import: after a local-dir pull, new lamports sort after the imported history", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "avcs-A-"));
  const dirB = await mkdtemp(join(tmpdir(), "avcs-B-"));
  try {
    const A = await Repo.init(dirA);
    const B = await Repo.init(dirB);
    // B accumulates a deeper history (higher lamports) than A.
    let bMax = 0;
    for (let i = 0; i < 5; i++) bMax = Math.max(bMax, await lamportOf(B, await author(B, `b${i}.ts`, `${i}\n`)));
    const aFirst = await lamportOf(A, await author(A, "a.ts", "A\n"));
    assert.ok(bMax > aFirst, "precondition: B's history is ahead of A's clock");

    await A.pull(dirB);
    const aNext = await lamportOf(A, await author(A, "a2.ts", "A2\n"));
    assert.ok(aNext > bMax, `post-pull op (${aNext}) sorts after everything imported (${bMax})`);
  } finally {
    await Promise.all([dirA, dirB].map((d) => rm(d, { recursive: true, force: true })));
  }
});

test("observe-on-import: pullHub advances the clock past the hub's history", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "avcs-A-"));
  const dirB = await mkdtemp(join(tmpdir(), "avcs-B-"));
  const dirHub = await mkdtemp(join(tmpdir(), "avcs-hub-"));
  const A = await Repo.init(dirA);
  const B = await Repo.init(dirB);
  await Repo.init(dirHub);
  const hub = await startHub({ repoDir: dirHub, port: 0 });
  try {
    let bMax = 0;
    for (let i = 0; i < 5; i++) bMax = Math.max(bMax, await lamportOf(B, await author(B, `b${i}.ts`, `${i}\n`)));
    await B.pushHub(hub.url);

    await A.pullHub(hub.url);
    const aNext = await lamportOf(A, await author(A, "a.ts", "A\n"));
    assert.ok(aNext > bMax, `post-pullHub op (${aNext}) sorts after the hub's history (${bMax})`);
  } finally {
    await hub.close();
    await Promise.all([dirA, dirB, dirHub].map((d) => rm(d, { recursive: true, force: true })));
  }
});

test("multi-process reseed: two handles on one .avcs never issue overlapping lamports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-mp-"));
  try {
    await Repo.init(dir);
    // Two independent handles = two processes sharing the store (e.g. CLI + MCP server).
    // Both open at clock 0; without the op-log reseed they would both stamp lamport 1.
    const p1 = await Repo.open(dir);
    const p2 = await Repo.open(dir);

    const l1 = await lamportOf(p1, await author(p1, "one.ts", "1\n"));
    const l2 = await lamportOf(p2, await author(p2, "two.ts", "2\n"));
    const l3 = await lamportOf(p1, await author(p1, "three.ts", "3\n"));
    const l4 = await lamportOf(p2, await author(p2, "four.ts", "4\n"));

    assert.ok(l2 > l1, `p2's first op (${l2}) observed p1's op (${l1}) via the op-log tail`);
    assert.ok(l3 > l2 && l4 > l3, `interleaved authoring stays strictly increasing: ${[l1, l2, l3, l4]}`);
    assert.equal(new Set([l1, l2, l3, l4]).size, 4, "no duplicate lamports across processes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
