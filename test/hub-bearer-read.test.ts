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
const SIGNER: HubSigner = { keyId: "alice", privateKey: generateKeypair().privateKey };

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
