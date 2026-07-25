// Phase 16 M1.2 (docs/18 §1.2) — unifiedDiff, the patch format behind `avcs.diff
// format:patch`. Built on merge3's LCS hunk core rather than a second diff algorithm, so a
// patch an agent reads describes the same line changes the reducer would merge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unifiedDiff } from "../src/query/diff.ts";

test("identical texts produce no patch at all", () => {
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n"), "");
});

test("a replaced line shows as a removal plus an addition", () => {
  const patch = unifiedDiff("one\ntwo\nthree\n", "one\nTWO\nthree\n");
  assert.match(patch, /^@@ /m);
  assert.match(patch, /^-two$/m);
  assert.match(patch, /^\+TWO$/m);
  assert.match(patch, /^ one$/m, "unchanged lines are context, prefixed with a space");
});

test("a pure insertion has no removal lines", () => {
  const patch = unifiedDiff("a\nb\n", "a\nmiddle\nb\n");
  assert.match(patch, /^\+middle$/m);
  assert.ok(!/^-/m.test(patch), `no removals expected, got:\n${patch}`);
});

test("a pure deletion has no addition lines", () => {
  const patch = unifiedDiff("a\ngone\nb\n", "a\nb\n");
  assert.match(patch, /^-gone$/m);
  assert.ok(!/^\+/m.test(patch), `no additions expected, got:\n${patch}`);
});

test("creating content from empty adds every line", () => {
  const patch = unifiedDiff("", "x\ny\n");
  assert.match(patch, /^\+x$/m);
  assert.match(patch, /^\+y$/m);
});

test("far-apart changes get separate hunk headers, adjacent ones share a hunk", () => {
  const a = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n") + "\n";
  const far = a.replace("l1\n", "CHANGED1\n").replace("l38", "CHANGED38");
  assert.equal((unifiedDiff(far, a).match(/@@ /g) ?? []).length, 2, "two distant edits → two hunks");

  const near = a.replace("l10", "X10").replace("l11", "X11");
  assert.equal((unifiedDiff(near, a).match(/@@ /g) ?? []).length, 1, "touching edits → one hunk");
});

test("a file with no trailing newline round-trips without inventing a blank line", () => {
  const patch = unifiedDiff("a\nb", "a\nc");
  assert.match(patch, /^-b$/m);
  assert.match(patch, /^\+c$/m);
});
