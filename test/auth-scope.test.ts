// Binding a transport-auth credential to the repository it was meant for (issue #49).
//
// `canonicalRequest` covers method, path, timestamp, nonce and body hash — but the path a
// client signs is the ENDPOINT SUFFIX ("/objects"), because the reference hub sits at the
// root. Nothing in the signed material says WHICH repository the write was for, so on a
// hub that serves many repositories under a path prefix, a credential captured for repo A
// is structurally valid for repo B inside the freshness window.
//
// Signing the full request path instead would bind it, but couples the signature to the
// server's mount layout and breaks under ordinary path-rewriting proxies — which is the
// same coupling that made the suffix necessary in the first place.
//
// So the binding is an explicit, optional `scope`: the client states the repository it
// believes it is addressing, that string is signed, and a hub that cares compares it with
// the repository it resolved. Absent scope verifies exactly as before, so the reference
// hub and every existing client are unaffected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeypair } from "../src/core/identity.ts";
import { buildAuthHeader, parseAuthHeader, verifyAuth } from "../src/hub/transportAuth.ts";

const kp = generateKeypair();
const resolvePublicKey = async (): Promise<string> => kp.publicKey;
const base = { keyId: "ai:a", privateKey: kp.privateKey, method: "POST", path: "/objects", body: "{}" };

test("a scoped credential verifies against the scope it names", async () => {
  const header = buildAuthHeader({ ...base, scope: "/acme/web" });
  const r = await verifyAuth({
    header, method: "POST", path: "/objects", body: "{}",
    resolvePublicKey, now: Date.now(), expectedScope: "/acme/web",
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
});

test("a credential for one repository does not verify against another", async () => {
  // The whole point: replaying repo A's write at repo B must fail even though the key,
  // method, path, body and freshness window are all still valid.
  const header = buildAuthHeader({ ...base, scope: "/acme/web" });
  const r = await verifyAuth({
    header, method: "POST", path: "/objects", body: "{}",
    resolvePublicKey, now: Date.now(), expectedScope: "/acme/other",
  });
  assert.equal(r.ok, false);
  assert.match(String(r.ok ? "" : r.reason), /scope/i);
});

test("a hub that expects a scope refuses a credential that carries none", async () => {
  const header = buildAuthHeader(base); // unscoped, as an older client would send
  const r = await verifyAuth({
    header, method: "POST", path: "/objects", body: "{}",
    resolvePublicKey, now: Date.now(), expectedScope: "/acme/web",
  });
  assert.equal(r.ok, false, "an unscoped credential cannot satisfy a scoped expectation");
});

test("a hub that expects no scope is unaffected by either kind of credential", async () => {
  // The reference hub serves one repository at the root and has no scope to compare, so
  // both shapes must keep working there — this is what makes the change additive.
  for (const scope of [undefined, "/acme/web"]) {
    const header = buildAuthHeader(scope ? { ...base, scope } : base);
    const r = await verifyAuth({
      header, method: "POST", path: "/objects", body: "{}",
      resolvePublicKey, now: Date.now(),
    });
    assert.equal(r.ok, true, `scope=${String(scope)}: ${r.ok ? "" : r.reason}`);
  }
});

test("the scope is part of the signature, not just a header field", async () => {
  // Tampering with the transmitted scope must fail rather than silently re-target the
  // credential — otherwise the binding is decoration.
  const header = buildAuthHeader({ ...base, scope: "/acme/web" });
  const tampered = header.replace('scope="/acme/web"', 'scope="/acme/other"');
  assert.notEqual(tampered, header, "the header carries the scope");
  const r = await verifyAuth({
    header: tampered, method: "POST", path: "/objects", body: "{}",
    resolvePublicKey, now: Date.now(), expectedScope: "/acme/other",
  });
  assert.equal(r.ok, false, "a rewritten scope breaks the signature");
});

test("parseAuthHeader surfaces the scope, and its absence, without guessing", async () => {
  assert.equal(parseAuthHeader(buildAuthHeader({ ...base, scope: "/acme/web" }))?.scope, "/acme/web");
  assert.equal(parseAuthHeader(buildAuthHeader(base))?.scope, undefined);
});

test("an empty scope is treated as no scope, so a rootless remote signs as before", async () => {
  // A remote like `https://hub.example` has no path component; the client derives "" and
  // that must not become a scope nobody can satisfy.
  const header = buildAuthHeader({ ...base, scope: "" });
  const r = await verifyAuth({
    header, method: "POST", path: "/objects", body: "{}",
    resolvePublicKey, now: Date.now(),
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
});

test("an OLD verifier — one that does not know about scope — still accepts a scoped credential", async () => {
  // The compatibility that actually matters, and the one the earlier tests did not cover:
  // a deployed hub running a previous avcs reconstructs canonicalRequest WITHOUT scope. If
  // the client folds scope into the signed material unconditionally, every such hub starts
  // rejecting every request — which is what happened against a live deployment.
  const header = buildAuthHeader({ ...base, scope: "/acme/web" });
  const cred = parseAuthHeader(header)!;
  const { canonicalRequest } = await import("../src/hub/transportAuth.ts");
  const { verifyMessage } = await import("../src/core/identity.ts");
  // Exactly what an older verifier computes: five lines, no scope.
  const oldMaterial = canonicalRequest("POST", "/objects", cred.ts, cred.nonce, "{}");
  assert.equal(
    verifyMessage(kp.publicKey, oldMaterial, cred.sig),
    true,
    "a scoped credential must still verify under a scope-unaware verifier",
  );
});
