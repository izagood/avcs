// Transport-layer authentication (SSH-style public-key auth over HTTP). Distinct from the
// object-level gating in hardening-hub-authz: this authenticates the REQUEST, the way
// `git clone git@host` proves possession of a key before the server speaks. Model: the
// client signs a canonical description of the request with its private key; the hub
// verifies against the registered member's public key (= authorized_keys). Read endpoints
// stay public (D2: read-public, write-auth); a failed credential is a 401 (vs the 403 the
// object-level gate returns for an insufficiently-privileged push).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import { generateKeypair } from "../src/core/identity.ts";
import {
  buildAuthHeader, parseAuthHeader, verifyAuth, canonicalRequest, NonceCache,
} from "../src/hub/transportAuth.ts";

const INERT = JSON.stringify({ type: "note", text: "inert content-addressed data" });

async function postObjects(url: string, body: string, authorization?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization) headers["authorization"] = authorization;
  const r = await fetch(`${url}/objects`, { method: "POST", headers, body });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// ── unit: the credential round-trips and verifies, and each failure mode is caught ──

test("transportAuth: build → parse round-trips all fields", () => {
  const kp = generateKeypair();
  const header = buildAuthHeader({ keyId: "ai:claude", privateKey: kp.privateKey, method: "POST", path: "/objects", body: INERT });
  const cred = parseAuthHeader(header);
  assert.ok(cred, "header parses");
  assert.equal(cred!.keyId, "ai:claude");
  assert.ok(cred!.ts && cred!.nonce && cred!.sig);
});

test("transportAuth: parse rejects a non-AVCS-Sig scheme", () => {
  assert.equal(parseAuthHeader("Bearer abc.def"), null);
  assert.equal(parseAuthHeader(undefined), null);
  assert.equal(parseAuthHeader("AVCS-Sig keyId=\"x\""), null, "missing fields → null");
});

test("transportAuth: verifyAuth accepts a valid credential and binds to the body", async () => {
  const kp = generateKeypair();
  const resolve = async (k: string) => (k === "ai:claude" ? kp.publicKey : null);
  const now = Date.parse("2026-06-23T00:00:00.000Z");
  const header = buildAuthHeader({ keyId: "ai:claude", privateKey: kp.privateKey, method: "POST", path: "/objects", body: INERT, ts: "2026-06-23T00:00:00.000Z" });

  const ok = await verifyAuth({ header, method: "POST", path: "/objects", body: INERT, resolvePublicKey: resolve, now });
  assert.equal(ok.ok, true);

  // Same header, DIFFERENT body → signature no longer covers the content.
  const tampered = await verifyAuth({ header, method: "POST", path: "/objects", body: INERT + " ", resolvePublicKey: resolve, now });
  assert.equal(tampered.ok, false);
  assert.match((tampered as { reason: string }).reason, /does not verify/);
});

test("transportAuth: verifyAuth rejects unknown key, stale ts, and replayed nonce", async () => {
  const kp = generateKeypair();
  const resolve = async (k: string) => (k === "ai:claude" ? kp.publicKey : null);
  const now = Date.parse("2026-06-23T00:00:00.000Z");

  // unknown key
  const otherHeader = buildAuthHeader({ keyId: "ai:ghost", privateKey: generateKeypair().privateKey, method: "POST", path: "/objects", body: INERT, ts: "2026-06-23T00:00:00.000Z" });
  const unknown = await verifyAuth({ header: otherHeader, method: "POST", path: "/objects", body: INERT, resolvePublicKey: resolve, now });
  assert.equal(unknown.ok, false);
  assert.match((unknown as { reason: string }).reason, /unknown signing key/);

  // stale timestamp (well outside the 5m window)
  const staleHeader = buildAuthHeader({ keyId: "ai:claude", privateKey: kp.privateKey, method: "POST", path: "/objects", body: INERT, ts: "2026-06-23T00:00:00.000Z" });
  const stale = await verifyAuth({ header: staleHeader, method: "POST", path: "/objects", body: INERT, resolvePublicKey: resolve, now: now + 3_600_000 });
  assert.equal(stale.ok, false);
  assert.match((stale as { reason: string }).reason, /freshness window/);

  // replay: a nonce cache rejects the second presentation of the same credential
  const cache = new NonceCache();
  const h = buildAuthHeader({ keyId: "ai:claude", privateKey: kp.privateKey, method: "POST", path: "/objects", body: INERT, ts: "2026-06-23T00:00:00.000Z" });
  const first = await verifyAuth({ header: h, method: "POST", path: "/objects", body: INERT, resolvePublicKey: resolve, now, nonceCache: cache });
  assert.equal(first.ok, true);
  const second = await verifyAuth({ header: h, method: "POST", path: "/objects", body: INERT, resolvePublicKey: resolve, now, nonceCache: cache });
  assert.equal(second.ok, false);
  assert.match((second as { reason: string }).reason, /replay/);
});

test("canonicalRequest is method/path/body sensitive", () => {
  const a = canonicalRequest("POST", "/objects", "t", "n", "body");
  assert.notEqual(a, canonicalRequest("GET", "/objects", "t", "n", "body"));
  assert.notEqual(a, canonicalRequest("POST", "/finalize", "t", "n", "body"));
  assert.notEqual(a, canonicalRequest("POST", "/objects", "t", "n", "body2"));
});

// ── integration: a write-auth hub enforces the credential end-to-end ──

test("write-auth hub: writes require a valid member signature, reads stay public", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-tauth-"));
  const central = await Repo.init(dir);
  const root = generateKeypair();
  const member = generateKeypair();
  await central.registerMembership({ actorId: "ai:claude", publicKey: member.publicKey, role: "proposer", actorKind: "ai_agent", root: { keyId: "root", privateKey: root.privateKey } });

  const hub = await startHub({ repoDir: dir, port: 0, auth: { required: true } });
  try {
    // (read-public) GET /have needs no credential.
    const have = await fetch(`${hub.url}/have`);
    assert.equal(have.status, 200, "reads stay public");

    // (no credential) write is 401, NOT 403 — "who are you", not "you may not push this".
    let r = await postObjects(hub.url, INERT);
    assert.equal(r.status, 401);
    assert.match(String(r.body.error), /Authorization header/);

    // (non-member key) write is 401.
    const outsider = generateKeypair();
    const ghostHeader = buildAuthHeader({ keyId: "ai:ghost", privateKey: outsider.privateKey, method: "POST", path: "/objects", body: INERT });
    r = await postObjects(hub.url, INERT, ghostHeader);
    assert.equal(r.status, 401);
    assert.match(String(r.body.error), /unknown signing key/);

    // (valid member key) write is accepted.
    const goodHeader = buildAuthHeader({ keyId: "ai:claude", privateKey: member.privateKey, method: "POST", path: "/objects", body: INERT });
    r = await postObjects(hub.url, INERT, goodHeader);
    assert.equal(r.status, 200, "member-signed write accepted");

    // /version advertises the requirement so clients/old peers learn it up front.
    const ver = await (await fetch(`${hub.url}/version`)).json() as { auth: string; protocol: number };
    assert.equal(ver.auth, "required");
    assert.equal(ver.protocol, 2);
  } finally {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("D3: a pluggable resolver overrides membership for keyId→publicKey", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-tauth-hook-"));
  await Repo.init(dir); // no membership registered at all
  const ci = generateKeypair();
  // The embedder's own user DB authorizes "ci:bot" — the hub never sees a membership for it.
  const hub = await startHub({ repoDir: dir, port: 0, auth: { required: true, resolvePublicKey: async (k) => (k === "ci:bot" ? ci.publicKey : null) } });
  try {
    const header = buildAuthHeader({ keyId: "ci:bot", privateKey: ci.privateKey, method: "POST", path: "/objects", body: INERT });
    const r = await postObjects(hub.url, INERT, header);
    assert.equal(r.status, 200, "custom resolver authorizes a non-member principal");
  } finally {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── end-to-end: Repo.pushHub auto-discovers and uses the local actor key ──

test("Repo.pushHub: signs writes with the local actor key (--as / sole-key)", async () => {
  const hubDir = await mkdtemp(join(tmpdir(), "avcs-tauth-hub-"));
  const clientDir = await mkdtemp(join(tmpdir(), "avcs-tauth-cli-"));
  const central = await Repo.init(hubDir);
  const root = generateKeypair();
  const kp = generateKeypair();
  await central.registerMembership({ actorId: "ai:claude", publicKey: kp.publicKey, role: "proposer", actorKind: "ai_agent", root: { keyId: "root", privateKey: root.privateKey } });

  const client = await Repo.init(clientDir);
  await client.saveLocalKey("ai:claude", kp.privateKey); // the local ~/.ssh/id_ed25519 analogue
  await client.createIntent({ title: "push me", owner: "human:jaebin", kind: "feature" });

  const hub = await startHub({ repoDir: hubDir, port: 0, auth: { required: true } });
  try {
    // sole-key discovery: no --as needed, the one private key is the default identity.
    const r = await client.pushHub(hub.url);
    assert.ok(r.pushed >= 1, "objects pushed under transport auth");
    assert.equal(r.rejected, 0);

    // a client with no local key cannot satisfy a write-auth hub → loud 401.
    const anonDir = await mkdtemp(join(tmpdir(), "avcs-tauth-anon-"));
    const anon = await Repo.init(anonDir);
    await anon.createIntent({ title: "anon", owner: "human:x", kind: "feature" });
    await assert.rejects(() => anon.pushHub(hub.url), /unauthorized \(401\)/);
    await rm(anonDir, { recursive: true, force: true });
  } finally {
    await hub.close();
    await rm(hubDir, { recursive: true, force: true });
    await rm(clientDir, { recursive: true, force: true });
  }
});
