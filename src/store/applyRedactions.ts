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
 * The same eviction for a LOCAL `undo --purge` (issue #91), with a different provenance
 * pointer. `redacted` is the flag that marks the sanctioned oid≠content mismatch which the
 * store and `fsck` already understand, so an undo-purged blob is not reported as bit-rot;
 * `undoOid` names the {@link Undo} that ordered it. No Redaction exists for such a blob, so
 * `applyRedactions` below never touches it — an undo is never propagated, by construction.
 */
export function purgedStub(reason: string, undoOid: string): Blob {
  return {
    type: "blob",
    data: Buffer.from(`[PURGED: ${reason}]`).toString("base64"),
    encoding: "base64",
    redacted: true,
    undoOid,
  };
}

/** Whether `blob` is a LOCAL `undo --purge` tombstone — the one stub that must never reach a
 *  file, as opposed to {@link redactedStub}, which a replica is supposed to project. `undoOid`
 *  is the discriminator; `redacted` is NOT, because both stubs set it (issue #97). */
export function purgeTombstoneOf(blob: Blob | null | undefined): string | null {
  return blob?.undoOid ?? null;
}

/**
 * A {@link purgedStub} was about to be treated as file CONTENT (issue #97).
 *
 * Blobs are content-addressed, so re-adding the file `undo --purge` deliberately left on disk
 * resolves to the very oid that now holds the tombstone. The eviction still holds — the secret
 * bytes do not come back, and content-addressing is what guarantees that — but the derivation
 * is broken: a source file would be silently replaced by a sentinel string. Producing a tree
 * that looks fine is worse than stopping, so `commit` and the materialize-to-bytes boundary
 * raise this instead of succeeding.
 *
 * Typed, and carrying `path`/`oid`/`undoOid`, for the same reason `CorruptObjectError` carries
 * `oid` (F1, docs/13): a failure deep inside `materialize` has to be actionable, which means
 * naming the file to fix and the record that ordered the purge — never an opaque throw.
 */
export class PurgedBlobError extends Error {
  readonly path: string;
  readonly oid: string;
  readonly undoOid: string;
  constructor(message: string, where: { path: string; oid: string; undoOid: string }) {
    super(message);
    this.name = "PurgedBlobError";
    this.path = where.path;
    this.oid = where.oid;
    this.undoOid = where.undoOid;
  }
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
