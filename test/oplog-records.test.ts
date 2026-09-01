// The op-log carries the fields a reader needs to filter a view WITHOUT reading bodies.
//
// `materialize` filtered by `op.line` / `op.workspace` and the Lamport reseed wanted
// `max(op.lamport)` — all three live in the operation body, so recovering them meant reading
// and decoding every operation in the store. They are now written into the log line.
//
// The contract these tests pin:
//  - a record round-trips, including names containing the record's own separators;
//  - a legacy bare-oid line stays valid and simply reports no metadata;
//  - appending a record for an oid already logged as a bare line UPGRADES it in place —
//    position from the old line, metadata from the new one. That is what makes the upgrade
//    append-only, so it never rewrites history and cannot lose a concurrent append;
//  - first-write order survives all of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { ObjectStore } from "../src/store/objectStore.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function seeded(ops: number, line?: string): Promise<{ dir: string; repo: Repo }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-oplogrec-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  for (let i = 0; i < ops; i++) {
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: `f${i}.ts`, content: `v${i}\n`, declaredPurpose: `w${i}`, line });
  }
  return { dir, repo };
}

test("a freshly written op-log carries lamport, line and workspace", async () => {
  const { dir, repo } = await seeded(3);
  const entries = await repo.store.readOpLogEntries();
  assert.ok(entries.length >= 3, `expected records, got ${entries.length}`);
  for (const e of entries) {
    assert.ok(e.meta, `entry ${e.oid} carries no metadata`);
    assert.ok(Number.isInteger(e.meta!.lamport) && e.meta!.lamport > 0);
    assert.equal(e.meta!.line, "main", "an op that named no line reads back as main");
    assert.equal(e.meta!.workspace, null, "no workspace tag reads back as null, not ''");
  }
  // The metadata must agree with the bodies it stands in for.
  for (const e of entries) {
    const op = await repo.store.get(e.oid);
    assert.equal(e.meta!.lamport, (op as { lamport: number }).lamport);
  }
  assert.deepEqual(await repo.store.readOpLog(), entries.map((e) => e.oid), "readOpLog still yields oids");
  await rm(dir, { recursive: true, force: true });
});

test("a name containing a tab or newline survives the round trip", async () => {
  const { dir, repo } = await seeded(1, "weird\tname\nwith%signs");
  const [e] = await repo.store.readOpLogEntries();
  assert.ok(e?.meta, "record expected");
  assert.equal(e!.meta!.line, "weird\tname\nwith%signs", "separators must not corrupt the field");
  // And the file itself must still be one line per record.
  const raw = await readFile(join(dir, ".avcs", "oplog"), "utf8");
  assert.equal(raw.trimEnd().split("\n").length, 1, `record spans more than one line:\n${raw}`);
  await rm(dir, { recursive: true, force: true });
});

test("a legacy bare-oid log still reads, and an appended record upgrades it in place", async () => {
  const { dir, repo } = await seeded(3);
  const p = join(dir, ".avcs", "oplog");
  const entries = await repo.store.readOpLogEntries();
  const order = entries.map((e) => e.oid);

  // Rewrite the log the way a pre-record store held it: bare oids, same order.
  await writeFile(p, order.map((o) => `${o}\n`).join(""), "utf8");
  const legacy = await repo.store.readOpLogEntries();
  assert.deepEqual(legacy.map((e) => e.oid), order, "order preserved");
  assert.deepEqual(legacy.map((e) => e.meta), [undefined, undefined, undefined], "no metadata to report");

  // Now append records for the SAME oids, in a different order.
  const ops = await Promise.all(order.map((o) => repo.store.get(o)));
  const n = await repo.store.appendOpLogRecords([...ops].reverse());
  assert.equal(n, 3, "three records appended");

  const upgraded = await repo.store.readOpLogEntries();
  assert.deepEqual(upgraded.map((e) => e.oid), order, "position still comes from the FIRST occurrence");
  for (const e of upgraded) assert.ok(e.meta, `entry ${e.oid} was not upgraded`);
  for (const e of upgraded) {
    const op = await repo.store.get(e.oid);
    assert.equal(e.meta!.lamport, (op as { lamport: number }).lamport, "upgraded metadata must match the body");
  }
  await rm(dir, { recursive: true, force: true });
});

test("an unrecognised line is treated as metadata-less rather than crashing the read", async () => {
  // Forward compatibility in both directions: a line this version cannot parse must not take
  // the log down, and a line with EXTRA fields (a later format) still reads as a record.
  const { dir, repo } = await seeded(1);
  const [only] = await repo.store.readOpLogEntries();
  const oid = only!.oid;
  const p = join(dir, ".avcs", "oplog");

  await appendFile(p, `${oid}\tnot-a-number\tmain\t\n`, "utf8");
  await appendFile(p, "deadbeef\ttwo-fields\n", "utf8");
  const entries = await repo.store.readOpLogEntries();
  assert.equal(entries[0]!.oid, oid);
  assert.ok(entries[0]!.meta, "the good record still stands");
  const junk = entries.find((e) => e.oid === "deadbeef");
  assert.ok(junk, "an unparsable line still yields its oid");
  assert.equal(junk!.meta, undefined, "and reports no metadata");

  await appendFile(p, `${ObjectStore.opLogLine("cafe", { lamport: 9, line: "l" }).trimEnd()}\textra\n`, "utf8");
  const withExtra = (await repo.store.readOpLogEntries()).find((e) => e.oid === "cafe");
  assert.equal(withExtra?.meta?.lamport, 9, "extra trailing fields are ignored, not fatal");
  await rm(dir, { recursive: true, force: true });
});

test("rebuildOpLog writes records too", async () => {
  const { dir, repo } = await seeded(4);
  const n = await repo.store.rebuildOpLog();
  assert.equal(n, (await repo.store.readOpLog()).length);
  for (const e of await repo.store.readOpLogEntries()) assert.ok(e.meta, "rebuild must not lose metadata");
  await rm(dir, { recursive: true, force: true });
});
