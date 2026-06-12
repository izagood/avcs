// INTEGRATION: multiple users with different permissions, each working from their own
// machine with several agents, syncing through a REAL local AVCS hub (HTTP server).
// Exercises the full stack end-to-end per case. Runs on every `npm test`.
//
//   central repo  = the hub's authoritative store (governance: members, protection)
//   hub           = startHub over central (HTTP) — clients push/pull objects, pull governance
//   user repos     = independent clones; each runs multiple agent sessions
//
// Governance (membership/policy/protection/head) is hub-authoritative and distributed
// to clients on pull; content (ops/evidence/decisions/blobs) is conflict-free gossip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub, type HubHandle } from "../src/hub/hubServer.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor, RoleName } from "../src/objects/types.ts";

const BASE = `export function alpha() {\n  return "a0";\n}\n\nexport function beta() {\n  return "b0";\n}\n`;
const sym = (n: string, v: string) => `export function ${n}() {\n  return "${v}";\n}`;
const actor = (id: string): Actor => ({ kind: "ai_agent", id });

interface Org {
  centralDir: string;
  central: Repo;
  hub: HubHandle;
  keys: Map<string, { keyId: string; privateKey: string }>;
  baseOp: string;
  dirs: string[];
  close(): Promise<void>;
}

/** Stand up an org: central repo + governance + a scaffolded base file + a running hub. */
async function makeOrg(opts: { gated?: boolean } = {}): Promise<Org> {
  const centralDir = await mkdtemp(join(tmpdir(), "avcs-central-"));
  const central = await Repo.init(centralDir);
  const root = generateKeypair();
  const keys = new Map<string, { keyId: string; privateKey: string }>();
  const member = async (id: string, role: RoleName) => {
    const k = generateKeypair();
    await central.registerMembership({ actorId: id, publicKey: k.publicKey, role, root: { keyId: "root", privateKey: root.privateKey } });
    keys.set(id, { keyId: id, privateKey: k.privateKey });
  };
  // Different users, different permissions.
  await member("ai:alice", "maintainer");
  await member("ai:bob", "proposer");
  await member("human:rev", "reviewer");
  await member("human:admin", "admin");
  await central.setProtection({ view: "main", requiredApprovals: 0, requireOwnerApproval: false, requiredChecks: [], finalizeRole: "maintainer", requireSignedOps: true, requireUpToDate: true, allowForcePush: false });

  // Shared base file, authored (signed) by alice on the authoritative repo.
  const intent = await central.createIntent({ title: "greeting module", owner: "human:admin" });
  const sess = await central.startSession({ intentOid: intent, actor: actor("ai:alice") });
  const baseOp = await central.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: actor("ai:alice"), path: "mod.ts", content: BASE,
    declaredPurpose: "scaffold", signWith: keys.get("ai:alice"),
  });

  const hub = await startHub({ repoDir: centralDir, port: 0, gated: opts.gated ?? false });
  const dirs: string[] = [centralDir];
  return {
    centralDir, central, hub, keys, baseOp, dirs,
    async close() {
      await hub.close();
      await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    },
  };
}

/** A user's machine: fresh repo cloned from the hub (objects + governance). */
async function joinUser(org: Org): Promise<{ dir: string; repo: Repo }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-user-"));
  org.dirs.push(dir);
  const repo = await Repo.init(dir);
  await repo.pullHub(org.hub.url);
  return { dir, repo };
}

async function symVal(repo: Repo, name: string): Promise<string | undefined> {
  const c = (await repo.materializedFiles(await repo.materialize())).find((f) => f.path === "mod.ts")?.content ?? "";
  return c.match(new RegExp(`function ${name}\\(\\) \\{\\s*return "(.*?)"`))?.[1];
}

test("INTEGRATION C1: disjoint multi-agent work converges over the hub (no conflict)", async () => {
  const org = await makeOrg();
  try {
    const alice = await joinUser(org);
    const bob = await joinUser(org);
    const intent = (await alice.repo.listIntents())[0]!.oid as string;

    // Alice runs two agent sessions; edits alpha. Bob edits beta. Different symbols.
    const sA = await alice.repo.startSession({ intentOid: intent, actor: actor("ai:alice") });
    await alice.repo.proposeSymbolEdit({ sessionOid: sA, intentOid: intent, actor: actor("ai:alice"), path: "mod.ts", symbolName: "alpha", newText: sym("alpha", "A1"), declaredPurpose: "alpha", causalDeps: [org.baseOp], signWith: org.keys.get("ai:alice") });
    const sB = await bob.repo.startSession({ intentOid: intent, actor: actor("ai:bob") });
    await bob.repo.proposeSymbolEdit({ sessionOid: sB, intentOid: intent, actor: actor("ai:bob"), path: "mod.ts", symbolName: "beta", newText: sym("beta", "B1"), declaredPurpose: "beta", causalDeps: [org.baseOp], signWith: org.keys.get("ai:bob") });

    await alice.repo.pushHub(org.hub.url);
    await bob.repo.pushHub(org.hub.url);
    await alice.repo.pullHub(org.hub.url);
    await bob.repo.pullHub(org.hub.url);

    const ra = await alice.repo.materialize();
    const rb = await bob.repo.materialize();
    assert.equal(ra.conflicts.length, 0);
    assert.equal(ra.treeHash, rb.treeHash, "replicas converge");
    assert.equal(await symVal(alice.repo, "alpha"), "A1");
    assert.equal(await symVal(alice.repo, "beta"), "B1");
  } finally {
    await org.close();
  }
});

test("INTEGRATION C2+C3: same-symbol conflict on all replicas, resolved by authority", async () => {
  const org = await makeOrg();
  try {
    const alice = await joinUser(org);
    const bob = await joinUser(org);
    const intent = (await alice.repo.listIntents())[0]!.oid as string;

    const sA = await alice.repo.startSession({ intentOid: intent, actor: actor("ai:alice") });
    const opA = await alice.repo.proposeSymbolEdit({ sessionOid: sA, intentOid: intent, actor: actor("ai:alice"), path: "mod.ts", symbolName: "alpha", newText: sym("alpha", "fromAlice"), declaredPurpose: "alpha A", causalDeps: [org.baseOp], signWith: org.keys.get("ai:alice") });
    const sB = await bob.repo.startSession({ intentOid: intent, actor: actor("ai:bob") });
    const opB = await bob.repo.proposeSymbolEdit({ sessionOid: sB, intentOid: intent, actor: actor("ai:bob"), path: "mod.ts", symbolName: "alpha", newText: sym("alpha", "fromBob"), declaredPurpose: "alpha B", causalDeps: [org.baseOp], signWith: org.keys.get("ai:bob") });

    for (const u of [alice, bob]) await u.repo.pushHub(org.hub.url);
    for (const u of [alice, bob]) await u.repo.pullHub(org.hub.url);

    const ca = await alice.repo.materialize();
    const cb = await bob.repo.materialize();
    assert.equal(ca.conflicts.length, 1, "C2: alice sees the conflict");
    assert.equal(cb.conflicts.length, 1, "C2: bob sees the conflict");
    assert.equal(ca.conflicts[0]!.id, cb.conflicts[0]!.id, "C2: identical conflict id on both");

    // C3: a reviewer picks A; an admin (higher authority) overrides to B. Decisions sync.
    const cid = ca.conflicts[0]!.id;
    const rev = await joinUser(org);
    await rev.repo.recordDecision({ conflictId: cid, chosenOps: [opA], rejectedOps: [opB], reason: "reviewer: A", decidedBy: { kind: "human", id: "human:rev" } });
    const admin = await joinUser(org);
    await admin.repo.recordDecision({ conflictId: cid, chosenOps: [opB], rejectedOps: [opA], reason: "admin overrides: B", decidedBy: { kind: "human", id: "human:admin" } });
    for (const u of [rev, admin]) await u.repo.pushHub(org.hub.url);
    for (const u of [alice, bob]) await u.repo.pullHub(org.hub.url);

    assert.equal((await alice.repo.materialize()).statuses.get(opB), "accepted", "C3: admin authority wins on alice's replica");
    assert.equal(await symVal(bob.repo, "alpha"), "fromBob", "C3: bob's replica converges to admin's choice");
    assert.equal((await alice.repo.materialize()).treeHash, (await bob.repo.materialize()).treeHash);
  } finally {
    await org.close();
  }
});

test("INTEGRATION C4: a gated hub rejects an outsider's (non-member) push", async () => {
  const org = await makeOrg({ gated: true });
  try {
    const carol = await joinUser(org); // ext:carol is NOT a member
    const intent = (await carol.repo.listIntents())[0]!.oid as string;
    const sC = await carol.repo.startSession({ intentOid: intent, actor: actor("ext:carol") });
    await carol.repo.proposeSymbolEdit({ sessionOid: sC, intentOid: intent, actor: actor("ext:carol"), path: "mod.ts", symbolName: "alpha", newText: sym("alpha", "evil"), declaredPurpose: "drive-by", causalDeps: [org.baseOp] });

    const push = await carol.repo.pushHub(org.hub.url);
    assert.ok(push.rejected >= 1, "gated hub rejected the unauthorized op");

    // A member pulling the hub never sees Carol's change.
    const alice = await joinUser(org);
    assert.equal(await symVal(alice.repo, "alpha"), "a0", "outsider op did not reach other replicas");
  } finally {
    await org.close();
  }
});

test("INTEGRATION C5: outsider work is quarantined, then a reviewer promotes it (open hub)", async () => {
  const org = await makeOrg({ gated: false }); // open hub: contributions land, repo-side quarantine gates
  try {
    const carol = await joinUser(org);
    const intent = (await carol.repo.listIntents())[0]!.oid as string;
    const sC = await carol.repo.startSession({ intentOid: intent, actor: actor("ext:carol") });
    const contrib = await carol.repo.proposeSymbolEdit({ sessionOid: sC, intentOid: intent, actor: actor("ext:carol"), path: "mod.ts", symbolName: "beta", newText: sym("beta", "contributed"), declaredPurpose: "fix beta", causalDeps: [org.baseOp] });
    await carol.repo.pushHub(org.hub.url);

    const rev = await joinUser(org); // reviewer pulls; governance active → carol quarantined
    assert.equal((await rev.repo.materialize()).statuses.get(contrib), "quarantined");
    assert.equal(await symVal(rev.repo, "beta"), "b0", "quarantined contribution not yet applied");

    await rev.repo.promote([contrib], "human:rev", "looks good");
    assert.equal((await rev.repo.materialize()).statuses.get(contrib), "accepted");
    assert.equal(await symVal(rev.repo, "beta"), "contributed", "promoted → applied");
  } finally {
    await org.close();
  }
});

test("INTEGRATION C6: finalize CAS on the authority + head distributed to clients", async () => {
  const org = await makeOrg();
  try {
    // The maintainer finalizes on the authoritative repo; a stale parent is rejected.
    const cp1 = await org.central.createCheckpoint("main", "cp1");
    const ok = await org.central.finalize({ view: "main", newCheckpoint: cp1, parentHead: null, by: "ai:alice" });
    assert.equal(ok.finalized, true);
    const stale = await org.central.finalize({ view: "main", newCheckpoint: cp1, parentHead: null, by: "ai:alice" });
    assert.equal(stale.finalized, false, "stale (non-fast-forward) finalize rejected");

    // A proposer cannot finalize (role gate).
    const noRole = await org.central.finalize({ view: "main", newCheckpoint: cp1, parentHead: cp1, by: "ai:bob" });
    assert.equal(noRole.finalized, false);

    // Clients pull → they adopt the protected head (governance distribution).
    const alice = await joinUser(org);
    assert.equal(await alice.repo.protectedHead("main"), cp1, "protected head distributed to the client");
  } finally {
    await org.close();
  }
});
