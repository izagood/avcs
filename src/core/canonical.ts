// Canonical serialization + content addressing.
//
// AVCS objects are content-addressed: an object's identity is the hash of its
// canonical byte representation. The MVP uses canonical JSON (deterministic key
// ordering, no insignificant whitespace). The on-disk/wire format is intended to
// migrate to canonical CBOR later — `serialize` is the single choke point so that
// swap stays local.

import { createHash } from "node:crypto";

/**
 * Deterministically serialize a JSON-compatible value:
 *  - object keys sorted lexicographically
 *  - no insignificant whitespace
 *  - `undefined` fields dropped (objects only)
 * Throws on non-finite numbers and on values that cannot round-trip.
 */
/**
 * The interop-safe subset of what `canonicalize` will accept.
 *
 * `canonicalize` produces canonical JSON and the oid is its sha256. Three parts of that are
 * ECMAScript-specific, and a non-JS implementation can differ on each:
 *
 *   numbers   `JSON.stringify(n)` is Number::toString. `1.0` prints "1", `1e21` prints
 *             "1e+21". Python's repr and Go's strconv do not agree with it everywhere, so a
 *             non-integer or out-of-range value is an interop hazard.
 *   key order `Array.prototype.sort` compares UTF-16 CODE UNITS. For a key containing an
 *             astral character the high surrogate (U+D800..U+DBFF) sorts BELOW U+E000, while
 *             a code-point sort puts the astral character above it. Same object, two orders.
 *   strings   the escape set, and what happens to a lone surrogate.
 *
 * Divergence here does not raise an error anywhere. It produces a DIFFERENT OID for the same
 * content, and then two honest implementations never converge: the server truthfully reports
 * what it has, the client truthfully asks for what it lacks, and they never meet.
 *
 * So the subset is deliberately narrow, and it is a DESCRIPTION rather than a restriction:
 * measured over the objects that exist today (15,680 in local stores plus 14,073 on a hub's
 * object plane — over 2M scalar fields) there are zero violations. It stays that way only if
 * something checks, which is what this function is for. `custom:<name>` evidence keys reach
 * `Checkpoint.evidence` as OBJECT KEYS, so a user-chosen string is hashed material.
 *
 * Values are not restricted the same way: a string VALUE never participates in key ordering,
 * so `"배포 완료 🚀"` is fine. Only lone surrogates are refused in values, and those cannot
 * come from valid text.
 */
export function assertInteropSafe(value: unknown, path = "$"): void {
  if (value === null) return;
  const t = typeof value;
  if (t === "number") {
    const n = value as number;
    if (!Number.isInteger(n)) {
      throw new Error(
        `${path}: only integer numbers are interop-safe (got ${n}) — float formatting differs between languages`,
      );
    }
    if (!Number.isSafeInteger(n)) {
      throw new Error(`${path}: integer out of safe range (got ${n}) — outside ±2^53-1 is not interop-safe`);
    }
    return;
  }
  if (t === "string") {
    assertNoLoneSurrogate(value as string, path);
    return;
  }
  if (t === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertInteropSafe(v, `${path}[${i}]`));
    return;
  }
  if (t === "object") {
    for (const k of Object.keys(value as Record<string, unknown>)) {
      assertKeyInteropSafe(k, path);
      assertInteropSafe((value as Record<string, unknown>)[k], `${path}.${k}`);
    }
    return;
  }
  // bigint/function/symbol/undefined — canonicalize refuses these too, with its own message.
}

/** A high or low surrogate not part of a pair. Valid text cannot contain one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Any character outside the BMP — where a UTF-16 sort and a code-point sort disagree. */
const ASTRAL = /[\u{10000}-\u{10FFFF}]/u;

function assertNoLoneSurrogate(s: string, path: string): void {
  if (LONE_SURROGATE.test(s)) {
    throw new Error(`${path}: lone surrogate is not interop-safe — the string is not valid text`);
  }
}

function assertKeyInteropSafe(k: string, path: string): void {
  assertNoLoneSurrogate(k, `${path} (key ${JSON.stringify(k)})`);
  if (ASTRAL.test(k)) {
    throw new Error(
      `${path}: object key ${JSON.stringify(k)} contains an astral character — a UTF-16 sort and a ` +
        `code-point sort disagree on it, so the canonical order (and the oid) would differ by implementation`,
    );
  }
  if (k.normalize("NFC") !== k) {
    throw new Error(
      `${path}: object key ${JSON.stringify(k)} is not NFC-normalized — the same character in two ` +
        `encodings would hash to two different oids`,
    );
  }
}

export function canonicalize(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error(`non-finite number is not serializable: ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (t === "boolean" || t === "string") return JSON.stringify(value);
  if (t === "bigint") {
    // Refuse rather than encode as a string: `1n` and "1" must not collide.
    throw new Error("bigint is not serializable in AVCS objects; pass a string explicitly");
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => encode(v ?? null)).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const body = keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k])}`).join(",");
    return `{${body}}`;
  }
  throw new Error(`unserializable value of type ${t}`);
}

/** sha256 hex of arbitrary bytes/strings. */
export function sha256hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Compute the object id of a typed payload. The `oid` field (if present) is never
 * part of its own hash — content addressing must be a fixed point.
 */
export function computeOid(type: string, payload: Record<string, unknown>): string {
  // oid and sig are excluded: oid is a fixed point of the content; a
  // signature signs the oid, so it cannot be inside what it signs.
  const { oid: _oid, sig: _sig, ...rest } = payload as { oid?: unknown; sig?: unknown };
  void _oid;
  void _sig;
  const digest = sha256hex(`${type} ${canonicalize(rest)}`);
  // Short, human-greppable, collision-safe enough for an MVP: type prefix + 16 bytes.
  return `${type}_${digest.slice(0, 32)}`;
}
