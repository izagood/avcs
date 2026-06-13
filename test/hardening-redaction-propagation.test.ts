// Security hardening: a redaction propagates over the hub so replicas that already
// pulled the plaintext also evict the bytes (oid preserved → references stay valid).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

test("redaction propagates: a peer who pulled the secret evicts it after the redaction syncs", async () => {
  const centralDir = await mkdtemp(join(tmpdir(), "avcs-c-"));
  const central = await Repo.init(centralDir);
  const root = generateKeypair();
  const admin = generateKeypair();
  await central.registerMembership({ actorId: "human:admin", publicKey: admin.publicKey, role: "admin", root: { keyId: "root", privateKey: root.privateKey } });
  await central.registerMembership({ actorId: "ai:a", publicKey: generateKeypair().publicKey, role: "proposer", root: { keyId: "root", privateKey: root.privateKey } }); // author must be a member, else quarantined
  const hub = await startHub({ repoDir: centralDir, port: 0 });
  const peerDir = await mkdtemp(join(tmpdir(), "avcs-p-"));
  try {
    // author a secret file in a dev repo and push to the hub
    const dev = await Repo.init(await mkdtemp(join(tmpdir(), "avcs-d-")));
    const intent = await dev.createIntent({ title: "t", owner: "human:admin" });
    const sess = await dev.startSession({ intentOid: intent, actor: ai });
    await dev.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "secret.env", content: "AWS_KEY=AKIA_leaked\n", declaredPurpose: "oops" });
    await dev.pushHub(hub.url);

    // peer pulls → has the plaintext
    const peer = await Repo.init(peerDir);
    await peer.pullHub(hub.url);
    const blobOid = (await peer.materialize()).tree.get("secret.env")!;
    assert.match((await peer.readBlob(blobOid)).toString("utf8"), /AKIA_leaked/, "peer has plaintext");

    // admin redacts on the central/authoritative repo, pushes the redaction
    const central2 = await Repo.open(centralDir);
    await central2.redact(blobOid, "leaked AWS key", "human:admin", { keyId: "human:admin", privateKey: admin.privateKey });
    await central2.pushHub(hub.url); // redaction object → hub evicts its own blob too

    // hub no longer serves the plaintext
    const fresh = await Repo.init(await mkdtemp(join(tmpdir(), "avcs-f-")));
    await fresh.pullHub(hub.url);
    assert.doesNotMatch((await fresh.readBlob(blobOid)).toString("utf8"), /AKIA_leaked/, "fresh clone never sees plaintext");

    // the PEER (already had plaintext) evicts it on its next pull
    await peer.pullHub(hub.url);
    assert.doesNotMatch((await peer.readBlob(blobOid)).toString("utf8"), /AKIA_leaked/, "peer evicted the plaintext");
    assert.match((await peer.readBlob(blobOid)).toString("utf8"), /REDACTED/);
    // oid + treeHash references preserved
    assert.equal((await peer.materialize()).tree.get("secret.env"), blobOid);
  } finally {
    await hub.close();
    await rm(centralDir, { recursive: true, force: true });
    await rm(peerDir, { recursive: true, force: true });
  }
});

test("a forged (unsigned/non-admin) redaction is NOT applied under governance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const root = generateKeypair();
  const admin = generateKeypair();
  await repo.registerMembership({ actorId: "human:admin", publicKey: admin.publicKey, role: "admin", root: { keyId: "root", privateKey: root.privateKey } });
  await repo.registerMembership({ actorId: "ai:a", publicKey: generateKeypair().publicKey, role: "proposer", root: { keyId: "root", privateKey: root.privateKey } });
  const intent = await repo.createIntent({ title: "t", owner: "human:admin" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "x.ts", content: "important = 1\n", declaredPurpose: "x" });
  const blobOid = (await repo.materialize()).tree.get("x.ts")!;

  // An attacker crafts a redaction (claims admin, but has no valid signature).
  await repo.store.put({ type: "redaction", blobOid, sha256: "x", length: 0, reason: "DoS", by: "human:admin", createdAt: "2026-01-01T00:00:00Z" } as never);
  const applied = await repo.applyRedactions();
  assert.equal(applied, 0, "forged redaction skipped");
  assert.match((await repo.readBlob(blobOid)).toString("utf8"), /important/, "blob NOT evicted by a forged redaction");
  await rm(dir, { recursive: true, force: true });
});
