// Redaction propagation (docs/08/12 WS-E): apply every Redaction tombstone present in
// a store to its blob, evicting the bytes locally while preserving the oid. A replica
// that pulled the plaintext before the redaction calls this on pull; the hub calls it
// when it receives a redaction. The stub is deterministic (reason-derived) so all
// replicas converge to the same content.
import { Buffer } from "node:buffer";
import type { ObjectStore } from "./objectStore.ts";
import type { Blob, Redaction } from "../objects/types.ts";

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
 */
export async function applyRedactions(store: ObjectStore): Promise<number> {
  let applied = 0;
  for await (const red of store.list<Redaction>("redaction")) {
    const cur = (await store.has(red.blobOid)) ? await store.get<Blob>(red.blobOid) : null;
    if (cur?.redacted && cur.redactionOid === red.oid) continue; // already applied
    await store.overwriteAt(red.blobOid, redactedStub(red.reason, red.oid as string));
    applied++;
  }
  return applied;
}
