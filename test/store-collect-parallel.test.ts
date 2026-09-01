// `collect` must not read objects one at a time.
//
// It drained `list()`, a generator that awaits one `readFile` per object, so gathering N
// objects cost N round-trips of latency with the CPU idle in between. Every caller that
// wants a whole type paid it — `gc` (operations + blobs), evidence/decision gathering,
// intent and lease listing, the MCP context and watch paths.
//
// `listOids` already enumerates the same set in the same order without reading a body, so
// `collect` names the oids up front and reads them in a bounded fan-out. `list` stays a
// generator: it is the memory-bounded streaming API, and a caller that streams does not
// want the whole type buffered.
//
// Order and set must not change — several callers index or diff the result — so both are
// pinned against `list()` itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { ObjectStore } from "../src/store/objectStore.ts";
import type { Operation } from "../src/objects/types.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function seeded(ops: number): Promise<{ dir: string; repo: Repo }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-collect-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  for (let i = 0; i < ops; i++) {
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: `f${i}.ts`, content: `v${i}\n`, declaredPurpose: `w${i}` });
  }
  return { dir, repo };
}

test("collect yields exactly what list yields, in the same order", async () => {
  const { dir, repo } = await seeded(12);
  const streamed: string[] = [];
  for await (const o of repo.store.list<Operation>("operation")) streamed.push(o.oid as string);
  const collected = (await repo.store.collect<Operation>("operation")).map((o) => o.oid as string);

  assert.deepEqual(collected, streamed, "collect must keep list's order, not completion order");
  assert.ok(streamed.length >= 12, `fixture should have written operations, got ${streamed.length}`);
  await rm(dir, { recursive: true, force: true });
});

test("collect overlaps its reads", async () => {
  const { dir, repo } = await seeded(12);
  const original = ObjectStore.prototype.get;
  let inFlight = 0;
  let peak = 0;
  ObjectStore.prototype.get = function (this: ObjectStore, oid: string) {
    inFlight++;
    if (inFlight > peak) peak = inFlight;
    return (original as (o: string) => Promise<unknown>).call(this, oid).finally(() => void inFlight--) as ReturnType<typeof original>;
  } as typeof ObjectStore.prototype.get;
  try {
    await repo.store.collect<Operation>("operation");
  } finally {
    ObjectStore.prototype.get = original;
  }
  assert.ok(peak > 1, `object reads never overlapped (peak in-flight ${peak}) — collect is still serial`);
  await rm(dir, { recursive: true, force: true });
});

test("collect still surfaces a corrupt body rather than skipping it", async () => {
  // `list` decoded every object and threw on a bad one. Reading through `get` must keep
  // that: a shorter list would be a silently wrong answer, which is worse than an error.
  const { dir, repo } = await seeded(3);
  const { writeFile, readdir } = await import("node:fs/promises");
  const objects = join(dir, ".avcs", "objects");
  let victim: string | null = null;
  for (const shard of await readdir(objects)) {
    for (const f of await readdir(join(objects, shard))) {
      if (f.startsWith("operation_")) { victim = join(objects, shard, f); break; }
    }
    if (victim) break;
  }
  assert.ok(victim, "fixture should have written a loose operation object");
  await writeFile(victim, "not cbor", "utf8");
  await assert.rejects(repo.store.collect<Operation>("operation"));
  await rm(dir, { recursive: true, force: true });
});
