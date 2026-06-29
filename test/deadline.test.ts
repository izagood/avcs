// #33 — git-bridge hooks must never block git indefinitely. `withDeadline` bounds a
// hook phase so it either completes or reports a timeout (caller then fails open).
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDeadline, hookTimeoutMs, DEFAULT_HOOK_TIMEOUT_MS } from "../src/concurrency/deadline.ts";

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

test("resolves with the value when fn completes before the deadline", async () => {
  const r = await withDeadline(async () => 42, 1000);
  assert.deepEqual(r, { ok: true, value: 42 });
});

test("reports a timeout when fn exceeds the deadline (does not hang)", async () => {
  const start = Date.now();
  // A promise that never settles — the worst case of a hung hook. Without a deadline
  // this would block forever; with one, withDeadline must return promptly.
  const r = await withDeadline<string>(() => new Promise<string>(() => {}), 30);
  assert.deepEqual(r, { ok: false, timedOut: true });
  assert.ok(Date.now() - start < 5_000, "withDeadline returned promptly on timeout");
});

test("a non-positive deadline disables the bound and always awaits fn", async () => {
  const r = await withDeadline(async () => {
    await sleep(20);
    return "done";
  }, 0);
  assert.deepEqual(r, { ok: true, value: "done" });
});

test("propagates fn errors rather than masking them as a timeout", async () => {
  await assert.rejects(
    () => withDeadline(async () => { throw new Error("boom"); }, 1000),
    /boom/,
  );
});

test("hookTimeoutMs defaults when the env var is unset or empty", () => {
  assert.equal(hookTimeoutMs({}), DEFAULT_HOOK_TIMEOUT_MS);
  assert.equal(hookTimeoutMs({ AVCS_HOOK_TIMEOUT_MS: "" }), DEFAULT_HOOK_TIMEOUT_MS);
});

test("hookTimeoutMs honors a valid override", () => {
  assert.equal(hookTimeoutMs({ AVCS_HOOK_TIMEOUT_MS: "5000" }), 5000);
});

test("hookTimeoutMs treats 0 as an explicit disable (no bound)", () => {
  assert.equal(hookTimeoutMs({ AVCS_HOOK_TIMEOUT_MS: "0" }), 0);
});

test("hookTimeoutMs falls back to the default on garbage or negative values", () => {
  assert.equal(hookTimeoutMs({ AVCS_HOOK_TIMEOUT_MS: "abc" }), DEFAULT_HOOK_TIMEOUT_MS);
  assert.equal(hookTimeoutMs({ AVCS_HOOK_TIMEOUT_MS: "-1" }), DEFAULT_HOOK_TIMEOUT_MS);
});
