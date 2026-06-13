// Minimal canonical CBOR codec for AVCS objects (docs/11 Track B / B1). No dependencies.
//
// Scope: the JSON-compatible value space AVCS objects live in — null, boolean, finite
// number, string, array, and string-keyed object. That is exactly what `canonicalize`
// (JSON) accepts, so CBOR is a drop-in *storage/transport* encoding. Object identity is
// UNCHANGED: oids are still the sha256 of the canonical JSON form (see canonical.ts), so
// switching the on-disk bytes to CBOR is oid-neutral — content addressing, signatures,
// and treeHash are untouched.
//
// Canonical form (RFC 8949 §4.2 core rules we need): definite lengths, shortest-possible
// integer/length headers, map keys sorted by their UTF-8 bytes, `undefined` object
// fields dropped (mirrors canonicalize). Determinism isn't required for correctness (the
// oid is JSON-derived) but keeps byte output stable and idempotent writes a no-op.
import { Buffer } from "node:buffer";

// Major types (high 3 bits of the initial byte).
const MAJOR_UINT = 0;
const MAJOR_NEGINT = 1;
const MAJOR_TEXT = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;

class Writer {
  #chunks: Buffer[] = [];
  push(b: Buffer): void { this.#chunks.push(b); }
  /** Initial byte (major<<5 | argument) with the shortest header for `n`. */
  header(major: number, n: number): void {
    if (n < 0 || !Number.isInteger(n)) throw new Error(`bad header length ${n}`);
    if (n < 24) this.push(Buffer.from([(major << 5) | n]));
    else if (n < 0x100) this.push(Buffer.from([(major << 5) | 24, n]));
    else if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); this.push(b); }
    else if (n < 0x100000000) { const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); this.push(b); }
    else { const b = Buffer.alloc(9); b[0] = (major << 5) | 27; b.writeBigUInt64BE(BigInt(n), 1); this.push(b); }
  }
  bytes(): Buffer { return Buffer.concat(this.#chunks); }
}

function encodeValue(w: Writer, v: unknown): void {
  if (v === null || v === undefined) { w.push(Buffer.from([0xf6])); return; } // null (undefined only reaches here at top level)
  switch (typeof v) {
    case "boolean": w.push(Buffer.from([v ? 0xf5 : 0xf4])); return;
    case "number": {
      if (!Number.isFinite(v)) throw new Error(`non-finite number is not serializable: ${v}`);
      if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) {
        if (v >= 0) w.header(MAJOR_UINT, v);
        else w.header(MAJOR_NEGINT, -1 - v);
      } else {
        const b = Buffer.alloc(9); b[0] = 0xfb; b.writeDoubleBE(v, 1); w.push(b); // float64
      }
      return;
    }
    case "string": {
      const utf8 = Buffer.from(v, "utf8");
      w.header(MAJOR_TEXT, utf8.length);
      w.push(utf8);
      return;
    }
    case "bigint": throw new Error("bigint is not serializable in AVCS objects; pass a string");
    case "object": {
      if (Array.isArray(v)) {
        w.header(MAJOR_ARRAY, v.length);
        for (const item of v) encodeValue(w, item ?? null);
        return;
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort((a, b) => {
        const ba = Buffer.from(a, "utf8"); const bb = Buffer.from(b, "utf8");
        return ba.compare(bb);
      });
      w.header(MAJOR_MAP, keys.length);
      for (const k of keys) { encodeValue(w, k); encodeValue(w, obj[k]); }
      return;
    }
    default: throw new Error(`unserializable value of type ${typeof v}`);
  }
}

/** Encode a JSON-compatible value to canonical CBOR bytes. */
export function encodeCbor(value: unknown): Buffer {
  const w = new Writer();
  encodeValue(w, value);
  return w.bytes();
}

class Reader {
  #buf: Buffer;
  #pos = 0;
  constructor(buf: Buffer) { this.#buf = buf; }
  #u8(): number { if (this.#pos >= this.#buf.length) throw new Error("CBOR: unexpected end"); return this.#buf[this.#pos++]!; }
  #take(n: number): Buffer { if (this.#pos + n > this.#buf.length) throw new Error("CBOR: unexpected end"); const s = this.#buf.subarray(this.#pos, this.#pos + n); this.#pos += n; return s; }
  /** Read the argument that follows an initial byte's low-5-bits `info`. */
  #arg(info: number): number {
    if (info < 24) return info;
    if (info === 24) return this.#u8();
    if (info === 25) { const b = this.#take(2); return b.readUInt16BE(0); }
    if (info === 26) { const b = this.#take(4); return b.readUInt32BE(0); }
    if (info === 27) { const b = this.#take(8); const n = b.readBigUInt64BE(0); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR: integer too large"); return Number(n); }
    throw new Error(`CBOR: bad additional info ${info}`);
  }
  value(): unknown {
    const ib = this.#u8();
    const major = ib >> 5;
    const info = ib & 0x1f;
    switch (major) {
      case MAJOR_UINT: return this.#arg(info);
      case MAJOR_NEGINT: return -1 - this.#arg(info);
      case MAJOR_TEXT: { const len = this.#arg(info); return this.#take(len).toString("utf8"); }
      case MAJOR_ARRAY: { const len = this.#arg(info); const out: unknown[] = []; for (let i = 0; i < len; i++) out.push(this.value()); return out; }
      case MAJOR_MAP: {
        const len = this.#arg(info);
        const out: Record<string, unknown> = {};
        for (let i = 0; i < len; i++) { const k = this.value(); if (typeof k !== "string") throw new Error("CBOR: non-string map key"); out[k] = this.value(); }
        return out;
      }
      case 7: { // simple/float
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null; // null / undefined → null
        if (info === 27) { const b = this.#take(8); return b.readDoubleBE(0); }
        if (info === 26) { const b = this.#take(4); return b.readFloatBE(0); }
        throw new Error(`CBOR: unsupported simple value ${info}`);
      }
      default: throw new Error(`CBOR: unsupported major type ${major}`);
    }
  }
  done(): boolean { return this.#pos === this.#buf.length; }
}

/** Decode canonical CBOR bytes back to a JSON-compatible value. */
export function decodeCbor(buf: Buffer): unknown {
  const r = new Reader(buf);
  const v = r.value();
  if (!r.done()) throw new Error("CBOR: trailing bytes");
  return v;
}

/** True if `buf` looks like a CBOR object (map) rather than legacy JSON (`{`/whitespace).
 *  A CBOR map's initial byte has major type 5 (0xa0–0xbf); JSON starts with 0x7b/ws. */
export function looksLikeCbor(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const b0 = buf[0]!;
  return b0 >= 0xa0 && b0 <= 0xbf; // major type 5 (map), definite or indefinite
}
