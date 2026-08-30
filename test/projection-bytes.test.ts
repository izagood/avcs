// The projection's primitive shape is BYTES, not string (audit ④ + a defect found beside it).
//
// The storage layer is already all Buffer — `readBlob` returns one, `#treeEntryBytes` returns
// one, `materializedBytes` returns one, and `putBlob` accepts `string | Uint8Array`. String
// appears in exactly one outermost layer: `materializedFiles` and `checkpointFiles` call
// `bytes.toString("utf8")` on the way out. That one layer is where binary content gets
// destroyed, and the damage is not symmetric with the rest of the system:
//
//   원본    89504e470d0a1a0afffe0080      12 bytes — a PNG signature plus invalid UTF-8
//   왕복 후 efbfbd504e470d0a1a0aefbfbd…   20 bytes — every invalid sequence became U+FFFD
//
// Two consumers are hurt by it, and one of them is far worse than the other:
//
//   - `checkpointFiles` feeds a projection comparison. A lossy read makes two different
//     binaries compare equal, so a "verify before pushing" check passes on nothing.
//   - `revert()` re-authors the previous content as a NEW op via `putBlob`. There the
//     mangled bytes are written into an append-only graph and cannot be taken back.
//
// So the fix is not "add a bytes variant". It is to make bytes the body and string the
// wrapper — text consumers (blame, diff hunks, merge3) genuinely want lines and keep the
// string view; everything that hands the projection back out takes bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };

/** A PNG signature followed by byte sequences that are not valid UTF-8. Round-tripping this
 *  through a string is what turns 12 bytes into 20. */
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80]);

/**
 * Author one write. `after` makes it causally FOLLOW an earlier op — without that the two
 * writes are concurrent, `revert` walking `causalDeps` finds no prior state for the path, and
 * it (correctly) treats the op as a creation and reverts by deleting. That is not the shape
 * these tests are about, and it fooled this file once already.
 */
async function write(
  repo: Repo, path: string, content: string | Buffer, purpose = "w", after?: string,
): Promise<string> {
  const intent = await repo.createIntent({ title: purpose, owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: human });
  return repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: human, path, content, declaredPurpose: purpose,
    ...(after ? { causalDeps: [after] } : {}),
  });
}

test("checkpointBytes hands back the stored bytes unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-proj-"));
  try {
    const repo = await Repo.init(dir);
    await write(repo, "logo.png", BINARY, "binary");
    const cp = await repo.createCheckpoint("main", "binary");

    const { files, treeHashOk } = await repo.checkpointBytes(cp);
    const got = files.find((f) => f.path === "logo.png")!.bytes;

    assert.equal(treeHashOk, true, "the checkpoint still verifies");
    assert.ok(Buffer.isBuffer(got), `bytes, not a string — got ${got?.constructor?.name}`);
    assert.ok(
      got.equals(BINARY),
      `byte-identical\n  want ${BINARY.toString("hex")} (${BINARY.length}B)` +
        `\n  got  ${got.toString("hex")} (${got.length}B)`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The string view stays, and its existing callers must not notice the body moving underneath.
test("checkpointFiles keeps answering for its text callers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-proj-text-"));
  try {
    const repo = await Repo.init(dir);
    await write(repo, "a.ts", "export const a = 1\n", "text");
    const cp = await repo.createCheckpoint("main", "text");

    const { files, treeHash, treeHashOk } = await repo.checkpointFiles(cp);
    assert.equal(treeHashOk, true);
    assert.ok(treeHash.length > 0);
    assert.equal(files.find((f) => f.path === "a.ts")!.content, "export const a = 1\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The one that cannot be undone. `revert` authors the restoration as a new op, so a lossy
// read here writes damaged bytes into the append-only graph.
test("reverting a binary file restores the exact bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-revert-bin-"));
  try {
    const repo = await Repo.init(dir);
    const seed = await write(repo, "logo.png", BINARY, "seed");
    const overwrite = await write(repo, "logo.png", Buffer.from([0x00, 0x01]), "overwrite", seed);

    await repo.revert(overwrite, human);

    const res = await repo.materialize("main");
    const got = (await repo.materializedBytes(res)).find((f) => f.path === "logo.png")!.bytes;
    assert.ok(
      got.equals(BINARY),
      `revert must restore the original bytes, not a UTF-8 round trip\n` +
        `  want ${BINARY.toString("hex")} (${BINARY.length}B)` +
        `\n  got  ${got.toString("hex")} (${got.length}B)`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Regression guard: reverting text was already correct and must stay so. This one passes
// before the change too — it is here to catch the fix breaking the common path.
test("reverting a text file still restores it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-revert-txt-"));
  try {
    const repo = await Repo.init(dir);
    const seed = await write(repo, "a.ts", "export const a = 1\n", "seed");
    const overwrite = await write(repo, "a.ts", "export const a = 2\n", "overwrite", seed);

    await repo.revert(overwrite, human);

    const files = await repo.materializedFiles(await repo.materialize("main"));
    assert.equal(files.find((f) => f.path === "a.ts")!.content, "export const a = 1\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Reverting a creation deletes the file. Also already correct — guards the `prev === undefined`
// branch, which the fix touches by proximity.
test("reverting a file's creation still deletes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-revert-new-"));
  try {
    const repo = await Repo.init(dir);
    const created = await write(repo, "gone.ts", "export const g = 1\n", "create");

    await repo.revert(created, human);

    assert.equal((await repo.materialize("main")).tree.has("gone.ts"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
