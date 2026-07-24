// Phase 14 conflict packets (docs/17 §14.2 step 5). A genuine same-key overlap (L4)
// still needs a human decision — that gate is kept ON PURPOSE — but it arrives as a
// minimal repair packet (counterpart ops + overlapping regions + prior rulings on the
// same key), replacing "pull and redo" with "decide and resubmit".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";
import type { ConflictPacket } from "../src/api/repo.ts";

const a1: Actor = { kind: "ai_agent", id: "ai:one" };
const a2: Actor = { kind: "ai_agent", id: "ai:two" };

test("overlapping edit_file hunks → conflict packet with regions + decision memory; decide → resubmit → advanced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-icp-"));
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const s1 = await repo.startSession({ intentOid: intent, actor: a1 });
    const s2 = await repo.startSession({ intentOid: intent, actor: a2 });

    // A shared base file, then two agents edit the SAME line concurrently.
    const base = "line1\nline2\nline3\n";
    const opBase = await repo.proposeFileWrite({ sessionOid: s1, intentOid: intent, actor: a1, path: "f.ts", content: base, declaredPurpose: "base" });
    const e1 = await repo.proposeEdit({ sessionOid: s1, intentOid: intent, actor: a1, path: "f.ts", newText: "line1\nagent-one\nline3\n", baseText: base, causalDeps: [opBase], declaredPurpose: "one's edit" });
    const e2 = await repo.proposeEdit({ sessionOid: s2, intentOid: intent, actor: a2, path: "f.ts", newText: "line1\nagent-two\nline3\n", baseText: base, causalDeps: [opBase], declaredPurpose: "two's edit" });

    const cp = await repo.createCheckpoint("main", "conflicted");
    const r1 = await repo.submitIntegration({ view: "main", checkpoint: cp, by: "human:h" });
    assert.equal(r1.verdict, "conflict", JSON.stringify(r1));
    const packet = (r1 as { packet: ConflictPacket }).packet;
    assert.equal(packet.conflicts.length, 1);
    const c = packet.conflicts[0]!;
    assert.equal(c.key, "file:f.ts");
    assert.ok(c.options.some((o) => o.op === e1) && c.options.some((o) => o.op === e2), "both counterpart ops named");
    assert.ok((c.regions?.length ?? 0) >= 1, "overlapping line region attached");
    assert.equal(c.priorDecisions.length, 0, "no precedent yet");
    assert.equal(await repo.protectedHead("main"), null, "head never advances on conflict");

    // Decide (the human gate — unchanged by Phase 14), then resubmit the SAME work.
    // Non-terminal verdicts re-evaluate: the world legitimately changed (a decision landed).
    await repo.recordDecision({
      conflictId: (await repo.materialize()).conflicts[0]!.id,
      chosenOps: [e1], rejectedOps: [e2],
      reason: "agent-one's phrasing matches the style guide",
      decidedBy: { kind: "human", id: "human:h" },
    });
    const cp2 = await repo.createCheckpoint("main", "decided");
    const r2 = await repo.submitIntegration({ view: "main", checkpoint: cp2, by: "human:h" });
    assert.equal(r2.verdict, "advanced", JSON.stringify(r2));
    const head = await repo.store.get<import("../src/objects/types.ts").Checkpoint>((r2 as { head: string }).head);
    const tree = await repo.materializeAt(head.headOps);
    const f = (await repo.materializedFiles(tree)).find((x) => x.path === "f.ts");
    assert.equal(f?.content, "line1\nagent-one\nline3\n", "the decided content is what landed");

    // Decision MEMORY: a fresh conflict on the SAME key ships the precedent in-packet.
    const e3 = await repo.proposeEdit({ sessionOid: s1, intentOid: intent, actor: a1, path: "f.ts", newText: "line1\nagent-one-v2\nline3\n", baseText: "line1\nagent-one\nline3\n", causalDeps: [e1], declaredPurpose: "one again" });
    const e4 = await repo.proposeEdit({ sessionOid: s2, intentOid: intent, actor: a2, path: "f.ts", newText: "line1\nagent-two-v2\nline3\n", baseText: "line1\nagent-one\nline3\n", causalDeps: [e1], declaredPurpose: "two again" });
    void e3; void e4;
    const cp3 = await repo.createCheckpoint("main", "conflicted again");
    const r3 = await repo.submitIntegration({ view: "main", checkpoint: cp3, by: "human:h" });
    assert.equal(r3.verdict, "conflict");
    const packet3 = (r3 as { packet: ConflictPacket }).packet;
    assert.ok(
      packet3.conflicts[0]!.priorDecisions.some((d) => d.reason.includes("style guide")),
      "the earlier ruling rides along — an agent can propose a precedent-based decision",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
