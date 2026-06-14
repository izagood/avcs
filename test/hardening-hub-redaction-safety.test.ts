// Track E / E3 — redaction is the one operation that irrecoverably overwrites bytes,
// so an UNAUTHENTICATED redaction is a data-destruction DoS. The old hub trusted all
// redactions on an open (ungated) hub and ran applyRedactions inline, unlocked. E3:
// a redaction is admin-authorized ALWAYS (even ungated), and the eviction runs under a
// cross-process lock. These tests run against an UNGATED hub to prove the DoS is closed
// regardless of the gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { generateKeypair, signMessage } from "../src/core/identity.ts";
import { computeOid, sha256hex } from "../src/core/canonical.ts";

async function post(url: string, obj: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${url}/objects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function getObj(url: string, oid: string): Promise<any> {
  const r = await fetch(`${url}/objects/${encodeURIComponent(oid)}`);
  return r.json();
}

function redaction(blobOid: string, plaintext: string, by: string, priv: string | null): Record<string, unknown> {
  const red: Record<string, unknown> = {
    type: "redaction", blobOid, sha256: sha256hex(plaintext), length: plaintext.length,
    reason: "leaked secret", by, createdAt: "2026-01-01T00:00:00.000Z",
  };
  if (priv) {
    const oid = computeOid("redaction", red);
    red.sig = { keyId: by, alg: "ed25519", sig: signMessage(priv, oid) };
  }
  return red;
}

test("E3: an ungated hub rejects unauthenticated / non-admin redactions but applies admin-signed ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-e3-"));
  const central = await Repo.init(dir);
  const root = generateKeypair();
  const admin = generateKeypair();
  const bob = generateKeypair();
  await central.registerMembership({ actorId: "human:admin", publicKey: admin.publicKey, role: "admin", actorKind: "human", root: { keyId: "root", privateKey: root.privateKey } });
  await central.registerMembership({ actorId: "ai:bob", publicKey: bob.publicKey, role: "proposer", actorKind: "ai_agent", root: { keyId: "root", privateKey: root.privateKey } });

  const hub = await startHub({ repoDir: dir, port: 0, gated: false }); // OPEN hub
  try {
    // store a secret blob.
    const secret = "API_KEY=supersecret";
    const blob = { type: "blob", data: Buffer.from(secret).toString("base64"), encoding: "base64" };
    const { body: blobRes } = await post(hub.url, blob);
    const blobOid = blobRes.oid as string;
    assert.ok(blobOid, "blob stored");

    // (1) anonymous (unsigned) redaction → rejected; blob intact (the DoS, now closed).
    let r = await post(hub.url, redaction(blobOid, secret, "human:mallory", null));
    assert.equal(r.status, 403, "unsigned redaction rejected on an open hub");
    assert.equal((await getObj(hub.url, blobOid)).redacted ?? false, false, "blob NOT evicted");

    // (2) non-admin (proposer) signed redaction → rejected.
    r = await post(hub.url, redaction(blobOid, secret, "ai:bob", bob.privateKey));
    assert.equal(r.status, 403, "non-admin redaction rejected");
    assert.match(String(r.body.error), /below required admin/);
    assert.equal((await getObj(hub.url, blobOid)).redacted ?? false, false, "blob still intact");

    // (3) admin-signed redaction → accepted, blob bytes evicted.
    r = await post(hub.url, redaction(blobOid, secret, "human:admin", admin.privateKey));
    assert.equal(r.status, 200, "admin redaction accepted");
    const evicted = await getObj(hub.url, blobOid);
    assert.equal(evicted.redacted, true, "blob evicted");
    assert.doesNotMatch(Buffer.from(evicted.data, "base64").toString(), /supersecret/, "plaintext gone");
  } finally {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
