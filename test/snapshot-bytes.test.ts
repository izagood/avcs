// Bytes through a persisted reduce snapshot (issue #101).
//
// `encodeCbor` has no byte-string (CBOR major type 2) encoder, so a Buffer is written as a
// generic index→byte map and read back as a plain object. `serializeSnapshot` persists
// `synthBlobs: Map<string, Buffer>` — the bytes of every 3-way-merge result — and
// `deserializeSnapshot` did:
//
//     synthBlobs: entriesToMap(r.synthBlobs as Entries<Buffer>)
//
// `as` is an assertion, not a conversion. So after a snapshot reload every auto-merged path
// in `materializedBytes()` held a plain object where a Buffer is declared, which
//   - crashes `commitWorkingTree` (`.equals` is Buffer-only), taking the git-bridge hook
//     with it, and
//   - makes `materialize --out` write `"[object Object]"` as the file's content, silently,
//     exit 0 — the tree hash is computed from oids, so nothing reveals it.
//
// The suite passed 604/604 because tests reduce in-process and never reload a persisted
// snapshot carrying synthBlobs. These tests reload one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { encodeCbor, decodeCbor } from "../src/core/cbor.ts";
import { serializeSnapshot, deserializeSnapshot } from "../src/reducer/reducer.ts";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

/** A snapshot shaped like the real one, carrying one synthesized blob. */
function snapWith(oid: string, bytes: Buffer) {
  return {
    input: {
      ops: [], decisions: [], evidence: [], intents: new Map(),
      policy: {} as never, reliability: new Map(), authority: new Map(),
    },
    result: {
      tree: new Map<string, string>([["merged.ts", oid]]),
      treeHash: "t", statuses: new Map(), conflicts: [], autoDecisions: [],
      fileConflicts: [], headOps: [], blockedReasons: new Map(), untrustedEvidence: 0,
      synthBlobs: new Map<string, Buffer>([[oid, bytes]]),
    },
    perKey: new Map(), groupOrder: [], groupMembers: new Map(),
    stats: { groupsTotal: 0, groupsRecomputed: 0, groupsReused: 0, dirtyKeys: 0 },
  } as unknown as Parameters<typeof serializeSnapshot>[0];
}

/**
 * A repo whose `main` view contains a SYNTHESIZED blob — the thing the bug corrupts.
 *
 * One `put_file` is not enough: with no merge there is nothing to synthesize and
 * `synthBlobs` stays empty, so a test built on it passes while proving nothing. Two
 * concurrent `edit_file`s off the same base, touching different regions, auto-merge — and
 * the merge result exists only as bytes the reducer carries.
 */
async function repoWithSynthBlob(dir: string): Promise<Repo> {
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "w", owner: "human:h" });
  const s1 = await repo.startSession({ intentOid: intent, actor: ai });
  const s2 = await repo.startSession({ intentOid: intent, actor: { kind: "ai_agent", id: "ai:b" } });

  const base = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
  const seed = await repo.proposeFileWrite({
    sessionOid: s1, intentOid: intent, actor: ai,
    path: "merged.ts", content: base, declaredPurpose: "seed",
  });

  // Both edits depend on the seed, so it is ordered FIRST and the two edits are concurrent
  // only with each other — a 3-way merge off a common base. Without the dep all three ops
  // are mutually concurrent on one key and the reducer (correctly) reports a conflict
  // instead, so no blob gets synthesized and the test would prove nothing.
  // Far-apart regions, so the merge takes both sides cleanly.
  await repo.proposeEdit({
    sessionOid: s1, intentOid: intent, actor: ai, path: "merged.ts",
    baseText: base, newText: base.replace("one", "ONE"), declaredPurpose: "top",
    causalDeps: [seed],
  });
  await repo.proposeEdit({
    sessionOid: s2, intentOid: intent, actor: { kind: "ai_agent", id: "ai:b" }, path: "merged.ts",
    baseText: base, newText: base.replace("eight", "EIGHT"), declaredPurpose: "bottom",
    causalDeps: [seed],
  });

  const res = await repo.materialize("main");
  assert.ok(res.synthBlobs.size > 0, "the fixture must actually produce a synthesized blob");
  await repo.compact("main"); // persists a snapshot even below the auto-compaction threshold
  return repo;
}

test("a synthesized blob survives a snapshot round-trip as a Buffer", () => {
  const content = Buffer.from("export const merged = 1\n");
  const oid = "blob_deadbeef";

  // The full path the file takes: serialize → encodeCbor → bytes on disk → decode.
  const wire = decodeCbor(encodeCbor(serializeSnapshot(snapWith(oid, content))));
  const back = deserializeSnapshot(wire);
  const got = back.result.synthBlobs.get(oid);

  assert.ok(got !== undefined, "the synthesized blob is still in the snapshot");
  assert.ok(Buffer.isBuffer(got), `expected a Buffer, got ${got?.constructor?.name}`);
  // `.equals` is Buffer-only, and `commitWorkingTree` calls it on exactly this value.
  assert.equal(typeof got.equals, "function", "commitWorkingTree needs .equals");
  assert.ok(got.equals(content), "and the bytes are unchanged");
  // The other consumer reads it as text; a plain object yields "[object Object]".
  assert.equal(got.toString("utf8"), "export const merged = 1\n");
});

test("binary content is not mangled either — every byte value survives", () => {
  // 0x00 and 0xFF are where a naive text round-trip breaks first.
  const content = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x0a, 0x00]);
  const oid = "blob_binary";

  const back = deserializeSnapshot(decodeCbor(encodeCbor(serializeSnapshot(snapWith(oid, content)))));
  const got = back.result.synthBlobs.get(oid)!;

  assert.ok(Buffer.isBuffer(got));
  assert.deepEqual([...got], [...content], "byte-for-byte");
});

test("an empty synthesized blob round-trips as an empty Buffer, not undefined", () => {
  const oid = "blob_empty";
  const back = deserializeSnapshot(decodeCbor(encodeCbor(serializeSnapshot(snapWith(oid, Buffer.alloc(0))))));
  const got = back.result.synthBlobs.get(oid);

  assert.ok(Buffer.isBuffer(got), `expected a Buffer, got ${got?.constructor?.name}`);
  assert.equal(got.length, 0);
});

// The format version was written (`v: 1`) but never read, so a snapshot produced by the
// buggy serializer was loaded rather than discarded — which is why recovering needed
// someone to find and delete a cache file by hand.
test("a snapshot from an older serialization is refused, not read", () => {
  const wire = decodeCbor(encodeCbor(serializeSnapshot(snapWith("blob_x", Buffer.from("x"))))) as Record<string, unknown>;
  assert.ok(typeof wire.v === "number", "the snapshot carries a format version");

  assert.throws(
    () => deserializeSnapshot({ ...wire, v: (wire.v as number) - 1 }),
    /snapshot/i,
    "an older format must be rejected so the caller falls back to a full reduce",
  );
});

// The guard that stops this class of bug coming back. Three call sites encode CBOR
// (objectStore ×2 for objects, repo ×1 for the snapshot) and no object type has a Buffer
// field, so nothing legitimately passes raw bytes.
test("encodeCbor refuses raw bytes instead of silently encoding them as a map", () => {
  for (const bytes of [Buffer.from("abc"), new Uint8Array([1, 2, 3])]) {
    assert.throws(
      () => encodeCbor({ x: bytes }),
      /base64|byte/i,
      `${bytes.constructor.name} must be refused, with the remedy in the message`,
    );
  }
  // Nested, too — the snapshot's bytes sat inside arrays inside objects.
  assert.throws(() => encodeCbor({ a: [["oid", Buffer.from("y")]] }), /base64|byte/i);
  // And the ordinary shapes still encode.
  assert.deepEqual(decodeCbor(encodeCbor({ s: "abc", n: 1, b: true, arr: [1, "2"] })), {
    s: "abc", n: 1, b: true, arr: [1, "2"],
  });
});

// End to end, through the real store: the symptom that blocked commits.
test("after a cold snapshot reload, materialized bytes are Buffers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-101-"));
  try {
    await repoWithSynthBlob(dir);

    // A cold instance loads the persisted snapshot rather than reducing from scratch.
    const cold = await Repo.open(dir);
    const res = await cold.materialize("main");
    assert.ok(res.synthBlobs.size > 0, "the reload still carries the synthesized blob");
    for (const { path, bytes } of await cold.materializedBytes(res)) {
      assert.ok(Buffer.isBuffer(bytes), `${path}: expected a Buffer, got ${bytes?.constructor?.name}`);
      // `commitWorkingTree` calls this on every path; a plain object has no `.equals`.
      assert.equal(typeof bytes.equals, "function", `${path}: needs .equals`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The quiet symptom, pinned directly: a projection written to disk must be the content, not
// a stringified object.
test("materialize --out never writes \"[object Object]\"", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-101-out-"));
  const out = await mkdtemp(join(tmpdir(), "avcs-101-tree-"));
  try {
    await repoWithSynthBlob(dir);

    const cold = await Repo.open(dir);
    const res = await cold.materialize("main");
    await cold.writeWorkspace(res, out);

    const text = await readFile(join(out, "merged.ts"), "utf8");
    assert.doesNotMatch(text, /\[object Object\]/, "the merge result, not a stringified object");
    // Both sides of the auto-merge are present, so this is the real merged content.
    assert.match(text, /ONE/);
    assert.match(text, /EIGHT/);
  } finally {
    for (const d of [dir, out]) await rm(d, { recursive: true, force: true });
  }
});

// A poisoned snapshot on disk must not be able to break a repo: the load path is
// best-effort and a full reduce is always correct.
test("a snapshot from an older serialization is discarded, and the repo still works", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-101-poison-"));
  try {
    await repoWithSynthBlob(dir);

    // Exactly what a pre-fix avcs left behind: same header, older serialization.
    const p = join(dir, ".avcs", "snapshot", "main.cbor");
    const raw = decodeCbor(await readFile(p)) as { header: unknown; snapshot: Record<string, unknown> };
    await writeFile(p, encodeCbor({ header: raw.header, snapshot: { ...raw.snapshot, v: 0 } }));

    const cold = await Repo.open(dir);
    const res = await cold.materialize("main");
    assert.equal(res.tree.size, 1, "a full reduce produced the view anyway");
    for (const { bytes } of await cold.materializedBytes(res)) assert.ok(Buffer.isBuffer(bytes));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
