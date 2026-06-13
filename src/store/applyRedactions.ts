// Redaction propagation (docs/08/12 WS-E): apply every Redaction tombstone present in
// a store to its blob, evicting the bytes locally while preserving the oid. A replica
// that pulled the plaintext before the redaction calls this on pull; the hub calls it
// when it receives a redaction. The stub is deterministic (reason-derived) so all
// replicas converge to the same content.
import { Buffer } from "node:buffer";
import { verifyMessage } from "../core/identity.ts";
import type { ObjectStore } from "./objectStore.ts";
import type { Blob, Membership, Redaction } from "../objects/types.ts";

export function redactedStub(reason: string, redactionOid: string): Blob {
  return {
    type: "blob",
    data: Buffer.from(`[REDACTED: ${reason}]`).toString("base64"),
    encoding: "base64",
    redacted: true,
    redactionOid,
  };
}

/**
 * Materialize every Redaction's stub AT its blob oid. A redacted blob's content no
 * longer hashes to its oid, so it can't propagate through content-addressed `put`
 * (which would re-address it). Instead the receiver syncs the (tiny) Redaction object
 * and writes the deterministic stub in place — evicting plaintext it already had, or
 * creating the stub on a fresh clone that never received the original. Idempotent.
 *
 * When governance is active (memberships exist), only redactions validly signed by an
 * admin member are applied — a forged redaction can't be used to evict (DoS) someone
 * else's blob. With no governance, all redactions apply (legacy/trust-all).
 */
export async function applyRedactions(store: ObjectStore): Promise<number> {
  const admins = new Map<string, Membership>();
  for await (const m of store.list<Membership>("membership")) {
    if (!m.revokedAt && m.role === "admin") admins.set(m.actorId, m);
  }
  const governed = admins.size > 0 || (await first(store.list<Membership>("membership"))) !== null;
  const verified = (red: Redaction): boolean => {
    if (!governed) return true; // no governance → trust all
    const m = admins.get(red.by);
    if (!m || !red.sig) return false;
    return verifyMessage(m.publicKey, red.oid as string, red.sig.sig);
  };

  let applied = 0;
  for await (const red of store.list<Redaction>("redaction")) {
    if (!verified(red)) continue; // skip forged / non-admin redactions
    const cur = (await store.has(red.blobOid)) ? await store.get<Blob>(red.blobOid) : null;
    if (cur?.redacted && cur.redactionOid === red.oid) continue; // already applied
    await store.overwriteAt(red.blobOid, redactedStub(red.reason, red.oid as string));
    applied++;
  }
  return applied;
}

async function first<T>(gen: AsyncGenerator<T>): Promise<T | null> {
  for await (const x of gen) return x;
  return null;
}
