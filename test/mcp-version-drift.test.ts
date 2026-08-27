// A long-lived stdio server holds the code it was spawned with, so upgrading the installed
// package does not reach a running process. What to DO about that depends entirely on the
// client: exiting is only correct if the client respawns you. Claude Code — the common case —
// does not; it reports the server as disconnected and waits for a manual reconnect. Exiting
// there removes every AVCS tool from a live session with no visible reason, which is strictly
// worse than serving slightly-stale code that still works.
//
// So the default is: say so, keep serving. These tests pin that decision and the one-shot
// notice, with the version reader injected — the real one reads the installed package.json,
// which a test must not mutate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { watchVersionDrift } from "../src/mcp/server.ts";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("no drift → the notice never fires", async () => {
  const seen: unknown[] = [];
  const w = watchVersionDrift({
    bootVersion: "1.0.0",
    readVersion: () => "1.0.0",
    intervalMs: 1,
    isBusy: () => false,
    onDrift: (from, to) => seen.push([from, to]),
  });
  await tick(30);
  w?.stop();
  assert.deepEqual(seen, []);
});

test("drift fires once, with both versions, and stops watching", async () => {
  const seen: string[][] = [];
  let current = "1.0.0";
  const w = watchVersionDrift({
    bootVersion: "1.0.0",
    readVersion: () => current,
    intervalMs: 1,
    isBusy: () => false,
    onDrift: (from, to) => seen.push([from, to]),
  });
  current = "1.1.0";
  await tick(40);
  w?.stop();
  assert.deepEqual(seen, [["1.0.0", "1.1.0"]], "one notice, not one every interval");
});

test("a call in flight defers the notice until the server is idle", async () => {
  const seen: string[][] = [];
  let busy = true;
  const w = watchVersionDrift({
    bootVersion: "1.0.0",
    readVersion: () => "2.0.0",
    intervalMs: 1,
    isBusy: () => busy,
    onDrift: (from, to) => seen.push([from, to]),
  });
  await tick(20);
  assert.deepEqual(seen, [], "must not interrupt work in progress");
  busy = false;
  await tick(20);
  w?.stop();
  assert.deepEqual(seen, [["1.0.0", "2.0.0"]]);
});

test("an unreadable version is not drift", async () => {
  const seen: unknown[] = [];
  const w = watchVersionDrift({
    bootVersion: "1.0.0",
    readVersion: () => null, // package.json momentarily absent mid-upgrade
    intervalMs: 1,
    isBusy: () => false,
    onDrift: () => seen.push("fired"),
  });
  await tick(30);
  w?.stop();
  assert.deepEqual(seen, [], "a missing read is 'unknown', not 'changed'");
});

test("watching is off when there is no boot version or no interval", () => {
  const never = () => assert.fail("must not fire");
  assert.equal(watchVersionDrift({ bootVersion: null, readVersion: () => "9", intervalMs: 1, isBusy: () => false, onDrift: never }), null);
  assert.equal(watchVersionDrift({ bootVersion: "1", readVersion: () => "9", intervalMs: 0, isBusy: () => false, onDrift: never }), null);
  assert.equal(watchVersionDrift({ bootVersion: "1", readVersion: () => "9", intervalMs: Number.NaN, isBusy: () => false, onDrift: never }), null);
});

test("a stale server names itself on errors, and says nothing when current", async () => {
  const { appendStaleNote } = await import("../src/mcp/server.ts");
  const notice = "avcs was updated 1.0.0 -> 1.1.0, but this MCP server is still running 1.0.0.";

  assert.equal(appendStaleNote("not an AVCS repo: /x", null), "not an AVCS repo: /x");

  const withNote = appendStaleNote("not an AVCS repo: /x", notice);
  assert.match(withNote, /^not an AVCS repo: \/x/, "the original error stays first");
  assert.match(withNote, /still running 1\.0\.0/, "and the real cause is named");
});
