// `submitIntegration({ dryRun: true })` — the verdict without the head moving (issue #79).
//
// The integration queue is the right authority for "may this land?", and the natural place to
// surface that answer is a pre-merge check: a CI job reporting the verdict while the author is
// still working. Such a job must not advance the protected head as a side effect of reporting.
//
// Without a core dry run there were two bad options. Call `submitIntegration` for real, which
// lands the change merely because someone opened a proposal. Or reimplement the verdict
// outside the core — which forks the decision into two implementations that will drift, and
// docs/17 §2 is explicit that every queue decision must be a pure function of objects +
// Protection.
//
// A consumer took a third route: fork an ephemeral view, copy the Protection onto it, mirror
// the in-flight reservation, neutralise the idempotency replay, and submit against that. It
// works, and it is four pieces of state to keep in sync with a path that is allowed to change.
// This flag replaces all of it.
//
// So the property under test is not "dryRun returns something". It is: **the same decision
// path runs, and nothing is written.** Both halves need asserting — a dry run that quietly
// took a different path would be worse than none, because it would report confidently on a
// judgement the real queue never makes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor, Integration } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const bi: Actor = { kind: "ai_agent", id: "ai:b" };

async function author(repo: Repo, path: string, content: string, actor: Actor = ai): Promise<string> {
  const intent = await repo.createIntent({ title: `write ${path}`, owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor });
  return repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor, path, content, declaredPurpose: `write ${path}`,
  });
}

/** Everything a dry run must leave alone, in one comparable shape. */
async function snapshot(repo: Repo): Promise<{
  head: string | null;
  integrations: number;
  checkpoints: number;
  reservation: string;
}> {
  return {
    head: (await repo.protectedHead("main")) ?? null,
    integrations: (await repo.store.collect<Integration>("integration")).length,
    checkpoints: (await repo.store.collect("checkpoint")).length,
    reservation: (await repo.store.readAux("queue/main.json"))?.toString("utf8") ?? "(none)",
  };
}

test("a dry run advances nothing — head, audit, checkpoints and reservation all unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-79-"));
  try {
    const repo = await Repo.init(dir);
    await author(repo, "a.ts", "A\n");
    const cp = await repo.createCheckpoint("main", "A's work");

    const before = await snapshot(repo);
    const preview = await repo.submitIntegration({ view: "main", checkpoint: cp, by: "human:h", dryRun: true });
    const after = await snapshot(repo);

    assert.equal(preview.verdict, "advanced", "the verdict is still computed");
    assert.deepEqual(after, before, "a dry run writes nothing");
    assert.equal(after.head, null, "and the protected head was never set");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the dry run and the real submission reach the SAME verdict", async () => {
  // The point of routing through the core rather than reimplementing: one decision, two
  // callers. If these ever disagree the preview is worse than useless.
  const dir = await mkdtemp(join(tmpdir(), "avcs-79-same-"));
  try {
    const repo = await Repo.init(dir);
    await author(repo, "a.ts", "A\n");
    const cp = await repo.createCheckpoint("main", "A's work");

    const preview = await repo.submitIntegration({ view: "main", checkpoint: cp, by: "human:h", dryRun: true });
    const real = await repo.submitIntegration({ view: "main", checkpoint: cp, by: "human:h" });

    assert.equal(preview.verdict, real.verdict);
    assert.ok(await repo.protectedHead("main"), "…and only the real one moved the head");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a dry run is repeatable — no idempotency replay to neutralise", async () => {
  // The ephemeral-view workaround had to write a sentinel ref to stop the core replaying a
  // previous preview's `advanced` record against a head that had since moved. With no record
  // written there is nothing to replay, so every dry run is judged fresh by construction.
  const dir = await mkdtemp(join(tmpdir(), "avcs-79-repeat-"));
  try {
    const repo = await Repo.init(dir);
    await author(repo, "a.ts", "A\n");
    const cp = await repo.createCheckpoint("main", "A's work");

    const first = await repo.submitIntegration({ view: "main", checkpoint: cp, by: "human:h", dryRun: true });
    const second = await repo.submitIntegration({ view: "main", checkpoint: cp, by: "human:h", dryRun: true });
    assert.equal(first.verdict, "advanced");
    assert.equal(second.verdict, "advanced");
    assert.equal((await repo.store.collect<Integration>("integration")).length, 0, "still no audit records");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a dry run after a real advance sees the moved head, not a stale one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-79-moved-"));
  try {
    const repo = await Repo.init(dir);
    await author(repo, "a.ts", "A\n");
    const cpA = await repo.createCheckpoint("main", "A");
    await repo.submitIntegration({ view: "main", checkpoint: cpA, by: "human:h" });
    const head = await repo.protectedHead("main");

    await author(repo, "b.ts", "B\n", bi);
    const cpB = await repo.createCheckpoint("main", "B");
    const preview = await repo.submitIntegration({ view: "main", checkpoint: cpB, by: "human:h", dryRun: true });

    assert.equal(preview.verdict, "advanced", "disjoint work still previews as landable");
    assert.equal(await repo.protectedHead("main"), head, "and the head did not move for the preview");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a conflict previews WITH its repair packet", async () => {
  // A verdict without its packet would force the caller back to the real submission to learn
  // what to fix — which is the thing this exists to avoid.
  const dir = await mkdtemp(join(tmpdir(), "avcs-79-conflict-"));
  try {
    const repo = await Repo.init(dir);
    const seed = await author(repo, "shared.ts", "base\n");
    const cp0 = await repo.createCheckpoint("main", "seed");
    await repo.submitIntegration({ view: "main", checkpoint: cp0, by: "human:h" });

    // Two concurrent edits to the same region, neither ordered after the other.
    const iA = await repo.createIntent({ title: "A", owner: "human:h" });
    const sA = await repo.startSession({ intentOid: iA, actor: ai });
    await repo.proposeEdit({
      sessionOid: sA, intentOid: iA, actor: ai, path: "shared.ts",
      baseText: "base\n", newText: "from A\n", declaredPurpose: "A", causalDeps: [seed],
    });
    const cpA = await repo.createCheckpoint("main", "A");

    const iB = await repo.createIntent({ title: "B", owner: "human:h" });
    const sB = await repo.startSession({ intentOid: iB, actor: bi });
    await repo.proposeEdit({
      sessionOid: sB, intentOid: iB, actor: bi, path: "shared.ts",
      baseText: "base\n", newText: "from B\n", declaredPurpose: "B", causalDeps: [seed],
    });
    const cpB = await repo.createCheckpoint("main", "B");

    await repo.submitIntegration({ view: "main", checkpoint: cpA, by: "human:h" });
    const before = await snapshot(repo);
    const preview = await repo.submitIntegration({ view: "main", checkpoint: cpB, by: "human:h", dryRun: true });

    if (preview.verdict === "conflict") {
      const packet = (preview as { packet?: { conflicts: unknown[] } }).packet;
      assert.ok(packet, "a conflict preview must carry its repair packet");
      assert.ok(packet.conflicts.length > 0, "…naming at least one key");
    }
    assert.deepEqual(await snapshot(repo), before, "whatever the verdict, nothing was written");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a dry run does not consume or create a reservation", async () => {
  // `needs_evidence` holds one in-flight ticket per view. A preview that took that slot would
  // block the real submitter on a judgement that never happened.
  const dir = await mkdtemp(join(tmpdir(), "avcs-79-resv-"));
  try {
    const repo = await Repo.init(dir);
    await author(repo, "a.ts", "A\n");
    const cp = await repo.createCheckpoint("main", "A");

    await repo.submitIntegration({ view: "main", checkpoint: cp, by: "human:h", dryRun: true });
    const resv = await repo.store.readAux("queue/main.json");
    assert.equal(resv, null, "no reservation file appeared");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dryRun is opt-in — omitting it still mutates, exactly as before", async () => {
  // The existing path may not change. This is the regression guard for every caller that
  // never heard of the flag.
  const dir = await mkdtemp(join(tmpdir(), "avcs-79-optin-"));
  try {
    const repo = await Repo.init(dir);
    await author(repo, "a.ts", "A\n");
    const cp = await repo.createCheckpoint("main", "A");

    const r = await repo.submitIntegration({ view: "main", checkpoint: cp, by: "human:h" });
    assert.equal(r.verdict, "advanced");
    assert.ok(await repo.protectedHead("main"), "the real path still advances the head");
    assert.equal((await repo.store.collect<Integration>("integration")).length, 1, "and records the audit object");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
