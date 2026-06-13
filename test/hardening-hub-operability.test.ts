// Operability hardening (docs/10 WS-B): a real avcshub needs liveness/version/metrics
// endpoints for load balancers, client compatibility checks, and scraping — plus
// graceful handling of malformed input. These never touch the content/governance planes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub, HUB_PROTOCOL_VERSION } from "../src/hub/hubServer.ts";
import { pushToHub } from "../src/hub/hubClient.ts";
import { MATERIALIZER_VERSION } from "../src/reducer/policy.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

test("hub exposes /healthz, /version and /metrics; malformed input is rejected cleanly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-op-"));
  const devDir = await mkdtemp(join(tmpdir(), "avcs-opdev-"));
  const hub = await startHub({ repoDir: dir, port: 0 });
  try {
    // /healthz — O(1) liveness, no store scan
    const health = await getJson(`${hub.url}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(health.body.status, "ok");
    assert.equal(health.body.gated, false);

    // /version — protocol + materializer identity for compatibility checks
    const version = await getJson(`${hub.url}/version`);
    assert.equal(version.status, 200);
    assert.equal(version.body.name, "avcs-hub");
    assert.equal(version.body.protocol, HUB_PROTOCOL_VERSION);
    assert.equal(version.body.materializer, MATERIALIZER_VERSION);

    // drive some real traffic so metrics have content
    const dev = await Repo.init(devDir);
    const intent = await dev.createIntent({ title: "t", owner: "human:a" });
    const sess = await dev.startSession({ intentOid: intent, actor: ai });
    await dev.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.txt", content: "hi\n", declaredPurpose: "x" });
    await pushToHub(devDir, hub.url);

    // /metrics — counters + latency timing
    const metrics = await getJson(`${hub.url}/metrics`);
    assert.equal(metrics.status, 200);
    assert.ok(metrics.body.counters["hub.requests"] >= 4, `expected request counter, got ${JSON.stringify(metrics.body.counters)}`);
    assert.ok(metrics.body.counters["hub.status.2xx"] >= 4, "2xx class counted");
    assert.ok((metrics.body.timings["hub.request.ms"]?.count ?? 0) >= 1, "latency timing recorded");

    // the hub handle exposes the same live Metrics instance
    assert.ok((hub.metrics.snapshot().counters["hub.requests"] ?? 0) >= 4);

    // malformed POST body → 400, no crash; subsequent requests still served
    const bad = await fetch(`${hub.url}/objects`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    assert.equal(bad.status, 400);
    const noType = await fetch(`${hub.url}/objects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ foo: 1 }) });
    assert.equal(noType.status, 400);
    // unknown route → 404 (not a 500)
    const missing = await fetch(`${hub.url}/nope`);
    assert.equal(missing.status, 404);
    // server is still alive after the bad inputs
    assert.equal((await getJson(`${hub.url}/healthz`)).status, 200);

    // 4xx requests are classified in metrics too
    const after = await getJson(`${hub.url}/metrics`);
    assert.ok(after.body.counters["hub.status.4xx"] >= 3, "4xx class counted");
  } finally {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
    await rm(devDir, { recursive: true, force: true });
  }
});

test("gated hub reports gated:true in health/version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-opg-"));
  const hub = await startHub({ repoDir: dir, port: 0, gated: true });
  try {
    assert.equal((await getJson(`${hub.url}/healthz`)).body.gated, true);
    assert.equal((await getJson(`${hub.url}/version`)).body.gated, true);
  } finally {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
