// T0-1 — the git-bridge capture path must author `edit_file`, not `put_file`, for a
// MODIFIED file. `commitWorkingTree` already holds the exact 3-way merge base (the
// previously projected content), so attaching it turns two sessions editing disjoint
// regions of one file from an unmergeable L2 (docs/15 §3: "동시 put_file 두 개는 base
// 공유가 없으니 3-way 머지가 불가능") into an auto-merged L1.
//
//   node --experimental-strip-types --test test/capture-edit-file.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { Repo } from "../src/api/repo.ts";
import type { Actor, Operation } from "../src/objects/types.ts";

const dev: Actor = { kind: "human", id: "human:dev" };
const alice: Actor = { kind: "ai_agent", id: "ai:alice" };
const bob: Actor = { kind: "ai_agent", id: "ai:bob" };

const mkrepo = () => mkdtemp(join(tmpdir(), "avcs-capture-"));

async function bodyOf(repo: Repo, oid: string): Promise<Operation["body"]> {
  return (await repo.store.get<Operation>(oid)).body;
}

async function contentOf(repo: Repo, path: string, view = "main"): Promise<string | undefined> {
  const res = await repo.materialize(view);
  return (await repo.materializedFiles(res)).find((f) => f.path === path)?.content;
}

/** Clone a store the way `git pull`-into-a-fresh-checkout does (git-bridge idiom): copy
 *  the whole `.avcs` so the clone's frontier is byte-identical to the origin's. */
async function cloneStore(from: string, to: string): Promise<Repo> {
  await rm(join(to, ".avcs"), { recursive: true, force: true });
  await cp(join(from, ".avcs"), join(to, ".avcs"), { recursive: true });
  return Repo.open(to);
}

/** Gossip `from`'s objects into `to` and rebuild the (git-ignored) op-log/index. */
async function gossip(from: string, to: Repo): Promise<void> {
  await cp(join(from, ".avcs", "objects"), join(to.dir, ".avcs", "objects"), { recursive: true });
  await to.reindex();
}

test("capture: a MODIFIED text file becomes edit_file carrying the previous projection as base", async () => {
  const dir = await mkrepo();
  try {
    const repo = await Repo.init(dir);
    await writeFile(join(dir, "app.ts"), "a\nb\nc\n", "utf8");
    const first = await repo.commitWorkingTree(dir, { message: "scaffold", actor: dev });
    assert.deepEqual(first.added, ["app.ts"]);

    await writeFile(join(dir, "app.ts"), "a\nB!\nc\n", "utf8");
    const second = await repo.commitWorkingTree(dir, { message: "tweak", actor: dev });
    assert.deepEqual(second.modified, ["app.ts"]);
    assert.equal(second.ops.length, 1);

    const body = await bodyOf(repo, second.ops[0]!);
    assert.equal(body.kind, "edit_file", "a modified file must be captured as a 3-way-mergeable edit");
    assert.ok(body.baseBlobOid, "the merge base must be attached");
    assert.equal(
      (await repo.readBlob(body.baseBlobOid!)).toString("utf8"),
      "a\nb\nc\n",
      "the base blob is exactly the previously projected content",
    );
    assert.equal(await contentOf(repo, "app.ts"), "a\nB!\nc\n", "the edit still projects verbatim");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture: a newly ADDED file stays put_file (there is no base)", async () => {
  const dir = await mkrepo();
  try {
    const repo = await Repo.init(dir);
    await writeFile(join(dir, "new.ts"), "fresh\n", "utf8");
    const r = await repo.commitWorkingTree(dir, { message: "add", actor: dev });
    const body = await bodyOf(repo, r.ops[0]!);
    assert.equal(body.kind, "put_file");
    assert.equal(body.baseBlobOid, undefined, "a create has no merge base to attach");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── HEADLINE: two parallel sessions edit DISJOINT regions of one file → zero conflicts ──
test("capture: two concurrent captures of disjoint regions of one file auto-merge (L1)", async () => {
  const a = await mkrepo();
  const b = await mkrepo();
  try {
    const base = "line1\nline2\nline3\nline4\nline5\nline6\nline7\n";
    const repoA = await Repo.init(a);
    await writeFile(join(a, "shared.ts"), base, "utf8");
    await repoA.commitWorkingTree(a, { message: "scaffold", actor: dev });

    // Session B forks off the SAME frontier — so the two captures below are causally
    // concurrent (neither op is in the other's causal closure).
    const repoB = await cloneStore(a, b);
    await repoB.checkoutInto(b);
    assert.equal(await readFile(join(b, "shared.ts"), "utf8"), base);

    // A edits the top region; B edits the bottom region. Both derive from `base`.
    await writeFile(join(a, "shared.ts"), base.replace("line2", "line2 FROM A"), "utf8");
    const capA = await repoA.commitWorkingTree(a, { message: "A edits the top", actor: alice });
    await writeFile(join(b, "shared.ts"), base.replace("line6", "line6 FROM B"), "utf8");
    const capB = await repoB.commitWorkingTree(b, { message: "B edits the bottom", actor: bob });

    assert.equal((await bodyOf(repoA, capA.ops[0]!)).kind, "edit_file");
    assert.equal((await bodyOf(repoB, capB.ops[0]!)).kind, "edit_file");

    // Converge into one view (object gossip, the way a pull does).
    await gossip(b, repoA);
    const res = await repoA.materialize();
    assert.equal(res.conflicts.length, 0, "disjoint concurrent captures must not conflict");
    assert.equal(res.fileConflicts.length, 0, "…not even as a file conflict");
    assert.equal(
      await contentOf(repoA, "shared.ts"),
      base.replace("line2", "line2 FROM A").replace("line6", "line6 FROM B"),
      "both edits must survive the merge",
    );
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("capture: a non-UTF8 binary file stays put_file and round-trips byte-for-byte", async () => {
  const dir = await mkrepo();
  try {
    const repo = await Repo.init(dir);
    const v1 = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    const v2 = Buffer.from([0xff, 0xfe, 0x00, 0x02, 0x03]);
    await writeFile(join(dir, "blob.bin"), v1);
    await repo.commitWorkingTree(dir, { message: "add binary", actor: dev });

    await writeFile(join(dir, "blob.bin"), v2);
    const r = await repo.commitWorkingTree(dir, { message: "change binary", actor: dev });
    assert.deepEqual(r.modified, ["blob.bin"]);
    const body = await bodyOf(repo, r.ops[0]!);
    assert.equal(body.kind, "put_file", "binary/non-UTF8 content must never go through the text path");

    // Byte-exact round trip through materialize + checkout.
    const res = await repo.materialize();
    const bytes = (await repo.materializedBytes(res)).find((f) => f.path === "blob.bin")!.bytes;
    assert.ok(bytes.equals(v2), "materialized bytes are unchanged");
    await repo.checkoutInto(dir);
    assert.ok((await readFile(join(dir, "blob.bin"))).equals(v2), "checked-out bytes are unchanged");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── C5 (docs/15 §9): base drift must degrade to a CONFLICT, never silent corruption ──
test("capture: concurrent captures of the SAME region drift the base → conflict, no corruption", async () => {
  const a = await mkrepo();
  const b = await mkrepo();
  try {
    const base = "keep\nCONTESTED\nkeep\n";
    const repoA = await Repo.init(a);
    await writeFile(join(a, "hot.ts"), base, "utf8");
    await repoA.commitWorkingTree(a, { message: "scaffold", actor: dev });

    const repoB = await cloneStore(a, b);
    await repoB.checkoutInto(b);

    await writeFile(join(a, "hot.ts"), "keep\nA WINS?\nkeep\n", "utf8");
    await repoA.commitWorkingTree(a, { message: "A", actor: alice });
    await writeFile(join(b, "hot.ts"), "keep\nB WINS?\nkeep\n", "utf8");
    await repoB.commitWorkingTree(b, { message: "B", actor: bob });

    await gossip(b, repoA);
    const res = await repoA.materialize();
    assert.equal(res.fileConflicts.length, 1, "an overlapping (drifted) base must surface a conflict");
    assert.equal(res.fileConflicts[0]!.file, "hot.ts");
    assert.ok(res.fileConflicts[0]!.regions[0]!.options.length >= 2, "both sides are offered as options");
    assert.ok(res.conflicts.length >= 1, "and it reaches the release/commit gate");

    // No silent corruption: the projected content is one side verbatim, never a blend.
    const got = await contentOf(repoA, "hot.ts");
    assert.ok(
      got === "keep\nA WINS?\nkeep\n" || got === "keep\nB WINS?\nkeep\n",
      `the tree holds one deterministic incumbent, not a garbled merge (got ${JSON.stringify(got)})`,
    );
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});
