// verifyAuth: 하나의 keyId(=actor)가 여러 등록 키를 가질 수 있다(계정-전역 키).
// resolvePublicKey 가 배열을 주면, 서명한 그 키를 찾을 때까지 후보를 시도한다 —
// nonce·신선도·scope 는 한 번만 검사한다(키마다 반복하면 두 번째부터 replay 로 막힌다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAuthHeader, verifyAuth, NonceCache } from "../src/hub/transportAuth.ts";
import { generateKeypair } from "../src/core/identity.ts";

const BODY = JSON.stringify({ type: "intent", title: "x" });

test("resolvePublicKey 가 후보 배열을 주면 서명한 키로 성공한다 — 순서 무관", async () => {
  const signer = generateKeypair();
  const other1 = generateKeypair();
  const other2 = generateKeypair();
  const header = buildAuthHeader({ keyId: "human:h", privateKey: signer.privateKey, method: "POST", path: "/objects", body: BODY });

  // 서명 키가 배열 가운데 있다 — 첫째도 마지막도 아니게 둔다.
  const res = await verifyAuth({
    header, method: "POST", path: "/objects", body: BODY, now: Date.now(),
    resolvePublicKey: async () => [other1.publicKey, signer.publicKey, other2.publicKey],
  });
  assert.deepEqual(res, { ok: true, keyId: "human:h" });
});

test("후보 중 아무 것도 서명과 안 맞으면 실패한다", async () => {
  const signer = generateKeypair();
  const other = generateKeypair();
  const header = buildAuthHeader({ keyId: "human:h", privateKey: signer.privateKey, method: "POST", path: "/objects", body: BODY });
  const res = await verifyAuth({
    header, method: "POST", path: "/objects", body: BODY, now: Date.now(),
    resolvePublicKey: async () => [other.publicKey],
  });
  assert.equal(res.ok, false);
});

test("빈 배열은 unknown key 다 (등록된 키 없음)", async () => {
  const signer = generateKeypair();
  const header = buildAuthHeader({ keyId: "human:h", privateKey: signer.privateKey, method: "POST", path: "/objects", body: BODY });
  const res = await verifyAuth({
    header, method: "POST", path: "/objects", body: BODY, now: Date.now(),
    resolvePublicKey: async () => [],
  });
  assert.equal(res.ok, false);
});

test("다중 후보에서도 nonce 는 한 번만 소비된다 — 실패 후보가 nonce 를 태우지 않는다", async () => {
  const signer = generateKeypair();
  const other = generateKeypair();
  const nonceCache = new NonceCache();
  const header = buildAuthHeader({ keyId: "human:h", privateKey: signer.privateKey, method: "POST", path: "/objects", body: BODY });
  // 서명 키를 뒤에 둬서 앞 후보가 먼저 실패하게 한다. 그래도 첫 요청은 성공해야 하고,
  // 같은 헤더 재전송만 replay 로 막혀야 한다.
  const first = await verifyAuth({
    header, method: "POST", path: "/objects", body: BODY, now: Date.now(), nonceCache,
    resolvePublicKey: async () => [other.publicKey, signer.publicKey],
  });
  assert.equal(first.ok, true);
  const replay = await verifyAuth({
    header, method: "POST", path: "/objects", body: BODY, now: Date.now(), nonceCache,
    resolvePublicKey: async () => [other.publicKey, signer.publicKey],
  });
  assert.equal(replay.ok, false);
});

test("scope 결속: 다중 후보에서도 sig·bsig 를 같은 키로 검증한다", async () => {
  const signer = generateKeypair();
  const other = generateKeypair();
  const header = buildAuthHeader({ keyId: "human:h", privateKey: signer.privateKey, method: "POST", path: "/objects", body: BODY, scope: "/acme/web" });
  const res = await verifyAuth({
    header, method: "POST", path: "/objects", body: BODY, now: Date.now(), expectedScope: "/acme/web",
    resolvePublicKey: async () => [other.publicKey, signer.publicKey],
  });
  assert.deepEqual(res, { ok: true, keyId: "human:h" });
});

test("단일 문자열 반환은 종전과 동일하게 동작한다 (하위호환)", async () => {
  const signer = generateKeypair();
  const header = buildAuthHeader({ keyId: "human:h", privateKey: signer.privateKey, method: "POST", path: "/objects", body: BODY });
  const res = await verifyAuth({
    header, method: "POST", path: "/objects", body: BODY, now: Date.now(),
    resolvePublicKey: async () => signer.publicKey,
  });
  assert.deepEqual(res, { ok: true, keyId: "human:h" });
});
