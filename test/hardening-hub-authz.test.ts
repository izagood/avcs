// Track E / E2 — a gated hub must authorize EVERY mutating governance object, not just
// operations. The original hub waved through decision/membership/redaction as
// "harmless", but a pushed `decision` changes verdictMap (conflict resolution) on every
// replica — an unauthenticated takeover of merge outcomes. E2 gates each type by
// signature + membership role; central-authoritative governance (membership/protection/
// policy) is reject-on-push (it's pulled via /refs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { generateKeypair, signMessage } from "../src/core/identity.ts";
import { computeOid } from "../src/core/canonical.ts";

async function post(url: string, obj: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${url}/objects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** Build a signed decision object as a client would. */
function signedDecision(id: string, priv: string | null, chosen = "operation_deadbeef"): Record<string, unknown> {
  const dec: Record<string, unknown> = {
    type: "decision",
    decidedBy: { kind: "human", id },
    chosenOps: [chosen],
    rejectedOps: [],
    reason: "I decree this op wins",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  if (priv) {
    const oid = computeOid("decision", dec);
    dec.sig = { keyId: id, alg: "ed25519", sig: signMessage(priv, oid) };
  }
  return dec;
}

test("E2: gated hub authorizes governance objects by signature + role", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-e2-"));
  const central = await Repo.init(dir);
  const root = generateKeypair();
  const rev = generateKeypair();
  const bob = generateKeypair();
  await central.registerMembership({ actorId: "human:rev", publicKey: rev.publicKey, role: "reviewer", actorKind: "human", root: { keyId: "root", privateKey: root.privateKey } });
  await central.registerMembership({ actorId: "ai:bob", publicKey: bob.publicKey, role: "proposer", actorKind: "ai_agent", root: { keyId: "root", privateKey: root.privateKey } });

  const hub = await startHub({ repoDir: dir, port: 0, gated: true });
  try {
    // (1) the headline: an UNSIGNED decision (the injection attack) is rejected.
    let r = await post(hub.url, signedDecision("human:mallory", null));
    assert.equal(r.status, 403, "unsigned decision rejected");

    // (2) a decision signed by a NON-member outsider is rejected.
    const outsider = generateKeypair();
    r = await post(hub.url, signedDecision("human:mallory", outsider.privateKey));
    assert.equal(r.status, 403, "non-member decision rejected");
    assert.match(String(r.body.error), /not a member/);

    // (3) a decision signed by a proposer (role too low to decide) is rejected.
    r = await post(hub.url, signedDecision("ai:bob", bob.privateKey));
    assert.equal(r.status, 403, "under-privileged decider rejected");
    assert.match(String(r.body.error), /below required reviewer/);

    // (4) a decision signed by a reviewer is ACCEPTED.
    r = await post(hub.url, signedDecision("human:rev", rev.privateKey));
    assert.equal(r.status, 200, "reviewer-signed decision accepted");

    // (5) a membership push is rejected outright (central-authoritative, pulled via /refs).
    const fakeMembership = { type: "membership", actorId: "human:mallory", publicKey: outsider.publicKey, role: "admin", issuedBy: "root", createdAt: "2026-01-01T00:00:00.000Z" };
    r = await post(hub.url, fakeMembership);
    assert.equal(r.status, 403, "membership push rejected");
    assert.match(String(r.body.error), /central-authoritative/);
  } finally {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("E2: an open (ungated) hub still accepts unsigned objects (gate is opt-in)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-e2b-"));
  await Repo.init(dir);
  const hub = await startHub({ repoDir: dir, port: 0, gated: false });
  try {
    const r = await post(hub.url, signedDecision("human:anyone", null));
    assert.equal(r.status, 200, "ungated hub is trust-all by design (dev mode)");
  } finally {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
