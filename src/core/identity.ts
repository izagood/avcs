// Phase 3: cryptographic identity.
//
// Until now "this evidence came from ci_bot" and "a human made this decision" were
// self-reported strings an agent could forge. Identity makes them checkable: an
// actor holds an ed25519 keypair, signs the content-address (oid) of objects it
// produces, and the reducer's trust gate only honors evidence/decisions whose
// signature verifies against a registered public key for the claimed actor.
//
// ed25519 via node:crypto — no external dependency.

import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { Buffer } from "node:buffer";

export interface Signature {
  keyId: string; // which key signed (usually the actor id)
  alg: "ed25519";
  /** base64 signature over the signed message (the object oid). */
  sig: string;
}

export interface Keypair {
  publicKey: string; // PEM (SPKI)
  privateKey: string; // PEM (PKCS8)
}

export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey: publicKey as string, privateKey: privateKey as string };
}

export function signMessage(privateKeyPem: string, message: string): string {
  // ed25519 is a one-shot signature: algorithm arg is null.
  return nodeSign(null, Buffer.from(message, "utf8"), privateKeyPem).toString("base64");
}

export function verifyMessage(publicKeyPem: string, message: string, sigB64: string): boolean {
  try {
    return nodeVerify(null, Buffer.from(message, "utf8"), publicKeyPem, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

export interface KeyRecord {
  keyId: string;
  publicKey: string;
  actorId: string;
  actorKind: "human" | "ai_agent" | "ci_bot";
}

/** A registry of trusted public keys, keyed by keyId. */
export class Keyring {
  #keys = new Map<string, KeyRecord>();

  register(rec: KeyRecord): void {
    this.#keys.set(rec.keyId, rec);
  }
  get(keyId: string): KeyRecord | undefined {
    return this.#keys.get(keyId);
  }
  has(keyId: string): boolean {
    return this.#keys.has(keyId);
  }
  get size(): number {
    return this.#keys.size;
  }

  /**
   * Verify a signature over `oid`, claimed to come from `claimedActorId`.
   * Returns true only if the signing key is registered AND its registered actor
   * matches the claim — i.e. you cannot sign as ci_bot with ai_agent's key.
   */
  verifyFor(claimedActorId: string, oid: string, sig: Signature | undefined): boolean {
    if (!sig) return false;
    const rec = this.#keys.get(sig.keyId);
    if (!rec) return false;
    if (rec.actorId !== claimedActorId) return false;
    return verifyMessage(rec.publicKey, oid, sig.sig);
  }
}
