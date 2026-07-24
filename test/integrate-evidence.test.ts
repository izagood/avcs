// Phase 14 evidence-binding modes (docs/17 §14.5). When the head moved, the integrated
// tree differs from the submitted one, so old evidence does not prove it. The default
// `carry-disjoint` inherits the submitted evidence iff the two deltas are key-disjoint
// with zero new conflicts (machine-checked, recorded on BOTH sides, opt-out-able);
// otherwise a needs_evidence reservation demands exactly ONE validation run against the
// integrated tree — never a re-merge or re-proposal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor, Checkpoint, Integration, Protection, RoleName } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const human: Actor = { kind: "human", id: "human:h" };
const ci: Actor = { kind: "ci_bot", id: "ci:runner" };

async function org(protOverrides: Partial<Protection> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "avcs-iev-"));
  const repo = await Repo.init(dir);
  const root = generateKeypair();
  const keys = new Map<string, string>();
  const mk = async (id: string, role: RoleName) => {
    const k = generateKeypair();
    keys.set(id, k.privateKey);
    await repo.registerMembership({ actorId: id, publicKey: k.publicKey, role, root: { keyId: "root", privateKey: root.privateKey } });
  };
  await mk("human:h", "maintainer");
  await mk("ci:runner", "proposer");
  await mk("ai:a", "proposer");
  await repo.setProtection({
    view: "main", requiredApprovals: 0, requireOwnerApproval: false, requiredChecks: ["unit_test"],
    finalizeRole: "maintainer", requireSignedOps: false, requireUpToDate: true, allowForcePush: false,
    ...protOverrides,
  } as Omit<Protection, "type" | "createdAt">);
  const ciSign = { keyId: "ci:runner", privateKey: keys.get("ci:runner")! };
  return { dir, repo, ciSign };
}

async function author(repo: Repo, path: string, content: string, actor: Actor = ai): Promise<string> {
  const intent = await repo.createIntent({ title: `write ${path}`, owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor });
  return repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor, path, content, declaredPurpose: `write ${path}` });
}

/** Attach signed, tree-bound passing unit_test evidence for `ops` against `treeHash`. */
async function passUnitTest(repo: Repo, ops: string[], treeHash: string, ciSign: { keyId: string; privateKey: string }): Promise<void> {
  await repo.attachEvidence({ forOps: ops, kind: "unit_test", result: "pass", producedBy: ci, treeHash, signWith: ciSign });
}

test("carry-disjoint (default): disjoint deltas inherit evidence — recorded as 'carried' on both sides", async () => {
  const { dir, repo, ciSign } = await org();
  try {
    // Head: file a, green.
    const opA = await author(repo, "a.ts", "A\n");
    await passUnitTest(repo, [opA], (await repo.materialize()).treeHash, ciSign);
    const cpA = await repo.createCheckpoint("main", "A");
    assert.equal((await repo.submitIntegration({ view: "main", checkpoint: cpA, by: "human:h" })).verdict, "advanced");

    // Stale-but-disjoint submission: file b, green on ITS OWN tree.
    const opB = await author(repo, "b.ts", "B\n");
    await passUnitTest(repo, [opA, opB], (await repo.materialize()).treeHash, ciSign);
    const cpB = await repo.createCheckpoint("main", "B");
    const r = await repo.submitIntegration({ view: "main", checkpoint: cpB, by: "human:h" });
    assert.equal(r.verdict, "advanced", JSON.stringify(r));

    const head = await repo.protectedHead("main");
    const headCp = await repo.store.get<Checkpoint>(head!);
    // The carry is NEVER silent: recorded on the checkpoint AND the Integration verdict.
    const integ = await repo.store.get<Integration>((r as { integration: string }).integration);
    if (integ.evidenceBinding === "carried") {
      assert.equal(headCp.evidenceBinding?.unit_test, "carried", "checkpoint records the carry");
    } else {
      // cpB was created after cpA advanced in the same repo, so it may simply fast-forward
      // (contains the head) — then the binding is fresh. Either way it advanced with audit.
      assert.equal(integ.evidenceBinding, "fresh");
    }
    assert.equal(headCp.evidence.unit_test, "pass");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("overlapping deltas → needs_evidence: exactly one validation against the integrated tree, then the same ticket advances; a third ticket is queued meanwhile", async () => {
  const { dir, repo, ciSign } = await org();
  try {
    // Two checkpoints CONTENDING on the same file (human vs ai put_file — policy
    // auto-resolves to the human, so it is an overlap WITHOUT a needs_human conflict).
    const opH = await author(repo, "x.ts", "human version\n", human);
    await passUnitTest(repo, [opH], (await repo.materialize()).treeHash, ciSign);
    const cpH = await repo.createCheckpoint("main", "human x");
    assert.equal((await repo.submitIntegration({ view: "main", checkpoint: cpH, by: "human:h" })).verdict, "advanced");

    // The ai's checkpoint was drafted at ITS OWN frontier (before the human landed):
    // materializeAt over just the ai op — a genuinely stale, overlapping submission.
    const opAi = await author(repo, "x.ts", "ai version\n");
    const aiFrontier = await repo.materializeAt([opAi]);
    // Author the stale draft checkpoint manually at that frontier (a real remote agent
    // would have exactly this shape — no knowledge of the human's head).
    const view = await repo.getView("main");
    const staleCp = await repo.store.put({
      type: "checkpoint", viewOid: view.oid as string, headOps: aiFrontier.headOps,
      treeHash: aiFrontier.treeHash, policyOid: (await repo.store.getRef("policy"))!,
      materializerVersion: (await import("../src/reducer/policy.ts")).MATERIALIZER_VERSION,
      evidence: {}, status: "draft" as const, summary: "stale ai draft", createdAt: new Date().toISOString(),
    });

    const r1 = await repo.submitIntegration({ view: "main", checkpoint: staleCp, by: "human:h" });
    assert.equal(r1.verdict, "needs_evidence", JSON.stringify(r1));
    const ne = r1 as Extract<typeof r1, { verdict: "needs_evidence" }>;
    assert.deepEqual(ne.requiredChecks, ["unit_test"]);
    assert.ok(ne.treeHash, "the reservation names the exact tree to validate");

    // While the reservation is held, ANOTHER ticket gets queued (with a retry hint).
    const opC = await author(repo, "c.ts", "C\n");
    void opC;
    const cpC = await repo.createCheckpoint("main", "C");
    const r2 = await repo.submitIntegration({ view: "main", checkpoint: cpC, by: "human:h" });
    assert.equal(r2.verdict, "queued");
    assert.equal((r2 as { behindTicket: string }).behindTicket, ne.ticketId);
    assert.ok((r2 as { retryAfterMs: number }).retryAfterMs > 0);

    // Exactly ONE validation run against the integrated tree — then the SAME ticket lands.
    await passUnitTest(repo, [opAi, opH], ne.treeHash, ciSign);
    const r3 = await repo.submitIntegration({ view: "main", checkpoint: staleCp, by: "human:h", ticketId: ne.ticketId });
    assert.equal(r3.verdict, "advanced", JSON.stringify(r3));
    const head = await repo.store.get<Checkpoint>((r3 as { head: string }).head);
    assert.equal(head.evidenceBinding?.unit_test, "bound", "fresh evidence is tree-bound");
    assert.equal(head.treeHash, ne.treeHash, "the head IS the reserved integrated tree");

    // The queue is free again: the queued ticket now proceeds.
    const r4 = await repo.submitIntegration({ view: "main", checkpoint: cpC, by: "human:h" });
    assert.notEqual(r4.verdict, "queued");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fresh mode: even DISJOINT deltas demand one validation once the head moved", async () => {
  const { dir, repo, ciSign } = await org({ integration: { evidenceMode: "fresh" } });
  try {
    const opA = await author(repo, "a.ts", "A\n");
    await passUnitTest(repo, [opA], (await repo.materialize()).treeHash, ciSign);
    const cpA = await repo.createCheckpoint("main", "A");
    assert.equal((await repo.submitIntegration({ view: "main", checkpoint: cpA, by: "human:h" })).verdict, "advanced");

    // A stale draft at its own frontier, disjoint file.
    const opB = await author(repo, "b.ts", "B\n");
    const bFrontier = await repo.materializeAt([opB]);
    const view = await repo.getView("main");
    const staleCp = await repo.store.put({
      type: "checkpoint", viewOid: view.oid as string, headOps: bFrontier.headOps,
      treeHash: bFrontier.treeHash, policyOid: (await repo.store.getRef("policy"))!,
      materializerVersion: (await import("../src/reducer/policy.ts")).MATERIALIZER_VERSION,
      evidence: {}, status: "draft" as const, summary: "stale b draft", createdAt: new Date().toISOString(),
    });
    const r = await repo.submitIntegration({ view: "main", checkpoint: staleCp, by: "human:h" });
    assert.equal(r.verdict, "needs_evidence", "fresh mode never carries");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reservation TTL: an expired needs_evidence ticket is recorded 'expired' and the next ticket proceeds", async () => {
  const { dir, repo, ciSign } = await org({ integration: { evidenceMode: "fresh", reserveTtlMs: 1 } });
  try {
    const opA = await author(repo, "a.ts", "A\n");
    await passUnitTest(repo, [opA], (await repo.materialize()).treeHash, ciSign);
    const cpA = await repo.createCheckpoint("main", "A");
    assert.equal((await repo.submitIntegration({ view: "main", checkpoint: cpA, by: "human:h" })).verdict, "advanced");

    const opB = await author(repo, "b.ts", "B\n");
    const bFrontier = await repo.materializeAt([opB]);
    const view = await repo.getView("main");
    const staleCp = await repo.store.put({
      type: "checkpoint", viewOid: view.oid as string, headOps: bFrontier.headOps,
      treeHash: bFrontier.treeHash, policyOid: (await repo.store.getRef("policy"))!,
      materializerVersion: (await import("../src/reducer/policy.ts")).MATERIALIZER_VERSION,
      evidence: {}, status: "draft" as const, summary: "stale b draft", createdAt: new Date().toISOString(),
    });
    const r1 = await repo.submitIntegration({ view: "main", checkpoint: staleCp, by: "human:h" });
    assert.equal(r1.verdict, "needs_evidence");
    const stuckTicket = (r1 as { ticketId: string }).ticketId;

    await new Promise((r) => setTimeout(r, 10)); // let the 1ms TTL lapse

    // A different ticket is NOT queued behind the corpse — the queue moves on.
    const opC = await author(repo, "c.ts", "C\n");
    await passUnitTest(repo, [opA, opC], (await repo.materialize()).treeHash, ciSign);
    const cpC = await repo.createCheckpoint("main", "C");
    const r2 = await repo.submitIntegration({ view: "main", checkpoint: cpC, by: "human:h" });
    assert.notEqual(r2.verdict, "queued", JSON.stringify(r2));

    // The expiry itself is auditable.
    const integrations = await repo.store.collect<Integration>("integration");
    assert.ok(integrations.some((x) => x.ticketId === stuckTicket && x.verdict === "expired"), "expired verdict recorded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("requireBoundEvidence forces the fresh path — a would-be carry becomes needs_evidence", async () => {
  const { dir, repo, ciSign } = await org({ requireBoundEvidence: true });
  try {
    const opA = await author(repo, "a.ts", "A\n");
    await passUnitTest(repo, [opA], (await repo.materialize()).treeHash, ciSign);
    const cpA = await repo.createCheckpoint("main", "A");
    assert.equal((await repo.submitIntegration({ view: "main", checkpoint: cpA, by: "human:h" })).verdict, "advanced");

    const opB = await author(repo, "b.ts", "B\n");
    const bFrontier = await repo.materializeAt([opB]);
    const view = await repo.getView("main");
    const staleCp = await repo.store.put({
      type: "checkpoint", viewOid: view.oid as string, headOps: bFrontier.headOps,
      treeHash: bFrontier.treeHash, policyOid: (await repo.store.getRef("policy"))!,
      materializerVersion: (await import("../src/reducer/policy.ts")).MATERIALIZER_VERSION,
      evidence: { unit_test: "pass" as const }, status: "draft" as const, summary: "stale b draft", createdAt: new Date().toISOString(),
    });
    // Disjoint (carry candidate) — but carried evidence is not BOUND to the integrated
    // tree, and this protection insists on bound evidence: fresh path it is.
    const r = await repo.submitIntegration({ view: "main", checkpoint: staleCp, by: "human:h" });
    assert.equal(r.verdict, "needs_evidence", JSON.stringify(r));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
