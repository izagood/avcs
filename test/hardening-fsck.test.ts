// Track D / D3 — `avcs fsck`: object integrity + op-log reconciliation. A local
// production VCS must be able to DETECT bit-rot / a torn object and op-log drift, and
// REPAIR the (rebuildable) op-log without a re-clone. These tests inject each failure
// mode against the real store and assert fsck catches and (for the log) fixes it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { ObjectStore } from "../src/store/objectStore.ts";
import { redactedStub } from "../src/store/applyRedactions.ts";
import type { Actor, Blob } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function seed(dir: string): Promise<Repo> {
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  for (let i = 0; i < 4; i++)
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: `f${i}.ts`, content: `export const v${i} = ${i}\n`, declaredPurpose: `f${i}` });
  return repo;
}

/** Path of the first loose object file matching a type prefix. */
async function firstObjectFile(dir: string, typePrefix: string): Promise<string> {
  const objects = join(dir, ".avcs", "objects");
  for (const shard of await readdir(objects)) {
    const shardDir = join(objects, shard);
    for (const f of await readdir(shardDir))
      if (f.startsWith(typePrefix) && f.endsWith(".json")) return join(shardDir, f);
  }
  throw new Error(`no ${typePrefix} object found`);
}

test("fsck reports a clean repo as healthy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-fsck-"));
  try {
    await seed(dir);
    const r = await new ObjectStore(dir).fsck();
    assert.ok(r.ok, `expected healthy, got ${JSON.stringify(r)}`);
    assert.equal(r.corrupt.length, 0);
    assert.equal(r.oplogDrift.opsMissingFromLog.length, 0);
    assert.ok(r.objectsChecked >= 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fsck detects an undecodable (torn) object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-fsck2-"));
  try {
    await seed(dir);
    const victim = await firstObjectFile(dir, "operation_");
    await writeFile(victim, Buffer.from("}}} not valid json or cbor")); // torn bytes
    const r = await new ObjectStore(dir).fsck();
    assert.ok(!r.ok, "torn object must fail fsck");
    assert.equal(r.corrupt.length, 1);
    assert.match(r.corrupt[0]!.reason, /undecodable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fsck detects content that no longer hashes to its address (bit-rot)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-fsck3-"));
  try {
    await seed(dir);
    const victim = await firstObjectFile(dir, "operation_");
    // decode, mutate a content field, write back at the SAME path → oid mismatch.
    const store = new ObjectStore(dir);
    const oid = victim.slice(victim.lastIndexOf("/") + 1, -".json".length);
    const obj = await store.get(oid);
    (obj as { declaredPurpose: string }).declaredPurpose = "TAMPERED";
    await writeFile(victim, Buffer.from(JSON.stringify(obj))); // valid JSON, wrong content
    const r = await store.fsck();
    assert.ok(!r.ok, "tampered object must fail fsck");
    assert.equal(r.corrupt.length, 1);
    assert.match(r.corrupt[0]!.reason, /hashes to/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fsck detects op-log drift and --rebuild repairs it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-fsck4-"));
  try {
    await seed(dir);
    const store = new ObjectStore(dir);
    const full = await store.readOpLog();
    assert.ok(full.length >= 4);
    // simulate a dropped append: truncate the last op-log line.
    const logPath = join(dir, ".avcs", "oplog");
    const lines = (await readFile(logPath, "utf8")).split("\n").filter(Boolean);
    await writeFile(logPath, lines.slice(0, -1).map((l) => `${l}\n`).join(""));

    const drift = await store.fsck();
    assert.ok(!drift.ok, "drift must fail fsck");
    assert.equal(drift.oplogDrift.opsMissingFromLog.length, 1);
    assert.equal(drift.corrupt.length, 0, "objects themselves are fine");

    const fixed = await store.fsck({ rebuild: true });
    assert.ok(fixed.repaired?.oplogRebuilt, "rebuild ran");
    assert.equal((await store.readOpLog()).length, full.length, "op-log restored");
    const after = await store.fsck();
    assert.ok(after.ok, "healthy after rebuild");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fsck exempts a redacted blob (sanctioned overwrite)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-fsck5-"));
  try {
    await seed(dir);
    const store = new ObjectStore(dir);
    // find a blob and overwrite it with a redaction stub (no longer hashes to its oid).
    let blobOid: string | null = null;
    for await (const b of store.list<Blob>("blob")) { blobOid = b.oid as string; break; }
    assert.ok(blobOid, "a blob exists");
    await store.overwriteAt(blobOid, redactedStub("secret", "redaction_x"));
    const r = await store.fsck();
    assert.ok(r.ok, `redacted blob must be exempt, got ${JSON.stringify(r.corrupt)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
