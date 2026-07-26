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
  /** The repository the client believes it is addressing (issue #49). Absent on an
   *  unscoped credential — which is every credential written before this existed. */
  scope?: string;
  /** Signature over the scope-bearing material. Present iff `scope` is. Separate from
   *  `sig` so a scope-unaware verifier can still check `sig` and accept the request. */
  bsig?: string;
}

/**
 * The exact byte string both sides sign/verify. Binds the signature to the method, the
 * request target, a timestamp (freshness) and a nonce (replay), plus a hash of the body
 * so a captured signature cannot be replayed against different content.
 *
 * `scope` (issue #49) additionally binds it to a REPOSITORY. The path a client signs is
 * the endpoint suffix ("/objects"), because the reference hub sits at the root — so
 * without a scope nothing in the signed material says which repository the write was for,
 * and on a multi-tenant hub a credential captured for one repo is structurally valid for
 * another. Signing the full path instead would couple the signature to the server's mount
 * layout and break under ordinary path-rewriting proxies.
 *
 * Appended rather than inserted, and empty when absent, so an unscoped credential produces
 * byte-identical material to what this function produced before scope existed.
 */
export function canonicalRequest(method: string, path: string, ts: string, nonce: string, body: string, scope = ""): string {
  const core = `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${sha256hex(body)}`;
  return scope ? `${core}\n${scope}` : core;
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
  /** Repository this credential is for (issue #49). Omit, or pass "", to sign unscoped. */
  scope?: string;
}): string {
  const ts = args.ts ?? new Date().toISOString();
  const nonce = args.nonce ?? randomBytes(12).toString("base64url");
  const scope = args.scope ?? "";
  const body = args.body ?? "";
  // TWO signatures, deliberately. `sig` covers the original material so a hub running an
  // older avcs — which reconstructs canonicalRequest without any scope — still verifies it
  // and keeps working. `bsig` additionally covers the scope, and is what a hub that
  // REQUIRES binding checks. One signature cannot do both jobs: folding scope into `sig`
  // makes every deployed verifier reject every request, which is exactly what happened the
  // first time this was attempted against a live hub.
  const sig = signMessage(args.privateKey, canonicalRequest(args.method, args.path, ts, nonce, body));
  const head = `${AUTH_SCHEME} keyId="${args.keyId}", ts="${ts}", nonce="${nonce}"`;
  if (!scope) return `${head}, sig="${sig}"`;
  const bsig = signMessage(args.privateKey, canonicalRequest(args.method, args.path, ts, nonce, body, scope));
  return `${head}, scope="${scope}", sig="${sig}", bsig="${bsig}"`;
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
  const { keyId, ts, nonce, sig, scope, bsig } = fields;
  if (!keyId || !ts || !nonce || !sig) return null;
  // An empty scope is reported as absent: a rootless remote derives "" and must not turn
  // that into an expectation nobody can satisfy.
  return scope && bsig ? { keyId, ts, nonce, sig, scope, bsig } : { keyId, ts, nonce, sig };
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
  /**
   * The repository this request is actually for (issue #49). When set, the credential must
   * name the same one — so a signature captured for another repo on a multi-tenant hub is
   * refused even though key, method, path, body and freshness all still check out.
   *
   * Leave unset on a single-repo hub: there is nothing to compare against, and every
   * existing credential keeps verifying exactly as before.
   */
  expectedScope?: string;
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

  if (args.expectedScope) {
    if (!cred.scope) {
      return { ok: false, reason: `credential carries no scope; this hub requires scope "${args.expectedScope}"` };
    }
    if (cred.scope !== args.expectedScope) {
      return { ok: false, reason: `credential scope "${cred.scope}" does not match "${args.expectedScope}"` };
    }
  }

  const publicKey = await args.resolvePublicKey(cred.keyId);
  if (!publicKey) return { ok: false, reason: `unknown signing key ${cred.keyId}` };

  const msg = canonicalRequest(args.method, args.path, cred.ts, cred.nonce, args.body);
  if (!verifyMessage(publicKey, msg, cred.sig)) return { ok: false, reason: "request signature does not verify" };

  // When binding is required, the scope must ALSO be signed — otherwise it is decoration a
  // replayer could rewrite. Checked after `sig` so a tampered scope fails as a signature
  // problem rather than a mismatch, and only when this hub asked for binding.
  if (args.expectedScope) {
    const bound = canonicalRequest(args.method, args.path, cred.ts, cred.nonce, args.body, cred.scope!);
    if (!cred.bsig || !verifyMessage(publicKey, bound, cred.bsig)) {
      return { ok: false, reason: "scope binding does not verify" };
    }
  }

  return { ok: true, keyId: cred.keyId };
}
