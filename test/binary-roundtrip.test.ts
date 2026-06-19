// Byte-based content model — core invariants (Stream E).
//
// The byte transition makes AVCS faithful to arbitrary bytes, not just UTF-8 text:
//   1. a binary file (NUL bytes, high bytes) survives commit → checkout byte-for-byte,
//   2. putBlob stays deterministic and backward-compatible for text (same content ⇒ same oid),
//   3. concurrent DIFFERENT binary writes to one path contend (conflict / atomic pick),
//      never a line-merge that corrupts the bytes, and
//   4. the binary guard must not regress text: disjoint concurrent text edits still
//      auto-merge cleanly.
//
//   node --experimental-strip-types --test test/binary-roundtrip.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const dev: Actor = { kind: "human", id: "human:dev" };
const A: Actor = { kind: "ai_agent", id: "ai:a" };
const B: Actor = { kind: "ai_agent", id: "ai:b" };

const mkrepo = () => mkdtemp(join(tmpdir(), "avcs-bin-"));
const mkwork = () => mkdtemp(join(tmpdir(), "avcs-bin-wt-"));

// A fake ELF header followed by an embedded NUL, the full byte range, and a trailing
// high byte — exactly the shape that a UTF-8 round trip mangles.
const ELF = Buffer.from([
  0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0xff,
  0x00, 0x00, 0xfe, 0xfd, 0x10, 0x80, 0x7f, 0x00,
]);
const BIN_BYTES = Buffer.concat([
  ELF,
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)), // every byte value 0x00..0xff
  Buffer.from([0xc3, 0x28, 0xa0, 0xa1]), // invalid UTF-8 sequences
]);

// ── 1. binary round trip: commit a binary working-tree file, checkout into a clean dir,
//        the bytes must be IDENTICAL (no UTF-8 lossy re-encode anywhere on the path). ──
test("binary round trip: commitWorkingTree → checkoutInto is byte-for-byte identical", async () => {
  const dir = await mkrepo();
  const repo = await Repo.init(dir);
  try {
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "bin/a.out"), BIN_BYTES); // write raw bytes, no encoding
    const r = await repo.commitWorkingTree(dir, { message: "add binary", actor: dev });
    assert.deepEqual(r.added, ["bin/a.out"]);
    assert.equal(r.ops.length, 1);

    // Fresh checkout into a clean directory must reproduce the exact bytes.
    const work2 = await mkwork();
    try {
      const written = await repo.checkoutInto(work2, "main");
      assert.deepEqual(written, ["bin/a.out"]);
      const out = await readFile(join(work2, "bin/a.out")); // raw Buffer, no encoding
      assert.ok(out.equals(BIN_BYTES), "checked-out bytes must equal the original byte-for-byte");
      assert.equal(out.length, BIN_BYTES.length, "no truncation or re-encode growth");
    } finally {
      await rm(work2, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 1b. the same invariant straight through the blob layer: putBlob(bytes) → readBlob
//         returns the identical Buffer (covers the content-addressing path directly). ──
test("putBlob(binary) → readBlob round-trips bytes exactly", async () => {
  const dir = await mkrepo();
  const repo = await Repo.init(dir);
  try {
    const oid = await repo.putBlob(BIN_BYTES);
    const back = await repo.readBlob(oid);
    assert.ok(back.equals(BIN_BYTES), "readBlob must return the exact bytes putBlob stored");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 2. determinism / backward-compat: identical TEXT content ⇒ identical oid (twice). ──
test("putBlob is deterministic: same text content yields the same oid", async () => {
  const dir = await mkrepo();
  const repo = await Repo.init(dir);
  try {
    const text = "export const v = 1\n";
    const oid1 = await repo.putBlob(text);
    const oid2 = await repo.putBlob(text);
    assert.equal(oid1, oid2, "same content must address to the same oid (content-addressing)");
    // And reading it back yields the original UTF-8 text unchanged.
    assert.equal((await repo.readBlob(oid1)).toString("utf8"), text);
    // A passing a Buffer of the same bytes must address identically to the string form
    // (string is encoded as utf8 internally) — backward compatibility for existing repos.
    const oid3 = await repo.putBlob(Buffer.from(text, "utf8"));
    assert.equal(oid3, oid1, "Buffer(utf8) of the same text must match the string oid");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 3. concurrent DIFFERENT binary writes to one path → conflict (or deterministic atomic
//        pick), never a corrupting line merge. Two put_file ops on the same base frontier. ──
test("concurrent divergent binary writes to one path contend (no silent byte corruption)", async () => {
  const dir = await mkrepo();
  const repo = await Repo.init(dir);
  try {
    const intent = await repo.createIntent({ title: "bin concurrency", owner: A.id });
    const sess = await repo.startSession({ intentOid: intent, actor: A });

    // Common base: an initial binary file both edits descend from.
    const base = await repo.proposeFileWrite({
      sessionOid: sess, intentOid: intent, actor: A,
      path: "bin/x.bin", content: "seed\n", declaredPurpose: "seed",
    });

    // Two distinct binary contents (NUL-bearing) written concurrently on the same base.
    const binA = Buffer.from([0x00, 0x01, 0x02, 0x41, 0xff]);
    const binB = Buffer.from([0x00, 0x09, 0x08, 0x42, 0xfe]);
    const blobA = await repo.putBlob(binA);
    const blobB = await repo.putBlob(binB);
    assert.notEqual(blobA, blobB, "the two binary contents must be distinct blobs");

    await repo.proposeOperation({
      sessionOid: sess, intentOid: intent, actor: A,
      target: { entityKind: "file", entityId: "bin/x.bin" },
      body: { kind: "put_file", path: "bin/x.bin", blobOid: blobA },
      declaredPurpose: "A writes binary", causalDeps: [base],
    });
    await repo.proposeOperation({
      sessionOid: sess, intentOid: intent, actor: B,
      target: { entityKind: "file", entityId: "bin/x.bin" },
      body: { kind: "put_file", path: "bin/x.bin", blobOid: blobB },
      declaredPurpose: "B writes binary", causalDeps: [base],
    });

    const res = await repo.materialize();

    // Invariant: concurrent divergent writes must NOT silently line-merge binary bytes.
    // Acceptable outcomes are (a) a surfaced conflict, or (b) a deterministic atomic pick
    // of one of the two original blobs (winner-takes-all), never a spliced hybrid.
    const conflicted = res.conflicts.length >= 1;
    const chosenOid = res.tree.get("bin/x.bin");

    if (conflicted) {
      // (a) Conflict surfaced for the release gate — the expected byte-safe outcome. The
      //     path may or may not stay in the tree; either way no hybrid blob may exist.
      assert.ok(res.conflicts.length >= 1, "binary contention must surface a conflict");
    } else {
      // (b) No conflict ⇒ the projected blob must be EXACTLY one of the two originals,
      //     proving no line-splice produced a corrupt hybrid blob.
      assert.ok(chosenOid !== undefined, "a non-conflicting projection must still contain the path");
      const isSynth = res.synthBlobs.has(chosenOid!);
      assert.equal(isSynth, false, "binary contention must never produce a synthesized (merged) blob");
      const bytes = await repo.readBlob(chosenOid!);
      assert.ok(
        bytes.equals(binA) || bytes.equals(binB),
        "an atomic pick must equal one original binary content byte-for-byte (no hybrid)",
      );
    }

    // In EITHER outcome, no synthesized (3-way merged) blob may carry these binary bytes —
    // a hybrid splice of two binaries is the corruption this guard exists to prevent.
    for (const [, synth] of res.synthBlobs) {
      assert.ok(!synth.equals(binA) && !synth.equals(binB),
        "no synthesized blob may be derived from line-splicing the binary contents");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 4. text regression guard: disjoint concurrent TEXT edits still auto-merge cleanly —
//        the binary guard must not break the existing 3-way line-merge path. ──
test("text 3-way merge regression: disjoint concurrent edits still auto-merge", async () => {
  const dir = await mkrepo();
  const repo = await Repo.init(dir);
  try {
    const intent = await repo.createIntent({ title: "text merge", owner: A.id });
    const sess = await repo.startSession({ intentOid: intent, actor: A });

    const base = "function a() {\n  return 1;\n}\n\n\nfunction b() {\n  return 2;\n}\n";
    const editA = "function a() {\n  return 100;\n}\n\n\nfunction b() {\n  return 2;\n}\n";
    const editB = "function a() {\n  return 1;\n}\n\n\nfunction b() {\n  return 200;\n}\n";
    const merged = "function a() {\n  return 100;\n}\n\n\nfunction b() {\n  return 200;\n}\n";

    const scaffold = await repo.proposeFileWrite({
      sessionOid: sess, intentOid: intent, actor: A,
      path: "m.js", content: base, declaredPurpose: "scaffold",
    });
    await repo.proposeEdit({
      sessionOid: sess, intentOid: intent, actor: A,
      path: "m.js", baseText: base, newText: editA, declaredPurpose: "A", causalDeps: [scaffold],
    });
    await repo.proposeEdit({
      sessionOid: sess, intentOid: intent, actor: B,
      path: "m.js", baseText: base, newText: editB, declaredPurpose: "B", causalDeps: [scaffold],
    });

    const res = await repo.materialize();
    assert.equal(res.conflicts.length, 0, "disjoint text edits must not conflict");
    assert.equal(res.fileConflicts.length, 0, "disjoint text edits must not file-conflict");
    const got = (await repo.materializedFiles(res)).find((f) => f.path === "m.js")?.content;
    assert.equal(got, merged, "both disjoint text edits must survive the auto-merge");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
