// Storage format B1 (docs/11 Track B): on-disk objects are canonical CBOR, but object
// identity is unchanged — oids are still the sha256 of the canonical JSON form, so CBOR
// is an oid-NEUTRAL storage swap. Tests: the codec round-trips every JSON-compatible
// shape; a CBOR-stored object resolves under the exact oid computed from its JSON; and a
// store transparently dual-reads legacy JSON objects written before the switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { encodeCbor, decodeCbor, looksLikeCbor } from "../src/core/cbor.ts";
import { canonicalize, computeOid } from "../src/core/canonical.ts";
import { ObjectStore } from "../src/store/objectStore.ts";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A random JSON-compatible value (null/bool/int/float/string/array/object), bounded depth. */
function randValue(rng: () => number, depth: number): unknown {
  const r = rng();
  if (depth <= 0 || r < 0.4) {
    const k = rng();
    if (k < 0.15) return null;
    if (k < 0.3) return rng() < 0.5;
    if (k < 0.55) return Math.floor(rng() * 2_000_000) - 1_000_000; // int incl. negative
    if (k < 0.7) return (rng() - 0.5) * 1e6; // float
    // string incl. unicode + non-ASCII
    return rng() < 0.5 ? `s${Math.floor(rng() * 1e6)}` : "키값-é-ñ-😀";
  }
  if (r < 0.7) { const n = Math.floor(rng() * 4); return Array.from({ length: n }, () => randValue(rng, depth - 1)); }
  const n = Math.floor(rng() * 4);
  const o: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) o[`k${Math.floor(rng() * 20)}`] = randValue(rng, depth - 1);
  return o;
}

test("CBOR codec round-trips every JSON-compatible value", () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const rng = mulberry32(seed);
    const v = randValue(rng, 4);
    const back = decodeCbor(encodeCbor(v));
    assert.deepEqual(back, v, `round-trip mismatch at seed=${seed}`);
  }
  // explicit edge cases
  for (const v of [null, true, false, 0, -1, 23, 24, 255, 256, 65535, 65536, 1.5, -1.25, "", "a", [], {}, { a: [1, { b: null }] }]) {
    assert.deepEqual(decodeCbor(encodeCbor(v)), v, `edge ${JSON.stringify(v)}`);
  }
  assert.throws(() => encodeCbor(Infinity), /non-finite/);
});

test("CBOR storage is oid-neutral: the stored object resolves under its JSON-derived oid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-cbor-"));
  try {
    const store = new ObjectStore(dir);
    await store.init();
    const obj = { type: "intent" as const, title: "t", owner: "human:h", kind: "feature", constraints: ["a", "b"], createdAt: "2026-01-01T00:00:00.000Z", priority: 3 };
    const oid = await store.put(obj as never);
    // oid is exactly what computeOid derives from the canonical JSON (unchanged by CBOR).
    assert.equal(oid, computeOid("intent", obj as never));
    // bytes on disk are CBOR, not JSON.
    const shard = oid.slice(oid.indexOf("_") + 1, oid.indexOf("_") + 3);
    const raw = await readFile(join(dir, ".avcs", "objects", shard, `${oid}.json`));
    assert.ok(looksLikeCbor(raw), "stored bytes are CBOR");
    assert.ok(raw.length < Buffer.byteLength(canonicalize({ ...obj, oid })), "CBOR is no larger than JSON");
    // read back equals the original (plus the oid field).
    assert.deepEqual(await store.get(oid), { ...obj, oid });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store dual-reads legacy JSON objects written before the CBOR switch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-dual-"));
  try {
    const store = new ObjectStore(dir);
    await store.init();
    const obj = { type: "intent" as const, title: "legacy", owner: "human:h", kind: "feature", constraints: [], createdAt: "2026-01-01T00:00:00.000Z" };
    const oid = computeOid("intent", obj as never);
    // hand-write a LEGACY canonical-JSON object file (the pre-B1 on-disk format).
    const shard = oid.slice(oid.indexOf("_") + 1, oid.indexOf("_") + 3);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, ".avcs", "objects", shard), { recursive: true });
    await writeFile(join(dir, ".avcs", "objects", shard, `${oid}.json`), canonicalize({ ...obj, oid }), "utf8");
    // the store transparently reads it (JSON path).
    assert.deepEqual(await store.get(oid), { ...obj, oid });
    // a re-put is idempotent (file already present) and the oid is unchanged.
    assert.equal(await store.put(obj as never), oid);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a full repo round-trips through CBOR storage (author, materialize, cold reopen)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-cborrepo-"));
  const ai: Actor = { kind: "ai_agent", id: "ai:a" };
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "export function a(){ return 1 }\n", declaredPurpose: "a" });
    await repo.proposeSymbolEdit({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", symbolName: "a", newText: "export function a(){ return 2 }", declaredPurpose: "edit" });
    const warm = (await repo.materialize()).treeHash;
    // cold reopen reads the CBOR objects from scratch and must agree.
    const cold = (await (await Repo.open(dir)).materialize()).treeHash;
    assert.equal(warm, cold, "CBOR repo materializes identically warm and cold");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
