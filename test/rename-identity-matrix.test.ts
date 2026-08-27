// File identity — rename × edit commutativity matrix (docs/19 §5, C9–C22).
//
// Continues test/lang-neutral-matrix.test.ts (C1–C8). Every case drives the REAL
// Repo/materialize() pipeline, not the alias map in isolation: the claim under test is
// about the tree a replica materializes, and a unit test of a pure function cannot make
// that claim.
//
// The headline: one actor moves a file, another actor edits it with no causal knowledge
// of the move, and the two compose to zero conflicts with the edit landing at the NEW
// path — identically whichever of the two lamport orders the ops happen to take.
//
//   node --experimental-strip-types --test test/rename-identity-matrix.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const A: Actor = { kind: "ai_agent", id: "ai:a" };
const B: Actor = { kind: "ai_agent", id: "ai:b" };

const BASE = "alpha\nbeta\ngamma\ndelta\n";
const EDITED = "alpha\nbeta CHANGED\ngamma\ndelta\n";

interface Ctx {
  dir: string;
  repo: Repo;
  intent: string;
  sess: string;
}

async function freshRepo(tag: string): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), `avcs-rename-${tag}-`));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: `rename ${tag}`, owner: A.id });
  const sess = await repo.startSession({ intentOid: intent, actor: A });
  return { dir, repo, intent, sess };
}

/** Author a `rename_file`. The core has no `proposeRename` helper; the git-bridge capture
 *  path (Stage 0) authors the same body through `proposeOperation`. */
function rename(c: Ctx, a: { actor: Actor; from: string; to: string; deps?: string[] }): Promise<string> {
  return c.repo.proposeOperation({
    sessionOid: c.sess,
    intentOid: c.intent,
    actor: a.actor,
    target: { entityKind: "file", entityId: a.from },
    body: { kind: "rename_file", fromPath: a.from, path: a.to },
    declaredPurpose: `move ${a.from} → ${a.to}`,
    causalDeps: a.deps ?? [],
  });
}

function del(c: Ctx, a: { actor: Actor; path: string; deps?: string[] }): Promise<string> {
  return c.repo.proposeOperation({
    sessionOid: c.sess,
    intentOid: c.intent,
    actor: a.actor,
    target: { entityKind: "file", entityId: a.path },
    body: { kind: "delete_file", path: a.path },
    declaredPurpose: `delete ${a.path}`,
    causalDeps: a.deps ?? [],
  });
}

async function tree(c: Ctx): Promise<{ files: Map<string, string>; res: Awaited<ReturnType<Repo["materialize"]>> }> {
  const res = await c.repo.materialize();
  const files = new Map((await c.repo.materializedFiles(res)).map((f) => [f.path, f.content]));
  return { files, res };
}

// ── R5 — freeze the CURRENT meaning of rename ∥ delete before touching anything ──
// docs/19 §3.2 says this combination keeps its existing meaning, and §6 R5 says the
// existing meaning is undocumented, so pin it first: it is a contest, both sides go to
// needs_decision, and while the contest stands NEITHER path is projected. That last part
// is a data-withholding behaviour this track deliberately does not change — it is frozen
// here so a later change to it has to be a deliberate one.
test("R5: rename ∥ delete of the source keeps its current meaning (contest, nothing projected)", async () => {
  const c = await freshRepo("r5");
  try {
    const scaffold = await c.repo.proposeFileWrite({ sessionOid: c.sess, intentOid: c.intent, actor: A, path: "P.ts", content: BASE, declaredPurpose: "scaffold" });
    const rn = await rename(c, { actor: A, from: "P.ts", to: "Q.ts", deps: [scaffold] });
    const rm2 = await del(c, { actor: B, path: "P.ts", deps: [scaffold] });
    const { files, res } = await tree(c);
    assert.ok(res.conflicts.length >= 1, "rename ∥ delete stays a contest");
    assert.equal(res.statuses.get(rn), "needs_decision");
    assert.equal(res.statuses.get(rm2), "needs_decision");
    assert.equal(files.has("P.ts"), false, "current meaning: nothing is projected while the contest stands");
    assert.equal(files.has("Q.ts"), false);
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

// ── The plain sequential move. Not in the spec's matrix because the spec assumed it
// worked; it does not (see the report accompanying this branch), so it is pinned here as
// the floor every other case stands on. ──
test("a plain create-then-move projects the file at its NEW path (and only there)", async () => {
  const c = await freshRepo("plain");
  try {
    const scaffold = await c.repo.proposeFileWrite({ sessionOid: c.sess, intentOid: c.intent, actor: A, path: "P.ts", content: BASE, declaredPurpose: "scaffold" });
    await rename(c, { actor: A, from: "P.ts", to: "Q.ts", deps: [scaffold] });
    const { files, res } = await tree(c);
    assert.equal(res.conflicts.length, 0);
    assert.equal(files.get("Q.ts"), BASE, "the moved file must still exist");
    assert.equal(files.has("P.ts"), false, "and must not be left behind at the old path");
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

// ── C9 (headline) — rename(P→Q) ∥ edit(P) ──
async function c9Run(order: "rename-first" | "edit-first"): Promise<{ files: Map<string, string>; treeHash: string; conflicts: number; fileConflicts: number }> {
  const c = await freshRepo(`c9-${order}`);
  try {
    const scaffold = await c.repo.proposeFileWrite({ sessionOid: c.sess, intentOid: c.intent, actor: A, path: "P.ts", content: BASE, declaredPurpose: "scaffold" });
    const doRename = () => rename(c, { actor: A, from: "P.ts", to: "Q.ts", deps: [scaffold] });
    const doEdit = () =>
      c.repo.proposeEdit({ sessionOid: c.sess, intentOid: c.intent, actor: B, path: "P.ts", baseText: BASE, newText: EDITED, declaredPurpose: "edit P", causalDeps: [scaffold] });
    // The repo's lamport clock is monotonic, so authoring order IS lamport order — which
    // is exactly the coincidence C10 asserts the result does not depend on.
    if (order === "rename-first") {
      await doRename();
      await doEdit();
    } else {
      await doEdit();
      await doRename();
    }
    const { files, res } = await tree(c);
    return { files, treeHash: res.treeHash, conflicts: res.conflicts.length, fileConflicts: res.fileConflicts.length };
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
}

test("C9: rename(P→Q) ∥ edit(P) — zero conflicts, the edit lands at Q, P is gone", async () => {
  const r = await c9Run("rename-first");
  assert.equal(r.conflicts, 0, "a move and a concurrent edit of the moved file compose");
  assert.equal(r.fileConflicts, 0);
  assert.equal(r.files.get("Q.ts"), EDITED, "the edit must land at the NEW path");
  assert.equal(r.files.has("P.ts"), false, "the old path must not be resurrected");
  assert.equal(r.files.size, 1);
});

// ── C10 — the same op set in the reversed lamport order must materialize identically ──
test("C10: C9 with the lamport order reversed yields the identical treeHash", async () => {
  const a = await c9Run("rename-first");
  const b = await c9Run("edit-first");
  assert.equal(b.conflicts, 0);
  assert.equal(b.files.get("Q.ts"), EDITED);
  assert.equal(a.treeHash, b.treeHash, "rename and edit must COMMUTE — order is a coincidence");
});

// ── C11 — a rename CHAIN (P→Q then Q→R) against an edit of the original P ──
test("C11: chain P→Q→R ∥ edit(P) — only R exists, and it holds the edit", async () => {
  const c = await freshRepo("c11");
  try {
    const scaffold = await c.repo.proposeFileWrite({ sessionOid: c.sess, intentOid: c.intent, actor: A, path: "P.ts", content: BASE, declaredPurpose: "scaffold" });
    const r1 = await rename(c, { actor: A, from: "P.ts", to: "Q.ts", deps: [scaffold] });
    await rename(c, { actor: A, from: "Q.ts", to: "R.ts", deps: [r1] });
    await c.repo.proposeEdit({ sessionOid: c.sess, intentOid: c.intent, actor: B, path: "P.ts", baseText: BASE, newText: EDITED, declaredPurpose: "edit P", causalDeps: [scaffold] });
    const { files, res } = await tree(c);
    assert.equal(res.conflicts.length, 0);
    assert.equal(files.get("R.ts"), EDITED, "the chain closure must carry the edit all the way to R");
    assert.equal(files.has("P.ts"), false);
    assert.equal(files.has("Q.ts"), false);
    assert.equal(files.size, 1);
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

// ── C12 — the causal condition: a NEW file at the vacated path is not misrouted ──
test("C12: put_file(P) AFTER rename(P→Q) creates a new P — both paths exist", async () => {
  const c = await freshRepo("c12");
  try {
    const scaffold = await c.repo.proposeFileWrite({ sessionOid: c.sess, intentOid: c.intent, actor: A, path: "P.ts", content: BASE, declaredPurpose: "scaffold" });
    const rn = await rename(c, { actor: A, from: "P.ts", to: "Q.ts", deps: [scaffold] });
    await c.repo.proposeFileWrite({ sessionOid: c.sess, intentOid: c.intent, actor: A, path: "P.ts", content: "a brand new P\n", declaredPurpose: "recreate P", causalDeps: [rn] });
    const { files, res } = await tree(c);
    assert.equal(res.conflicts.length, 0, "causally ordered ops never contend");
    assert.equal(files.get("Q.ts"), BASE, "the moved file is still at Q");
    assert.equal(files.get("P.ts"), "a brand new P\n", "the new P must NOT be re-routed to Q");
    assert.equal(files.size, 2);
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

// ── C13 — concurrent renames of one source to two destinations ──
test("C13: rename(P→Q) ∥ rename(P→R) — reported as a contest, with zero data loss", async () => {
  const c = await freshRepo("c13");
  try {
    const scaffold = await c.repo.proposeFileWrite({ sessionOid: c.sess, intentOid: c.intent, actor: A, path: "P.ts", content: BASE, declaredPurpose: "scaffold" });
    const r1 = await rename(c, { actor: A, from: "P.ts", to: "Q.ts", deps: [scaffold] });
    const r2 = await rename(c, { actor: B, from: "P.ts", to: "R.ts", deps: [scaffold] });
    const { files, res } = await tree(c);
    assert.ok(res.conflicts.length >= 1, "two destinations for one file is a human's call");
    assert.equal(res.statuses.get(r1), "needs_decision");
    assert.equal(res.statuses.get(r2), "needs_decision");
    // The contested path is NOT moved, so the content is still reachable. Losing the file
    // while asking a human where it should go would be the worst of both worlds.
    assert.equal(files.get("P.ts"), BASE, "the file must survive the contest");
    assert.equal(files.has("Q.ts"), false);
    assert.equal(files.has("R.ts"), false);
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

// ── C14 — two renames racing for one destination path ──
test("C14: rename(A→C) ∥ rename(B→C) — path occupancy is reported, with zero data loss", async () => {
  const c = await freshRepo("c14");
  try {
    const sa = await c.repo.proposeFileWrite({ sessionOid: c.sess, intentOid: c.intent, actor: A, path: "A.ts", content: "from A\n", declaredPurpose: "scaffold A" });
    const sb = await c.repo.proposeFileWrite({ sessionOid: c.sess, intentOid: c.intent, actor: A, path: "B.ts", content: "from B\n", declaredPurpose: "scaffold B" });
    const r1 = await rename(c, { actor: A, from: "A.ts", to: "C.ts", deps: [sa, sb] });
    const r2 = await rename(c, { actor: B, from: "B.ts", to: "C.ts", deps: [sa, sb] });
    const { files, res } = await tree(c);
    assert.ok(res.conflicts.length >= 1, "two files cannot occupy one path");
    assert.equal(res.statuses.get(r1), "needs_decision");
    assert.equal(res.statuses.get(r2), "needs_decision");
    assert.equal(files.get("A.ts"), "from A\n", "neither source may be lost to the contest");
    assert.equal(files.get("B.ts"), "from B\n");
    assert.equal(files.has("C.ts"), false);
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

// ── §3.2 table, remaining rows: what must STAY a conflict ──
test("§3.2: rename(P→Q) ∥ put_file(P) stays a conflict (a concurrent create has no merge base)", async () => {
  const c = await freshRepo("put");
  try {
    const scaffold = await c.repo.proposeFileWrite({ sessionOid: c.sess, intentOid: c.intent, actor: A, path: "P.ts", content: BASE, declaredPurpose: "scaffold" });
    const rn = await rename(c, { actor: A, from: "P.ts", to: "Q.ts", deps: [scaffold] });
    const put = await c.repo.proposeFileWrite({ sessionOid: c.sess, intentOid: c.intent, actor: B, path: "P.ts", content: "unrelated\n", declaredPurpose: "put P", causalDeps: [scaffold] });
    const { res } = await tree(c);
    assert.ok(res.conflicts.length >= 1, "docs/15 §3: two base-less writes cannot be 3-way merged");
    assert.equal(res.statuses.get(rn), "needs_decision");
    assert.equal(res.statuses.get(put), "needs_decision");
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("§3.2: rename(A→C) ∥ edit(C) stays a conflict — C is the DESTINATION, not the source", async () => {
  const c = await freshRepo("dest");
  try {
    const sa = await c.repo.proposeFileWrite({ sessionOid: c.sess, intentOid: c.intent, actor: A, path: "A.ts", content: "from A\n", declaredPurpose: "scaffold A" });
    const sc = await c.repo.proposeFileWrite({ sessionOid: c.sess, intentOid: c.intent, actor: A, path: "C.ts", content: BASE, declaredPurpose: "scaffold C" });
    const rn = await rename(c, { actor: A, from: "A.ts", to: "C.ts", deps: [sa, sc] });
    const ed = await c.repo.proposeEdit({ sessionOid: c.sess, intentOid: c.intent, actor: B, path: "C.ts", baseText: BASE, newText: EDITED, declaredPurpose: "edit C", causalDeps: [sa, sc] });
    const { res } = await tree(c);
    assert.ok(res.conflicts.length >= 1, "an edit of the file being overwritten is a real contest");
    assert.equal(res.statuses.get(rn), "needs_decision");
    assert.equal(res.statuses.get(ed), "needs_decision");
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

// ── §3.2 — line-level conflict detection has to see across the alias boundary ──
// Two concurrent edits can reach the SAME file by two different names: one names the old
// path and is routed by the alias, the other names the new path directly. Bucketing the
// line-overlap check by the DECLARED path would put them in separate buckets and never
// compare them — and the loser's overlapping change would be dropped in silence, which is
// the one failure mode the whole file-conflict pass exists to prevent.
test("§3.2: concurrent edits reaching one file by two names — overlap is reported", async () => {
  const c = await freshRepo("alias-overlap");
  try {
    const scaffold = await c.repo.proposeFileWrite({ sessionOid: c.sess, intentOid: c.intent, actor: A, path: "P.ts", content: BASE, declaredPurpose: "scaffold" });
    const rn = await rename(c, { actor: A, from: "P.ts", to: "Q.ts", deps: [scaffold] });
    // Names the NEW path, causally after the move.
    await c.repo.proposeEdit({ sessionOid: c.sess, intentOid: c.intent, actor: A, path: "Q.ts", baseText: BASE, newText: "alpha\nbeta ONE\ngamma\ndelta\n", declaredPurpose: "edit Q", causalDeps: [rn] });
    // Names the OLD path, concurrent with the move, and touches the same line.
    await c.repo.proposeEdit({ sessionOid: c.sess, intentOid: c.intent, actor: B, path: "P.ts", baseText: BASE, newText: "alpha\nbeta TWO\ngamma\ndelta\n", declaredPurpose: "edit P", causalDeps: [scaffold] });
    const { res } = await tree(c);
    assert.equal(res.fileConflicts.length, 1, "the overlap must be found even across the rename");
    assert.equal(res.fileConflicts[0]!.file, "Q.ts", "reported at the path the file actually lives at");
    assert.ok(res.fileConflicts[0]!.regions[0]!.options.length >= 2, "both renderings offered");
    assert.ok(res.conflicts.length >= 1, "and surfaced for the release gate");
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});

test("§3.2: concurrent DISJOINT edits reaching one file by two names both survive", async () => {
  const c = await freshRepo("alias-disjoint");
  try {
    const scaffold = await c.repo.proposeFileWrite({ sessionOid: c.sess, intentOid: c.intent, actor: A, path: "P.ts", content: BASE, declaredPurpose: "scaffold" });
    const rn = await rename(c, { actor: A, from: "P.ts", to: "Q.ts", deps: [scaffold] });
    await c.repo.proposeEdit({ sessionOid: c.sess, intentOid: c.intent, actor: A, path: "Q.ts", baseText: BASE, newText: "alpha\nbeta ONE\ngamma\ndelta\n", declaredPurpose: "edit Q", causalDeps: [rn] });
    await c.repo.proposeEdit({ sessionOid: c.sess, intentOid: c.intent, actor: B, path: "P.ts", baseText: BASE, newText: "alpha\nbeta\ngamma\ndelta TWO\n", declaredPurpose: "edit P", causalDeps: [scaffold] });
    const { files, res } = await tree(c);
    assert.equal(res.conflicts.length, 0);
    assert.equal(res.fileConflicts.length, 0);
    assert.equal(files.get("Q.ts"), "alpha\nbeta ONE\ngamma\ndelta TWO\n", "both disjoint edits compose at the final path");
    assert.equal(files.size, 1);
  } finally {
    await rm(c.dir, { recursive: true, force: true });
  }
});
