// Storage hardening (docs/10 WS-C): GC reclaims unreachable objects only — never the
// append-only audit history of accepted ops.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { generateKeypair } from "../src/core/identity.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const outsider: Actor = { kind: "ai_agent", id: "ext:carol" };

test("gc collects orphan blobs but keeps referenced ones; dry-run is non-destructive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.ts", content: "kept\n", declaredPurpose: "a" });
  const orphan = await repo.putBlob("orphan content, no op references me\n");

  const dry = await repo.gc({ dryRun: true });
  assert.ok(dry.blobs.includes(orphan), "dry-run reports the orphan");
  assert.equal(await repo.store.has(orphan), true, "dry-run did not delete");

  const r = await repo.gc();
  assert.ok(r.blobs.includes(orphan));
  assert.equal(await repo.store.has(orphan), false, "orphan deleted");
  // referenced blob + materialize still intact
  assert.equal((await repo.materialize()).tree.size, 1);
  assert.match((await repo.materializedFiles(await repo.materialize()))[0]!.content, /kept/);
  await rm(dir, { recursive: true, force: true });
});

test("gc collects expired quarantined outsider ops; keeps promoted/depended-on ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const root = generateKeypair();
  const k = generateKeypair();
  await repo.registerMembership({ actorId: "human:rev", publicKey: k.publicKey, role: "reviewer", root: { keyId: "root", privateKey: root.privateKey } });
  const intent = await repo.createIntent({ title: "t", owner: "human:rev" });
  const s = await repo.startSession({ intentOid: intent, actor: outsider });
  const spam = await repo.proposeOutsider({ sessionOid: s, intentOid: intent, actor: outsider, target: { entityKind: "file", entityId: "spam.ts" }, body: { kind: "put_file", path: "spam.ts", blobOid: await repo.putBlob("spam") }, declaredPurpose: "spam" });
  const keep = await repo.proposeOutsider({ sessionOid: s, intentOid: intent, actor: outsider, target: { entityKind: "file", entityId: "good.ts" }, body: { kind: "put_file", path: "good.ts", blobOid: await repo.putBlob("good") }, declaredPurpose: "good" });
  await repo.promote([keep], "human:rev"); // promoted → not GC'd

  // ttl 0 → all expired-eligible quarantined ops are collectable
  const r = await repo.gc({ quarantineTtlMs: 0 });
  assert.ok(r.quarantinedOps.includes(spam), "expired quarantine spam collected");
  assert.ok(!r.quarantinedOps.includes(keep), "promoted op kept");
  assert.equal(await repo.store.has(spam), false);
  assert.equal(await repo.store.has(keep), true);
  await rm(dir, { recursive: true, force: true });
});
