// merge3 must be the identity on a single variant. It was not: a PURE DELETION left one
// spurious blank line behind, because `renderSpan` returns joined text and `"".split("\n")`
// is `[""]` — one empty line, not zero. So "delete these lines" materialized as "replace
// these lines with one blank line".
//
// Found by dogfooding: every `git-sync` reprojects the working tree, so each cycle revived
// one line per deleted run. The blank lines accumulated commit after commit (observed: a run
// cleaned to 0 grew back to 10 over a day).
//
// Single-variant identity is the strongest invariant this module has: with nothing to merge
// against, the merged text must be the variant, byte for byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { merge3 } from "../src/merge/merge3.ts";

const merged = (base: string, variant: string): string => merge3(base, [variant]).merged;

test("a single variant merges to itself — pure deletion in the middle", () => {
  assert.equal(merged("a\nX\nY\nZ\nb\n", "a\nb\n"), "a\nb\n");
});

test("a single variant merges to itself — deletion at the start of the file", () => {
  assert.equal(merged("X\nY\na\n", "a\n"), "a\n");
});

test("a single variant merges to itself — deletion at the end of the file", () => {
  assert.equal(merged("a\nX\nY\n", "a\n"), "a\n");
});

// The case that surfaced it: shrinking a run of identical (blank) lines. Identical lines make
// the symptom look like "a blank line survived deletion" rather than "deletion is off by one".
test("a shrinking run of blank lines keeps exactly the blank lines that remain", () => {
  assert.equal(merged("a\n\n\n\n\nb\n", "a\n\nb\n"), "a\n\nb\n");
  assert.equal(merged("a\n\n\n\n\nb\n", "a\nb\n"), "a\nb\n");
});

test("deleting every line leaves an empty file, not a blank line", () => {
  assert.equal(merged("X\nY\n", ""), "");
});

// Guard the neighbouring shapes so the fix cannot trade one off-by-one for another.
test("replacement and insertion stay exact", () => {
  assert.equal(merged("a\nX\nY\nb\n", "a\nZ\nb\n"), "a\nZ\nb\n");
  assert.equal(merged("a\nb\n", "a\nmiddle\nb\n"), "a\nmiddle\nb\n");
  assert.equal(merged("a\nb\n", "a\nb\n"), "a\nb\n");
});

// Two variants that delete the same span agree — agreement must apply the deletion once,
// not emit a blank line for each side.
test("variants that agree on a deletion apply it once", () => {
  const r = merge3("a\nX\nY\nb\n", ["a\nb\n", "a\nb\n"]);
  assert.equal(r.merged, "a\nb\n");
  assert.equal(r.clean, true);
});

// A deletion contending with a replacement must still offer the deletion as an option whose
// text is empty — and picking it must remove the lines rather than blank them.
test("an arbitrated deletion removes the lines", () => {
  const r = merge3("a\nX\nb\n", ["a\nb\n", "a\nZ\nb\n"], {
    arbitrate: (region) => region.options.findIndex((o) => o.text === ""),
  });
  assert.equal(r.merged, "a\nb\n");
  assert.equal(r.conflicts.length, 0);
});
