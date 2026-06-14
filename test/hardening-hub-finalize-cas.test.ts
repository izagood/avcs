// Track E / E6 — server-side finalize compare-and-swap. The hub exposed no finalize
// endpoint and setRef had no CAS, so a remote client couldn't merge and two finalizes
// could clobber. POST /finalize runs the authoritative repo.finalize (CAS on parentHead
// under a cross-process lock + role/checks/approvals/causal gates). On a gated hub the
// request is signed so the finalizer is authenticated.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { finalizeOnHub } from "../src/hub/hubClient.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor } from "../src/objects/types.ts";

test("E6: hub /finalize enforces signature, role, and the parentHead CAS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-e6-"));
  const central = await Repo.init(dir);
  const root = generateKeypair();
  const lead = generateKeypair();
  const bob = generateKeypair();
  await central.registerMembership({ actorId: "human:lead", publicKey: lead.publicKey, role: "maintainer", actorKind: "human", root: { keyId: "root", privateKey: root.privateKey } });
  await central.registerMembership({ actorId: "ai:bob", publicKey: bob.publicKey, role: "proposer", actorKind: "ai_agent", root: { keyId: "root", privateKey: root.privateKey } });
  await central.setProtection({ view: "main", requiredApprovals: 0, requireOwnerApproval: false, requiredChecks: [], finalizeRole: "maintainer", requireSignedOps: false, requireUpToDate: true, allowForcePush: false });

  const lead2: Actor = { kind: "human", id: "human:lead" };
  const intent = await central.createIntent({ title: "t", owner: "human:lead" });
  const sess = await central.startSession({ intentOid: intent, actor: lead2 });
  await central.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: lead2, path: "a.ts", content: "1\n", declaredPurpose: "a", signWith: { keyId: "human:lead", privateKey: lead.privateKey } });
  const cp = await central.createCheckpoint("main", "cp1");

  const hub = await startHub({ repoDir: dir, port: 0, gated: true });
  try {
    // (1) unsigned finalize on a gated hub → rejected (not authenticated).
    let r = await finalizeOnHub(hub.url, { view: "main", newCheckpoint: cp, parentHead: null, by: "human:lead" });
    assert.equal(r.status, 403, "unsigned finalize rejected");

    // (2) a proposer (authenticated, but lacks the finalize role) → 422.
    r = await finalizeOnHub(hub.url, { view: "main", newCheckpoint: cp, parentHead: null, by: "ai:bob", signWith: { keyId: "ai:bob", privateKey: bob.privateKey } });
    assert.equal(r.status, 422, "under-privileged finalizer rejected");
    assert.match(String(r.reason), /lacks role/);

    // (3) the maintainer finalizes with the correct parentHead (null) → accepted.
    r = await finalizeOnHub(hub.url, { view: "main", newCheckpoint: cp, parentHead: null, by: "human:lead", signWith: { keyId: "human:lead", privateKey: lead.privateKey } });
    assert.equal(r.status, 200, "maintainer finalize accepted");
    assert.equal(r.finalized, true);
    assert.equal(r.head, cp);

    // (4) a stale finalize (parentHead still null, but head is now cp) → 409 CAS conflict.
    r = await finalizeOnHub(hub.url, { view: "main", newCheckpoint: cp, parentHead: null, by: "human:lead", signWith: { keyId: "human:lead", privateKey: lead.privateKey } });
    assert.equal(r.status, 409, "stale finalize loses the CAS");
    assert.match(String(r.reason), /head moved/);

    // (5) the head ref reflects the finalize and is distributed via /refs.
    const refs = (await (await fetch(`${hub.url}/refs`)).json()).refs as Record<string, string>;
    assert.equal(refs["head:main"], cp, "protected head distributed");
  } finally {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
