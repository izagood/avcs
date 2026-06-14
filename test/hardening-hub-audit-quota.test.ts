// Track E / E7 — hub operability: an append-only audit log of accepted mutations
// (provenance beyond the signed object) and an app-layer per-actor push quota
// (abuse resistance). hub fsck is not a new endpoint: the hub IS an ObjectStore, so the
// D3 `avcs fsck` runs directly against the hub's repo dir (documented in docs/13).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";

async function postBlob(url: string, i: number): Promise<number> {
  const blob = { type: "blob", data: Buffer.from(`payload-${i}`).toString("base64"), encoding: "base64" };
  const r = await fetch(`${url}/objects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(blob) });
  await r.text();
  return r.status;
}

test("E7: per-actor push quota returns 429 past the limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-e7q-"));
  await Repo.init(dir);
  const hub = await startHub({ repoDir: dir, port: 0, rateLimit: { maxPerWindow: 3, windowMs: 60_000 } });
  try {
    assert.equal(await postBlob(hub.url, 1), 200);
    assert.equal(await postBlob(hub.url, 2), 200);
    assert.equal(await postBlob(hub.url, 3), 200);
    assert.equal(await postBlob(hub.url, 4), 429, "4th push over the limit is throttled");
    assert.ok((hub.metrics.snapshot().counters?.["hub.ratelimited"] ?? 0) >= 1, "rate-limit counted");
  } finally {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("E7: accepted mutations are written to the hub audit log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-e7a-"));
  await Repo.init(dir);
  const hub = await startHub({ repoDir: dir, port: 0 }); // no quota
  try {
    assert.equal(await postBlob(hub.url, 1), 200);
    assert.equal(await postBlob(hub.url, 2), 200);
    const log = await readFile(join(dir, ".avcs", "hub-audit.log"), "utf8");
    const records = log.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.ok(records.length >= 2, "two pushes audited");
    assert.ok(records.every((r) => r.action === "put" && r.type === "blob" && typeof r.oid === "string" && typeof r.ts === "string"), "audit records carry action/type/oid/ts");
  } finally {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
