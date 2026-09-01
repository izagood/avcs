import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLimit } from "../src/concurrency/mapLimit.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

test("mapLimit keeps input order and bounds the fan-out", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([...Array(20).keys()], 4, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick();
    inFlight--;
    return n * 2;
  });
  assert.deepEqual(out, [...Array(20).keys()].map((n) => n * 2), "results follow input order");
  assert.equal(peak, 4, `fan-out should saturate the limit exactly, peaked at ${peak}`);
});

test("mapLimit keeps working when one item is much slower than the rest", async () => {
  // A worker that takes the next index only after its own item settles must not let the
  // slow item hold up the queue — the other workers drain it.
  const order: number[] = [];
  await mapLimit([...Array(8).keys()], 2, async (n) => {
    if (n === 0) await new Promise<void>((r) => setTimeout(r, 25));
    else await tick();
    order.push(n);
  });
  assert.equal(order.length, 8);
  assert.ok(order.indexOf(0) > 2, `the slow item should finish late, finished at ${order.indexOf(0)}`);
});

test("mapLimit propagates the first rejection and tolerates an empty input", async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  await assert.rejects(
    mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    }),
    /boom/,
  );
});

test("mapLimit treats a limit below one as one", async () => {
  let peak = 0;
  let inFlight = 0;
  await mapLimit([1, 2, 3], 0, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick();
    inFlight--;
  });
  assert.equal(peak, 1);
});
