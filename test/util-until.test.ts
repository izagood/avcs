// `until` — the polling wait the async tests are built on (issue #55).
//
// The flake it caused: a wall-clock budget cannot tell "the condition is false" apart from
// "the event loop was too busy to evaluate it". Under the full suite, other tests block the
// loop with synchronous work (a full reduce under AVCS_VERIFY_INCREMENTAL=1 especially), so
// the 50 ms poll does not get to run — the deadline passes having sampled the condition a
// handful of times, and the test reports a timeout for work that was merely starved.
//
// Measured for context: the sync-watch contention alert lands in 51–306 ms when the loop is
// free, against an 8 s budget. A failure there is not a slow machine, it is a loop that
// never got a turn.
//
// So the budget is spent in POLLS as well as milliseconds: a wait fails only once it has
// actually looked enough times. Raising the millisecond number would have made the flake
// rarer without making the wait honest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { until } from "./helpers/until.ts";

test("resolves as soon as the condition holds", async () => {
  let n = 0;
  await until(async () => ++n >= 3, { timeoutMs: 5_000, label: "third call" });
  assert.equal(n, 3);
});

test("a condition that is already true does not wait at all", async () => {
  const t0 = Date.now();
  await until(async () => true, { timeoutMs: 5_000, label: "immediate" });
  assert.ok(Date.now() - t0 < 200, "returned promptly");
});

test("a genuinely false condition still fails, and names what it was waiting for", async () => {
  await assert.rejects(
    () => until(async () => false, { timeoutMs: 300, minPolls: 3, label: "never happens" }),
    /never happens/,
  );
});

test("the deadline alone cannot fail a wait that has not been given its polls", async () => {
  // The starvation case. The clock is long past the budget on the first look, but the wait
  // has sampled the condition once — so it keeps going, and succeeds when the condition
  // becomes true. Before this, the same sequence reported a spurious timeout.
  let calls = 0;
  const start = Date.now() - 60_000; // pretend the loop was blocked for a minute
  await until(async () => ++calls >= 4, { timeoutMs: 10, minPolls: 5, label: "starved", now: () => Date.now(), startedAt: start });
  assert.equal(calls, 4, "the condition was evaluated to a real answer, not guessed at");
});

test("the failure message reports how many times it actually looked", async () => {
  // Distinguishes "false 200 times" from "false twice because nothing ran" when someone is
  // reading a CI log rather than reproducing locally.
  await assert.rejects(
    () => until(async () => false, { timeoutMs: 200, minPolls: 4, label: "x" }),
    (e: Error) => /poll/i.test(e.message) && /\d/.test(e.message),
  );
});

test("an exception from the condition is not swallowed into a timeout", async () => {
  await assert.rejects(
    () => until(async () => { throw new Error("condition blew up"); }, { timeoutMs: 500, label: "boom" }),
    /condition blew up/,
  );
});
