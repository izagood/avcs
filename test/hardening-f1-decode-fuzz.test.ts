// Track F / F1 — decode-path robustness fuzzing (docs/10 production gate:
// "fuzzing: 객체 파서"). D1 (atomic writes) and D3 (`avcs fsck`) keep stored bytes
// honest and DETECT corruption, but the READ path itself must degrade safely: feeding
// arbitrary / truncated / bit-flipped bytes into the object decoder must never crash
// opaquely, hang, or silently corrupt the materialized tree. Instead every malformed
// object is normalized to a typed CorruptObjectError that NAMES the offending oid — so a
// decode failure deep inside materialize/pull is actionable (run fsck on that oid), not
// an inscrutable "Unexpected token in JSON".
//
// Strategy: a seeded PRNG makes every adversarial buffer reproducible (the seed prints
// on failure). We overwrite a real stored operation with each fuzzed buffer and exercise
// the public read API (ObjectStore.get / Repo.materialize). The load-bearing assertion
// is the DICHOTOMY: every read either decodes to a value OR throws CorruptObjectError —
// no third outcome (opaque throw, non-Error throw, hang) is permitted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { Repo } from "../src/api/repo.ts";
import { ObjectStore, CorruptObjectError } from "../src/store/objectStore.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

// ── seeded PRNG (mulberry32) — reproducible adversarial buffers ───────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seed(dir: string): Promise<Repo> {
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  for (let i = 0; i < 3; i++)
    await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: `f${i}.ts`, content: `export const v${i} = ${i}\n`, declaredPurpose: `f${i}` });
  return repo;
}

/** Path + oid of the first loose object file matching a type prefix. */
async function firstObject(dir: string, typePrefix: string): Promise<{ path: string; oid: string }> {
  const objects = join(dir, ".avcs", "objects");
  for (const shard of await readdir(objects)) {
    const shardDir = join(objects, shard);
    for (const f of await readdir(shardDir))
      if (f.startsWith(typePrefix) && f.endsWith(".json")) return { path: join(shardDir, f), oid: f.slice(0, -".json".length) };
  }
  throw new Error(`no ${typePrefix} object found`);
}

// Build one adversarial buffer from the original valid bytes, varied by category.
function fuzzBuffer(rng: () => number, original: Buffer): Buffer {
  const cat = Math.floor(rng() * 6);
  switch (cat) {
    case 0: { // pure random bytes
      const n = Math.floor(rng() * 64);
      const b = Buffer.alloc(n);
      for (let i = 0; i < n; i++) b[i] = Math.floor(rng() * 256);
      return b;
    }
    case 1: // empty file (a torn write that wrote nothing)
      return Buffer.alloc(0);
    case 2: // truncated copy of the real (CBOR) object
      return original.subarray(0, Math.max(0, Math.floor(rng() * original.length)));
    case 3: { // bit-flip a random byte of the real object
      const b = Buffer.from(original);
      if (b.length) {
        const i = Math.floor(rng() * b.length);
        b[i] = (b[i] ?? 0) ^ (1 << Math.floor(rng() * 8));
      }
      return b;
    }
    case 4: // valid JSON object followed by trailing garbage
      return Buffer.concat([Buffer.from('{"type":"operation"}'), Buffer.from([0xff, 0x00, 0x7b, 0x7b])]);
    default: { // a CBOR-looking header (high bit set) then nonsense → exercises the CBOR path
      const n = 1 + Math.floor(rng() * 32);
      const b = Buffer.alloc(n);
      b[0] = 0xa0 | Math.floor(rng() * 0x1f); // map major type, bogus length
      for (let i = 1; i < n; i++) b[i] = Math.floor(rng() * 256);
      return b;
    }
  }
}

test("F1: the decode path never crashes opaquely — every read is {value} ∪ {CorruptObjectError}", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-f1fuzz-"));
  try {
    await seed(dir);
    const victim = await firstObject(dir, "operation_");
    const original = await readFile(victim.path);
    const store = new ObjectStore(dir);

    let decoded = 0;
    let rejected = 0;
    const ITER = 400;
    for (let it = 0; it < ITER; it++) {
      const s = 0xF1 + it;
      const rng = mulberry32(s);
      const buf = fuzzBuffer(rng, original);
      await writeFile(victim.path, buf);
      try {
        await store.get(victim.oid);
        decoded++; // bytes happened to be a valid encoding — acceptable, fsck would catch a hash mismatch
      } catch (e) {
        assert.ok(
          e instanceof CorruptObjectError,
          `F1 FAIL seed=${s}: decode threw a non-typed error ${(e as Error)?.constructor?.name}: ${(e as Error)?.message}`,
        );
        assert.equal((e as CorruptObjectError).oid, victim.oid, `F1 FAIL seed=${s}: CorruptObjectError must name the offending oid`);
        rejected++;
      }
    }
    // Sanity: the corpus is genuinely adversarial — the overwhelming majority is rejected,
    // and the test reaching here at all proves no buffer hung the decoder.
    assert.equal(decoded + rejected, ITER);
    assert.ok(rejected > ITER / 2, `expected most fuzzed buffers rejected, got ${rejected}/${ITER}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("F1: a corrupt object surfaces through materialize as a CorruptObjectError naming the oid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-f1mat-"));
  try {
    await seed(dir);
    const victim = await firstObject(dir, "operation_");
    await writeFile(victim.path, Buffer.from("}}} torn — neither json nor cbor"));

    // A FRESH repo (cold caches) must re-read the corrupt op while reconstructing state
    // and fail ACTIONABLY: a typed error pointing at the exact object, not an opaque parse
    // throw. (Repo.open eagerly scans operations for the lamport ceiling, so the corruption
    // surfaces at open or materialize — either way it names the oid.)
    let caught: unknown;
    try {
      const fresh = await Repo.open(dir);
      await fresh.materialize("main");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof CorruptObjectError, `reopening over a corrupt op must throw a typed CorruptObjectError, got ${String(caught)}`);
    assert.equal((caught as CorruptObjectError).oid, victim.oid, "the error must name the exact corrupt op");

    // fsck still DETECTS it (D3) — detection and the actionable read error coexist.
    const report = await new ObjectStore(dir).fsck();
    assert.ok(!report.ok && report.corrupt.some((c) => c.oid === victim.oid && /undecodable/.test(c.reason)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("F1: ObjectStore.get on a torn object names the oid (direct contract)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-f1get-"));
  try {
    await seed(dir);
    const victim = await firstObject(dir, "operation_");
    await writeFile(victim.path, Buffer.alloc(0)); // empty: truncated to nothing
    const store = new ObjectStore(dir);
    let caught: unknown;
    try {
      await store.get(victim.oid);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof CorruptObjectError && caught.oid === victim.oid, `expected CorruptObjectError naming the oid, got ${String(caught)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
