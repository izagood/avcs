// M4: in-process metrics — cache hit/miss + materialize timing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { Metrics } from "../src/observe/metrics.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };

test("metrics record cache hit/miss and materialize calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "1\n", declaredPurpose: "a" });
  await repo.materialize(); // miss
  await repo.materialize(); // hit
  await repo.materialize(); // hit
  const s = repo.metrics.snapshot();
  assert.equal(s.counters["materialize.calls"], 3);
  assert.equal(s.counters["reduce.cache.miss"], 1);
  assert.equal(s.counters["reduce.cache.hit"], 2);
  assert.ok((s.timings["reduce.ms"]?.count ?? 0) >= 1, "reduce timed");
  await rm(dir, { recursive: true, force: true });
});

test("Metrics unit: counters, timings, snapshot, reset", async () => {
  const m = new Metrics();
  m.inc("x"); m.inc("x", 2);
  await m.time("op", async () => { await new Promise((r) => setTimeout(r, 1)); });
  const s = m.snapshot();
  assert.equal(s.counters["x"], 3);
  assert.equal(s.timings["op"]?.count, 1);
  assert.ok((s.timings["op"]?.avgMs ?? 0) >= 0);
  m.reset();
  assert.deepEqual(m.snapshot(), { counters: {}, timings: {} });
});
