// Region arbitration (docs/22) — policy, not order, picks the winner of a contended
// region. The verification matrix R1–R14 of docs/22 §5 lives here.
//
//   node --experimental-strip-types --test test/region-arbitration.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { merge3, type ConflictRegion } from "../src/merge/merge3.ts";

const BASE = "keep\nCONTESTED\ntail\n";
const A = "keep\nA WINS\ntail\n";
const B = "keep\nB WINS\ntail\n";

// ── R8: no arbiter injected ⇒ merge3 behaves exactly as before ────────────────
test("R8: without `arbitrate`, merge3 is byte-identical to the pre-arbitration behaviour", () => {
  const base = merge3(BASE, [A, B]);
  assert.equal(base.clean, false);
  assert.equal(base.merged, BASE, "onConflict defaults to emitting base");
  assert.equal(base.conflicts.length, 1);

  const first = merge3(BASE, [A, B], { onConflict: "first" });
  assert.equal(first.clean, false);
  assert.equal(first.merged, A, "onConflict:first keeps the lowest-side option");
  assert.equal(first.conflicts.length, 1);
});

// ── §3.1: an arbiter's pick becomes the merged text and the region stops being a conflict
test("an arbiter that picks an option resolves the region: its text is emitted, no conflict", () => {
  const seen: ConflictRegion[] = [];
  const m = merge3(BASE, [A, B], {
    onConflict: "first",
    arbitrate: (r) => {
      seen.push(r);
      // pick the option whose only side is 1 (the "later" variant) — the point is that
      // merge3 obeys the caller, not the side order.
      return r.options.findIndex((o) => o.sides.includes(1));
    },
  });
  assert.equal(m.merged, B, "the arbiter's option, not the lowest side, is in the tree");
  assert.deepEqual(m.conflicts, [], "a decided region is not a conflict (docs/22 §3.4)");
  assert.equal(m.clean, true, "…so the merge is clean");
  assert.equal(seen.length, 1, "arbitrate is called once per contended region");
  assert.equal(seen[0]!.baseStart, 1);
  assert.equal(seen[0]!.baseEnd, 2);
  assert.equal(seen[0]!.options.length, 2, "both renderings are offered");
});

test("`null` from the arbiter falls back to onConflict and leaves the region a conflict", () => {
  const m = merge3(BASE, [A, B], { onConflict: "first", arbitrate: () => null });
  assert.equal(m.merged, A, "deterministic fallback content — no data loss");
  assert.equal(m.conflicts.length, 1, "undecided ⇒ still a conflict for a human");
  assert.equal(m.clean, false);

  const b = merge3(BASE, [A, B], { arbitrate: () => null });
  assert.equal(b.merged, BASE, "onConflict:base fallback is unchanged too");
  assert.equal(b.conflicts.length, 1);
});

test("an out-of-range or non-integer pick is treated as undecided, never trusted blindly", () => {
  for (const bad of [2, -1, 1.5, Number.NaN]) {
    const m = merge3(BASE, [A, B], { onConflict: "first", arbitrate: () => bad });
    assert.equal(m.merged, A, `pick ${bad} must fall back`);
    assert.equal(m.conflicts.length, 1, `pick ${bad} must stay a conflict`);
  }
});

// ── R1 (merge3 half): arbitration is only reachable through a ConflictRegion ──
test("R1: with no overlap the arbiter is never called and the merge is unchanged", () => {
  const disjointA = "A\nb\nc\nd\ne\nf\n";
  const disjointB = "a\nb\nc\nd\ne\nF\n";
  const base = "a\nb\nc\nd\ne\nf\n";
  let calls = 0;
  const m = merge3(base, [disjointA, disjointB], {
    onConflict: "first",
    arbitrate: () => {
      calls++;
      return 0;
    },
  });
  assert.equal(calls, 0, "no ConflictRegion ⇒ no arbitration (docs/22 §4.1, R-c)");
  assert.equal(m.merged, "A\nb\nc\nd\ne\nF\n");
  assert.equal(m.clean, true);
});

// ── R14: N=3 — a unique top is adopted; a shared top is not ──────────────────
test("R14: a 3-way region is decided when the arbiter names one option, held when it can't", () => {
  const C = "keep\nC WINS\ntail\n";
  const pick = merge3(BASE, [A, B, C], {
    onConflict: "first",
    arbitrate: (r) => r.options.findIndex((o) => o.sides.includes(2)),
  });
  assert.equal(pick.merged, C);
  assert.deepEqual(pick.conflicts, []);

  const hold = merge3(BASE, [A, B, C], { onConflict: "first", arbitrate: () => null });
  assert.equal(hold.merged, A);
  assert.equal(hold.conflicts.length, 1);
  assert.equal(hold.conflicts[0]!.options.length, 3, "all three renderings stay on the table");
});

// ── R7: agreement collapses into ONE option carrying both sides ──────────────
test("R7: two variants with identical text arrive as a single option listing both sides", () => {
  const regions: ConflictRegion[] = [];
  merge3(BASE, [A, B, B], {
    onConflict: "first",
    arbitrate: (r) => {
      regions.push(r);
      return null;
    },
  });
  assert.equal(regions.length, 1);
  const agreed = regions[0]!.options.find((o) => o.text.includes("B WINS"))!;
  assert.deepEqual(agreed.sides, [1, 2], "the agreeing variants share one option");
});
