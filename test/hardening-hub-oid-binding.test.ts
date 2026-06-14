// Track E / E1 — the gated hub must verify a pushed operation's signature over the
// RECOMPUTED content oid, not the client-claimed op.oid. Otherwise an op whose body
// was tampered after signing (sig over old oid X, body now hashes to Y) would be
// ACCEPTED by the hub (sig checks out against X) yet REJECTED by a pulling replica
// (which recomputes Y and verifies the sig over Y) — silent hub/replica divergence.
// After E1: hub-accept ⟹ replica-accept.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { generateKeypair } from "../src/core/identity.ts";
import { computeOid } from "../src/core/canonical.ts";
import type { Actor, Operation } from "../src/objects/types.ts";

const alice: Actor = { kind: "ai_agent", id: "ai:alice" };

async function post(url: string, obj: unknown): Promise<number> {
  const r = await fetch(`${url}/objects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
  await r.text();
  return r.status;
}

test("E1: gated hub accepts an honestly-signed op and rejects one tampered after signing", async () => {
  const centralDir = await mkdtemp(join(tmpdir(), "avcs-e1-central-"));
  const userDir = await mkdtemp(join(tmpdir(), "avcs-e1-user-"));
  const central = await Repo.init(centralDir);
  const root = generateKeypair();
  const k = generateKeypair();
  await central.registerMembership({ actorId: alice.id, publicKey: k.publicKey, role: "maintainer", actorKind: "ai_agent", root: { keyId: "root", privateKey: root.privateKey } });

  const hub = await startHub({ repoDir: centralDir, port: 0, gated: true });
  try {
    // Author a real signed op on a user repo.
    const user = await Repo.init(userDir);
    const intent = await user.createIntent({ title: "t", owner: "human:h" });
    const sess = await user.startSession({ intentOid: intent, actor: alice });
    const opOid = await user.proposeFileWrite({
      sessionOid: sess, intentOid: intent, actor: alice, path: "a.ts", content: "export const x = 1\n",
      declaredPurpose: "add x", signWith: { keyId: alice.id, privateKey: k.privateKey },
    });
    const op = await user.store.get<Operation>(opOid);
    assert.ok(op.sig, "op is signed");

    // (1) honest op → accepted.
    assert.equal(await post(hub.url, op), 200, "honestly-signed op accepted");

    // (2) tamper the body AFTER signing (sig still over the original oid). The op.oid
    // field is left as-is (a naive forger), so the OLD code (verify over op.oid) would
    // have passed it — the divergence bug. E1 recomputes the oid and must reject.
    const tampered = { ...op, declaredPurpose: "TAMPERED — not what was signed" };
    assert.notEqual(computeOid(tampered.type, tampered as unknown as Record<string, unknown>), op.oid, "tamper changed the content oid");
    assert.equal(await post(hub.url, tampered), 403, "tampered op rejected (sig not valid over recomputed oid)");

    // (3) hub-accept ⟹ replica-accept: the honest op verifies on a replica over its
    // stored (recomputed) content oid using the same registered key.
    const storedOid = computeOid(op.type, op as unknown as Record<string, unknown>);
    assert.equal(central.keyring.verifyFor(alice.id, storedOid, op.sig), true, "accepted op verifies on a replica over its content oid");
  } finally {
    await hub.close();
    await rm(centralDir, { recursive: true, force: true });
    await rm(userDir, { recursive: true, force: true });
  }
});
