// Phase 6: releases with SBOM + provenance, gated on a verified checkpoint.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { generateSbom } from "../src/release/sbom.ts";
import { Keyring } from "../src/core/identity.ts";
import type { Actor, Release } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };

test("generateSbom is deterministic and lists files + package deps", () => {
  const files = [
    { path: "src/b.ts", content: "b" },
    { path: "src/a.ts", content: "a" },
    { path: "package.json", content: JSON.stringify({ dependencies: { left: "1.0.0" }, devDependencies: { dev: "2.0.0" } }) },
  ];
  const s1 = generateSbom(files);
  const s2 = generateSbom([...files].reverse());
  assert.deepEqual(s1, s2, "order-independent");
  const names = s1.components.map((c) => c.name);
  assert.ok(names.includes("src/a.ts") && names.includes("src/b.ts"));
  assert.ok(s1.components.some((c) => c.type === "library" && c.name === "left" && c.version === "1.0.0"));
  assert.ok(s1.components.some((c) => c.type === "library" && c.name === "dev"));
});

test("cutRelease produces a signed release with an SBOM for a clean view", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const ci: Actor = { kind: "ci_bot", id: "ci:rel" };
  const key = await repo.generateActorKey(ci);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "src/app.ts", content: "export const x = 1\n", declaredPurpose: "app" });

  const out = await repo.cutRelease("main", {
    artifacts: [{ type: "container_image", ref: "registry/app:0.0.1", digest: "sha256:abc" }],
    signedBy: [ci.id],
    signWith: { keyId: key.keyId, privateKey: key.privateKey },
  });
  assert.equal(out.released, true);
  if (!out.released) return;

  const rel = await repo.store.get<Release>(out.releaseOid);
  assert.equal(rel.treeHash.length, 64);
  assert.ok(rel.sbom.components.some((c) => c.name === "src/app.ts"));
  assert.deepEqual(rel.artifacts[0]!.ref, "registry/app:0.0.1");
  assert.deepEqual(rel.signedBy, [ci.id]);

  // The signature verifies against the registered ci key.
  const kr = new Keyring();
  kr.register({ keyId: key.keyId, publicKey: key.publicKey, actorId: ci.id, actorKind: "ci_bot" });
  assert.equal(kr.verifyFor(ci.id, rel.oid as string, rel.sig), true, "release signature verifies");
  await rm(dir, { recursive: true, force: true });
});

test("cutRelease refuses an unverified (conflicted) view", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  // A public-API break with no human decision → an open conflict.
  await repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: ai, path: "api.ts", content: "x",
    declaredPurpose: "break", effects: { breaksPublicApi: true },
  });
  const out = await repo.cutRelease("main");
  assert.equal(out.released, false);
  if (!out.released) assert.match(out.reason, /conflict/);
  await rm(dir, { recursive: true, force: true });
});
