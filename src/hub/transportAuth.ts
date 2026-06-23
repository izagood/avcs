// Transport-layer authentication for hub requests (SSH-style public-key auth over HTTP).
//
// Unlike `authorizePush` in hubServer.ts — which authenticates individual GOVERNANCE
// OBJECTS (an operation/decision carries an ed25519 signature over its own oid) — this
// authenticates the REQUEST/CONNECTION, the way `git clone git@host` proves possession
// of a key before the server speaks. The model mirrors SSH exactly:
//
//   ~/.ssh/id_ed25519        →  the local actor's private key (.avcs/private/<id>.json)
//   authorized_keys          →  the hub's `member:<keyId>` ref → Membership.publicKey
//   challenge-response nonce →  a per-request signature over the request itself
//
// No secret is transmitted: the client signs a canonical description of the request with
// its private key, the server verifies against the registered public key. Replay is
// bounded by a freshness window on the timestamp plus a seen-nonce cache. The two layers
// are orthogonal and share one keypair: transport auth answers "are you a registered
// member at all" (failure → 401); object-level `authorizePush` answers "is THIS object
// validly signed by a sufficiently-privileged role" (failure → 403).

import { randomBytes } from "node:crypto";
import { sha256hex } from "../core/canonical.ts";
import { signMessage, verifyMessage } from "../core/identity.ts";

/** Authorization scheme token. `Authorization: AVCS-Sig keyId="...", ts="...", ...`. */
export const AUTH_SCHEME = "AVCS-Sig";

/** Default freshness window for a request signature (ms). A request whose `ts` is more
 *  than this far from the server clock (either direction) is rejected as stale/replayed. */
export const DEFAULT_AUTH_WINDOW_MS = 300_000; // 5 minutes

/** The parsed fields of an AVCS-Sig Authorization header. */
export interface AuthCredential {
  keyId: string;
  ts: string;
  nonce: string;
  sig: string;
}

/**
 * The exact byte string both sides sign/verify. Binds the signature to the method, the
 * request target, a timestamp (freshness) and a nonce (replay), plus a hash of the body
 * so a captured signature cannot be replayed against different content.
 */
export function canonicalRequest(method: string, path: string, ts: string, nonce: string, body: string): string {
  return `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${sha256hex(body)}`;
}

/** Build an `Authorization: AVCS-Sig …` header value, signing the request with the local
 *  actor's private key. `body` is the exact request body the client will send (""for none). */
export function buildAuthHeader(args: {
  keyId: string;
  privateKey: string;
  method: string;
  path: string;
  body?: string;
  ts?: string;
  nonce?: string;
}): string {
  const ts = args.ts ?? new Date().toISOString();
  const nonce = args.nonce ?? randomBytes(12).toString("base64url");
  const sig = signMessage(args.privateKey, canonicalRequest(args.method, args.path, ts, nonce, args.body ?? ""));
  return `${AUTH_SCHEME} keyId="${args.keyId}", ts="${ts}", nonce="${nonce}", sig="${sig}"`;
}

/** Parse an AVCS-Sig Authorization header. Returns null on any scheme/field mismatch. */
export function parseAuthHeader(header: string | undefined | null): AuthCredential | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.startsWith(`${AUTH_SCHEME} `)) return null;
  const rest = trimmed.slice(AUTH_SCHEME.length + 1);
  const fields: Record<string, string> = {};
  // key="value" pairs, comma-separated. Values may contain base64url (no quotes/commas).
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) fields[m[1]!] = m[2]!;
  const { keyId, ts, nonce, sig } = fields;
  if (!keyId || !ts || !nonce || !sig) return null;
  return { keyId, ts, nonce, sig };
}

/**
 * A bounded seen-nonce cache for replay protection. Entries expire after `ttlMs` (the
 * freshness window — a nonce can only be replayed within it anyway) and the map is
 * capped so a hostile client cannot grow it without bound.
 */
export class NonceCache {
  #seen = new Map<string, number>(); // nonce → expiry epoch ms
  #ttlMs: number;
  #max: number;

  constructor(ttlMs: number = DEFAULT_AUTH_WINDOW_MS, max = 100_000) {
    this.#ttlMs = ttlMs;
    this.#max = max;
  }

  /** Record a nonce; returns false if it was already seen (a replay). */
  check(nonce: string, now: number): boolean {
    this.#evict(now);
    if (this.#seen.has(nonce)) return false;
    if (this.#seen.size >= this.#max) {
      // Hard cap reached even after eviction: drop the oldest insertion to stay bounded.
      const oldest = this.#seen.keys().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    this.#seen.set(nonce, now + this.#ttlMs);
    return true;
  }

  #evict(now: number): void {
    for (const [n, exp] of this.#seen) {
      if (exp <= now) this.#seen.delete(n);
      else break; // Map preserves insertion order; later entries expire no earlier... see note
    }
  }
}

/** Resolve a keyId to its registered public key (PEM), or null if unknown. This is the
 *  pluggable hook (D3): the default server resolver reads `member:<keyId>`; an embedder
 *  (e.g. a hosted hub) injects its own user-DB lookup. */
export type PublicKeyResolver = (keyId: string) => Promise<string | null>;

export type AuthResult = { ok: true; keyId: string } | { ok: false; reason: string };

/**
 * Verify a request's AVCS-Sig credential. Steps, in order:
 *  1. parse the header,
 *  2. reject a stale/future timestamp (outside the freshness window),
 *  3. reject a replayed nonce,
 *  4. resolve the keyId to a public key (unknown key → unauthenticated),
 *  5. verify the signature over the canonical request.
 * Any failure returns `{ ok: false, reason }` for a 401 body. Success returns the keyId.
 */
export async function verifyAuth(args: {
  header: string | undefined | null;
  method: string;
  path: string;
  body: string;
  resolvePublicKey: PublicKeyResolver;
  now: number;
  windowMs?: number;
  nonceCache?: NonceCache;
}): Promise<AuthResult> {
  const cred = parseAuthHeader(args.header);
  if (!cred) return { ok: false, reason: "missing or malformed AVCS-Sig Authorization header" };

  const window = args.windowMs ?? DEFAULT_AUTH_WINDOW_MS;
  const tsMs = Date.parse(cred.ts);
  if (!Number.isFinite(tsMs)) return { ok: false, reason: "invalid timestamp" };
  if (Math.abs(args.now - tsMs) > window) return { ok: false, reason: "request timestamp outside freshness window" };

  if (args.nonceCache && !args.nonceCache.check(cred.nonce, args.now)) {
    return { ok: false, reason: "nonce already used (replay)" };
  }

  const publicKey = await args.resolvePublicKey(cred.keyId);
  if (!publicKey) return { ok: false, reason: `unknown signing key ${cred.keyId}` };

  const msg = canonicalRequest(args.method, args.path, cred.ts, cred.nonce, args.body);
  if (!verifyMessage(publicKey, msg, cred.sig)) return { ok: false, reason: "request signature does not verify" };

  return { ok: true, keyId: cred.keyId };
}
