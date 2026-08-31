// Reading a hub with a token instead of a key.
//
// avcs has one credential model for hubs: an AVCS-Sig signature over the canonical
// request, made with the actor's private key. That fits a person or a long-lived
// machine, and it is the right default — the signature covers the method, so a
// captured GET credential cannot be replayed as a write.
//
// It does not fit an ephemeral reader. A CI job, a short-lived container, a sandbox
// that must clone a private repo and then disappear: giving it a signing key means
// provisioning (and later revoking) a member key per run, and putting a key that can
// sign *writes* into a process that only needs to read.
//
// git solved this with two transports, not one: keys over SSH, tokens over HTTPS.
// A token is what CI actually uses to clone — injected per run, scoped to one repo,
// expiring on its own. This adds that second shape for reads, and only for reads:
// `writeAuthHeaders` still requires a signature, so a token can never push an object,
// finalize a view, or change policy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeypair } from "../src/core/identity.ts";
import { readAuthHeaders, writeAuthHeaders, type HubSigner } from "../src/hub/hubClient.ts";

// A real keypair: `buildAuthHeader` actually signs, so a placeholder key makes the
// "a key wins" cases fail for the wrong reason.
const KP = generateKeypair();
const SIGNER: HubSigner = { keyId: "alice", privateKey: KP.privateKey };
const PUBLIC_KEY = KP.publicKey;

test("a read sends a bearer when there is no key", () => {
  const h = readAuthHeaders(undefined, "/have", "acme/web", "tok-abc");
  assert.equal(h["authorization"], "Bearer tok-abc");
});

test("a key still wins over a token", () => {
  // Both present is not ambiguous: the signature is the stronger credential (it covers
  // the method and the body), so a caller that has a key keeps using it. Preferring the
  // token would silently downgrade every existing signed reader that happens to run
  // with the env var set.
  const h = readAuthHeaders(SIGNER, "/have", "acme/web", "tok-abc");
  assert.ok(h["authorization"]?.startsWith("AVCS-Sig "), `got ${h["authorization"]}`);
});

test("no key and no token stays bare — a read-public hub is unaffected", () => {
  assert.deepEqual(readAuthHeaders(undefined, "/have", "acme/web", undefined), {});
});

test("an empty token is not a credential", () => {
  // An unset env var arrives as "" through a shell. Sending `Authorization: Bearer `
  // would turn a missing credential into a malformed one, and the hub's 400 would be
  // harder to read than the 401 it replaces.
  assert.deepEqual(readAuthHeaders(undefined, "/have", "acme/web", ""), {});
  assert.deepEqual(readAuthHeaders(undefined, "/have", "acme/web", "   "), {});
});

test("a keyless write carries no credential at all", () => {
  // The security boundary of this feature. `writeAuthHeaders` takes no token parameter —
  // the absence is the enforcement — so this pins that a keyless write stays bare even
  // with a token available in the environment, rather than silently borrowing it.
  const prev = process.env["AVCS_HUB_TOKEN"];
  process.env["AVCS_HUB_TOKEN"] = "tok-abc";
  try {
    const h = writeAuthHeaders(undefined, "POST", "/objects", "{}", "acme/web");
    assert.equal(h["authorization"], undefined, "a write must not carry a bearer token");
    assert.equal(h["content-type"], "application/json");
  } finally {
    if (prev === undefined) delete process.env["AVCS_HUB_TOKEN"];
    else process.env["AVCS_HUB_TOKEN"] = prev;
  }
});

test("a write still signs when a key is present", () => {
  const h = writeAuthHeaders(SIGNER, "POST", "/objects", "{}", "acme/web");
  assert.ok(h["authorization"]?.startsWith("AVCS-Sig "), `got ${h["authorization"]}`);
});

test("a token with a newline cannot inject a second header", () => {
  // Header injection: the value lands in an HTTP header, and the token comes from the
  // environment of whoever launched the process. CRLF in it must not be forwarded.
  for (const bad of ["abc\r\nX-Evil: 1", "abc\nX-Evil: 1", "abc\rdef"]) {
    assert.deepEqual(
      readAuthHeaders(undefined, "/have", "acme/web", bad),
      {},
      `a token containing a line break must be refused: ${JSON.stringify(bad)}`,
    );
  }
});

// ── The header actually goes out ──────────────────────────────────────────────
//
// The cases above assert which credential is *chosen*. That is not the same as it
// reaching the wire: the gap was that the client had no way to present a token at all,
// and a unit test on the header builder cannot see whether one reaches the wire.
// So drive the real read path (`pullFromHub`) against a stub that records what arrived.

test("a keyless read sends the bearer on the real client path", async () => {
  const { createServer } = await import("node:http");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Repo } = await import("../src/api/repo.ts");
  const { pullFromHub } = await import("../src/hub/hubClient.ts");

  const seen: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    // Refuse without the credential, the way a hub that gates reads does.
    if (req.headers.authorization !== "Bearer tok-123") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"unauthenticated"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url?.startsWith("/have") ? "[]" : "{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const dir = await mkdtemp(join(tmpdir(), "avcs-bearer-"));

  const prev = process.env["AVCS_HUB_TOKEN"];
  try {
    await Repo.init(dir);

    // No token: the read is bare and the hub refuses it.
    delete process.env["AVCS_HUB_TOKEN"];
    seen.length = 0;
    await pullFromHub(dir, url, undefined).catch(() => undefined);
    assert.ok(seen.length > 0, "the client made no request at all");
    assert.equal(seen[0], undefined, "a keyless, tokenless read must stay bare");

    // With the token: the credential arrives on the very first read.
    process.env["AVCS_HUB_TOKEN"] = "tok-123";
    seen.length = 0;
    await pullFromHub(dir, url, undefined).catch(() => undefined);
    assert.ok(seen.length > 0, "the client made no request at all");
    assert.equal(seen[0], "Bearer tok-123", "the bearer never reached the wire");
  } finally {
    if (prev === undefined) delete process.env["AVCS_HUB_TOKEN"];
    else process.env["AVCS_HUB_TOKEN"] = prev;
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

// ── A read is not always a GET ────────────────────────────────────────────────
//
// `POST /objects/fetch` asks for a list of objects by oid. It is a POST only because
// the oid list does not fit in a query string — it mutates nothing, and the reference
// server guards it as a read.
//
// Splitting the credential by HTTP method rather than by what the request DOES leaves
// that endpoint with no way to present a token, and a keyless clone dies partway:
// `GET /have` succeeds, then `POST /objects/fetch` returns 401. Measured against a
// real server before this case existed.

test("a read-shaped POST carries the bearer", () => {
  const h = readAuthHeaders(undefined, "/objects/fetch", "acme/web", "tok-abc", "POST");
  assert.equal(h["authorization"], "Bearer tok-abc");
  // The body is posted as JSON, so the caller still needs the content type from
  // `writeAuthHeaders`; this helper only supplies the credential.
});

test("a read-shaped POST still prefers a key", () => {
  const h = readAuthHeaders(SIGNER, "/objects/fetch", "acme/web", "tok-abc", "POST");
  assert.ok(h["authorization"]?.startsWith("AVCS-Sig "), `got ${h["authorization"]}`);
});

test("the signature over a read-shaped POST verifies AS a POST", async () => {
  // The signed material includes the method, so this is the case that actually matters:
  // a helper that hardcodes "GET" produces a header the server rejects when the request
  // goes out as POST. `parseAuthHeader` alone would not catch it — the header parses
  // either way. Only verification against the real method does.
  const { verifyAuth } = await import("../src/hub/transportAuth.ts");
  const body = '{"oids":["a"]}';
  // The body is part of the signed material, so it must be the body actually sent.
  const h = readAuthHeaders(SIGNER, "/objects/fetch", "acme/web", undefined, "POST", body);
  const ok = await verifyAuth({
    header: h["authorization"],
    method: "POST",
    path: "/objects/fetch",
    body,
    resolvePublicKey: async () => PUBLIC_KEY,
    now: Date.now(),
    expectedScope: "acme/web",
  });
  assert.equal(ok.ok, true, `a POST read must verify as a POST: ${JSON.stringify(ok)}`);
});
