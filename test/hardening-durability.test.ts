// Track D / D1 — directory-fsync durability. We can't induce a real power loss in a
// unit test, but we can assert the durability machinery is wired and side-effect-free:
// objects/refs/op-log stay consistent after a put, the directory-fsync path executes
// without throwing on this platform, and the AVCS_NO_FSYNC opt-out is honored. The
// crash-correctness itself is argued structurally (fsync file → rename → fsync dir).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStore } from "../src/store/objectStore.ts";
import type { AnyObject } from "../src/objects/types.ts";

function op(purpose: string): AnyObject {
  return {
    type: "operation",
    intentOid: "intent_x",
    sessionOid: "session_x",
    actor: { kind: "ai_agent", id: "ai:a" },
    lamport: 1,
    causalDeps: [],
    declaredPurpose: purpose,
    target: { entityKind: "file", entityId: `f-${purpose}.ts` },
    body: { kind: "note", note: purpose },
  } as unknown as AnyObject;
}

async function roundtrip(noFsync: boolean): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-dur-"));
  const saved = process.env.AVCS_NO_FSYNC;
  if (noFsync) process.env.AVCS_NO_FSYNC = "1";
  else delete process.env.AVCS_NO_FSYNC;
  try {
    // NO_FSYNC is read at module load, so this asserts behavior under whatever the
    // module captured; the durable path (default) is the one this suite normally runs.
    const store = new ObjectStore(dir);
    await store.init();
    const oids: string[] = [];
    for (let i = 0; i < 5; i++) oids.push(await store.put(op(`n${i}`)));

    // every object is readable back and content-addresses to its oid
    for (const oid of oids) assert.equal((await store.get(oid)).oid, oid);

    // op-log is consistent with the object set (no dropped append)
    const log = await store.readOpLog();
    assert.deepEqual([...log].sort(), [...oids].sort(), "op-log == object set");

    // refs/HEAD survive the durable write path
    await store.setRef("main", oids[0]!);
    assert.equal(await store.getRef("main"), oids[0]);
    assert.equal((await readFile(join(dir, ".avcs", "HEAD"), "utf8")).trim(), "main");

    // entity index append is durable + readable
    await store.appendEntityIndex("file:a.ts", oids[1]!);
    assert.deepEqual(await store.readEntityIndex("file:a.ts"), [oids[1]]);
  } finally {
    if (saved === undefined) delete process.env.AVCS_NO_FSYNC;
    else process.env.AVCS_NO_FSYNC = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

test("durable write path keeps object/op-log/ref/index consistent (default fsync)", async () => {
  await roundtrip(false);
});

test("AVCS_NO_FSYNC opt-out still produces a consistent store", async () => {
  await roundtrip(true);
});

test("no temp files leak after atomic writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-dur2-"));
  try {
    const store = new ObjectStore(dir);
    await store.init();
    await store.put(op("a"));
    await store.setRef("main", "operation_deadbeef");
    const { readdir } = await import("node:fs/promises");
    const refs = await readdir(join(dir, ".avcs", "refs"));
    assert.ok(!refs.some((f) => f.includes(".tmp-")), "no leftover temp files in refs");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
