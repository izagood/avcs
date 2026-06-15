// Unit tests for the Lamport logical clock — the reducer's deterministic tie-break
// for genuinely concurrent operations. Wall-clock is advisory and never decides order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LamportClock, nowStamp } from "../src/core/clock.ts";

test("tick is strictly monotonic from the default start", () => {
  const c = new LamportClock();
  assert.equal(c.value, 0);
  assert.equal(c.tick(), 1);
  assert.equal(c.tick(), 2);
  assert.equal(c.tick(), 3);
  assert.equal(c.value, 3);
});

test("constructor seed is respected", () => {
  const c = new LamportClock(41);
  assert.equal(c.value, 41);
  assert.equal(c.tick(), 42);
});

test("observe merges a remote stamp then advances past it", () => {
  const c = new LamportClock(5);
  // Remote is ahead → jump past it.
  assert.equal(c.observe(10), 11);
  assert.equal(c.value, 11);
  // Remote is behind → still advance locally (never go backwards).
  assert.equal(c.observe(3), 12);
  assert.equal(c.value, 12);
  // Remote equals local → strictly greater than both.
  assert.equal(c.observe(12), 13);
});

test("two replicas converge to causally-correct order via observe", () => {
  // Classic Lamport guarantee: if A happens-before B, stamp(A) < stamp(B).
  const a = new LamportClock();
  const b = new LamportClock();
  const sendA = a.tick(); // A local event
  const recvB = b.observe(sendA); // B receives A's message
  assert.ok(recvB > sendA, "the receiver's clock strictly exceeds the sender's stamp");
});

test("nowStamp advances the clock and records an ISO-8601 wall time", () => {
  const c = new LamportClock();
  const s1 = nowStamp(c);
  const s2 = nowStamp(c);
  assert.equal(s1.lamport, 1);
  assert.equal(s2.lamport, 2);
  // Wall is a valid ISO timestamp (advisory only).
  assert.equal(new Date(s1.wall).toISOString(), s1.wall);
  assert.match(s1.wall, /^\d{4}-\d{2}-\d{2}T/);
});
