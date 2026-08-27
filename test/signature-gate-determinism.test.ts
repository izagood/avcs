import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";

/**
 * The signature trust gate must not key on local, unreplicated state (issue #66).
 * A keyring lives on one machine and is never replicated, so gating on "does a
 * keyring exist" made the same object graph reduce differently per replica —
 * silently, with an empty `conflicts` list.
 */

const author = { id: "alice", kind: "human" as const };
const ci = { id: "ci", kind: "ci_bot" as const };

/** History whose op only stays accepted while its (unsigned) evidence counts. */
async function seedGatedHistory(dir: string): Promise<{ repo: Repo; op: string }> {
  const repo = await Repo.init(dir);
  const intentOid = await repo.createIntent({ title: "behavior change", owner: author.id });
  const sessionOid = await repo.startSession({ intentOid, actor: author });
  const op = await repo.proposeFileWrite({
    sessionOid,
    intentOid,
    actor: author,
    path: "a.ts",
    content: "export const a = 1;\n",
    declaredPurpose: "change behavior",
    effects: { changesBehavior: true },
  });
  // Independent, UNSIGNED evidence — authored when no signing key existed.
  await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "pass", producedBy: ci });
  return { repo, op };
}

test("provisioning a key does not change how existing history reduces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-gate-"));
  const { repo, op } = await seedGatedHistory(dir);

  let res = await repo.materialize();
  const before = (await repo.materializedFiles(res)).map((f) => f.path);
  assert.deepEqual(before, ["a.ts"], "precondition: unsigned evidence counts with no keyring");
  assert.equal(res.statuses.get(op), "accepted");

  // Provisioning a local key is an ADDITIVE capability.
  await repo.provisionOwnerKey(author);

  const reopened = await Repo.open(dir);
  res = await reopened.materialize();
  const after = (await reopened.materializedFiles(res)).map((f) => f.path);
  assert.deepEqual(after, before, "the tree must be unchanged by a local key");
  assert.equal(res.statuses.get(op), "accepted", "the op must not flip to rejected");
});

test("a policy can require signed evidence, and then it is enforced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-gate-on-"));
  const { repo, op } = await seedGatedHistory(dir);
  await repo.provisionOwnerKey(author);

  // Opt in through the POLICY — a replicated object, so every replica agrees.
  const policy = await repo.policy();
  await repo.setPolicy({ ...policy, requireSignedEvidence: true });

  const res = await repo.materialize();
  assert.equal(
    res.statuses.get(op),
    "rejected",
    "unsigned evidence must stop counting once the policy demands signatures",
  );
  assert.deepEqual((await repo.materializedFiles(res)).map((f) => f.path), []);
});

test("dropping evidence for a failed signature check is reported, not silent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-gate-diag-"));
  const { repo } = await seedGatedHistory(dir);
  await repo.provisionOwnerKey(author);
  const policy = await repo.policy();
  await repo.setPolicy({ ...policy, requireSignedEvidence: true });

  const res = await repo.materialize();
  assert.ok(
    res.untrustedEvidence >= 1,
    "the reduction must report how much evidence it discarded as untrusted",
  );
});

test("a rejected op carries the reason it was blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-gate-why-"));
  const { repo, op } = await seedGatedHistory(dir);
  await repo.provisionOwnerKey(author);
  const policy = await repo.policy();
  await repo.setPolicy({ ...policy, requireSignedEvidence: true });

  const res = await repo.materialize();
  const reason = res.blockedReasons.get(op);
  assert.ok(reason, "a rejected op must say why (it left the projection silently before)");
  assert.match(reason, /missing trusted unit_test=pass/);
});
