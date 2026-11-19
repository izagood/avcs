// 골든 벡터 — 비-JS 구현이 자기 정규화를 검증할 통로.
//
// 명세 문장은 읽고 오해할 수 있다. 입력과 기대 oid 의 쌍은 오해를 실패로 바꿔 준다.
// 이 파일이 `spec/canonical-vectors.json` 을 **생성하지 않고 검증한다** — 생성하면
// 구현이 바뀔 때 벡터가 함께 따라가 버려서 아무것도 고정하지 못한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { Buffer } from "node:buffer";
import { canonicalize, computeOid, assertInteropSafe } from "../src/core/canonical.ts";
import { signMessage, verifyMessage, publicKeyFromPrivate } from "../src/core/identity.ts";
import { buildAuthHeader, canonicalRequest } from "../src/hub/transportAuth.ts";

const VECTORS = fileURLToPath(new URL("../spec/canonical-vectors.json", import.meta.url));

interface Vector {
  name: string;
  note: string;
  type: string;
  payload: Record<string, unknown>;
  canonical: string;
  oid: string;
}
interface Rejected {
  name: string;
  note: string;
  payload: unknown;
}

test("골든 벡터의 정규 문자열과 oid 가 그대로 나온다", async () => {
  const { accepted } = JSON.parse(await readFile(VECTORS, "utf8")) as { accepted: Vector[] };
  assert.ok(accepted.length >= 8, `벡터가 너무 적다 (${accepted.length}) — 정렬·숫자·유니코드를 덮어야 한다`);
  for (const v of accepted) {
    assert.doesNotThrow(() => assertInteropSafe(v.payload), `${v.name}: 허용 벡터가 거부됐다`);
    assert.equal(canonicalize(v.payload), v.canonical, `${v.name}: 정규 문자열이 다르다`);
    assert.equal(computeOid(v.type, v.payload), v.oid, `${v.name}: oid 가 다르다`);
  }
});

// lone surrogate 는 벡터 파일에 담을 수 없다 — 정의상 유효한 UTF-8 이 아니어서 파일 형식이
// 그것을 표현하지 못한다(파일에 넣으려다 쓰기가 실패해 파일이 0바이트가 되는 것을 실측했다).
// 그래서 코드에서 직접 만든다. 다른 언어 구현도 같은 제약을 만나므로 명세에 적어 뒀다.
test("lone surrogate 는 파일이 아니라 코드에서 검증한다", () => {
  assert.throws(() => assertInteropSafe({ s: "a\uD800b" }), /surrogate/i);
  assert.throws(() => assertInteropSafe({ "k\uDC00": 1 }), /surrogate/i);
});

test("거부 벡터는 전부 거부된다", async () => {
  const { rejected } = JSON.parse(await readFile(VECTORS, "utf8")) as { rejected: Rejected[] };
  assert.ok(rejected.length >= 4, `거부 벡터가 너무 적다 (${rejected.length})`);
  for (const r of rejected) {
    assert.throws(() => assertInteropSafe(r.payload), `${r.name}: 거부돼야 하는데 통과했다`);
  }
});

// 벡터가 실제로 위험한 지점을 덮는지. 이 테스트가 없으면 "8개 있다" 는 숫자만 지킨다.
// 벡터 파일 자체를 검증한다. 유니코드 예시는 편집기·셸·언어 런타임이 조용히 고칠 수 있어
// "NFD 벡터" 라고 적힌 것이 실제로 NFC 인 일이 생긴다 — 이 파일에서 실제로 그랬다.
test("거부 벡터가 주장하는 형태를 실제로 갖는다", async () => {
  const { rejected } = JSON.parse(await readFile(VECTORS, "utf8")) as { rejected: Rejected[] };
  const keyOf = (r: Rejected): string => Object.keys(r.payload as Record<string, unknown>)[0] ?? "";
  const nfd = rejected.find((r) => r.name === "nfd-key");
  assert.ok(nfd, "nfd-key 벡터가 있어야 한다");
  const nk = keyOf(nfd);
  assert.notEqual(nk.normalize("NFC"), nk, "nfd-key 가 NFC 로 적혀 있으면 아무것도 재지 못한다");

  const astral = rejected.find((r) => r.name === "astral-key");
  assert.ok(astral, "astral-key 벡터가 있어야 한다");
  assert.match(keyOf(astral), /[\u{10000}-\u{10FFFF}]/u, "astral 문자가 실제로 있어야 한다");
});

test("벡터가 세 위험 지점을 실제로 덮는다", async () => {
  const raw = await readFile(VECTORS, "utf8");
  const { accepted } = JSON.parse(raw) as { accepted: Vector[] };
  const canon = accepted.map((v) => v.canonical).join("\n");

  // ① 키 정렬이 자명하지 않은 경우 — 대문자/소문자/숫자/밑줄이 섞여야 한다
  assert.ok(
    accepted.some((v) => Object.keys(v.payload).length >= 4),
    "키 4개 이상인 벡터가 있어야 정렬 규칙이 드러난다",
  );
  // ② 음수·0·큰 정수
  assert.match(canon, /-\d/, "음수를 덮는 벡터가 없다");
  assert.match(canon, /:0[,}]/, "0 을 덮는 벡터가 없다");
  // ③ 비-ASCII 값과 이스케이프
  assert.ok(/[^\x00-\x7F]/.test(canon), "비-ASCII 값을 덮는 벡터가 없다");
  assert.match(canon, /\\n|\\"|\\\\/, "이스케이프가 필요한 문자열 벡터가 없다");
});

// ── 유니코드 키 정렬 — UTF-16 인가 코드포인트인가 (R0) ──────────────────────────
// 참조 구현의 `canonicalize` 는 `Array.prototype.sort()` 로 키를 정렬한다 = UTF-16 코드유닛 순.
// 명세는 "코드포인트 순" 이다. 둘은 BMP 안에서 같고 astral 키에서만 갈린다. 그러니 명세가
// 참이려면 두 사실이 함께 서야 한다: ① BMP 높은 키 벡터가 통과한다 ② astral 키는 관문에서 거부된다.
test("BMP 높은 키는 UTF-16 순과 코드포인트 순이 같다 — bmp-key-order 벡터가 실제로 높은 키를 쓴다", async () => {
  const { accepted } = JSON.parse(await readFile(VECTORS, "utf8")) as { accepted: Vector[] };
  const v = accepted.find((x) => x.name === "bmp-key-order");
  assert.ok(v, "bmp-key-order 벡터가 있어야 한다");
  const keys = Object.keys(v.payload);
  assert.ok(keys.some((k) => k.codePointAt(0)! >= 0xe000), "U+E000 이상 키가 있어야 astral 경계 바로 아래를 잰다");
  assert.ok(keys.some((k) => k.codePointAt(0)! >= 0xac00 && k.codePointAt(0)! <= 0xd7a3), "한글 키가 있어야 한다");
  const utf16 = [...keys].sort();
  const cp = [...keys].sort((a, b) => (a.codePointAt(0)! - b.codePointAt(0)!));
  assert.deepEqual(utf16, cp, "BMP 안에서는 두 정렬이 같아야 한다");
});

test("참조 canonicalize 는 UTF-16 순이다 — 그래서 astral 키는 관문에서 거부돼야 한다", async () => {
  const { rejected } = JSON.parse(await readFile(VECTORS, "utf8")) as { rejected: Rejected[] };
  const min = rejected.find((r) => r.name === "astral-key-min");
  assert.ok(min, "astral-key-min 벡터가 있어야 한다");
  // 관문 없이 부르면 U+10000 이 U+E000 앞에 온다(UTF-16). 코드포인트 순이면 뒤다.
  assert.equal(canonicalize(min.payload), '{"\u{10000}":2,"":1}', "참조 구현의 실제 정렬이 바뀌었다 — 명세(docs/24 §3)와 다시 맞춰야 한다");
  assert.throws(() => assertInteropSafe(min.payload), /astral/);
  for (const name of ["astral-key-cjk", "astral-key-nested"]) {
    const r = rejected.find((x) => x.name === name);
    assert.ok(r, `${name} 벡터가 있어야 한다`);
    assert.match(JSON.stringify(r.payload), /[\u{10000}-\u{10FFFF}]/u, `${name} 에 astral 문자가 실제로 있어야 한다`);
  }
});

// ── 서명 벡터 ───────────────────────────────────────────────────────────────────
/** 벡터의 seed 로 키 파일과 같은 PKCS#8 PEM 을 만든다 — 개인키 PEM 을 파일에 싣지 않기 위해. */
function privatePemOf(k: SigVectors["key"]): string {
  const der = Buffer.from(k.pkcs8DerPrefixHex + k.seedHex, "hex");
  return `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----\n`;
}

interface SigVectors {
  key: { seedHex: string; publicHex: string; pkcs8DerPrefixHex: string; publicPem: string };
  messages: { name: string; message: string; sig?: string; sigHex?: string }[];
  transport: {
    name: string; keyId: string; method: string; path: string; body: string; ts: string; nonce: string; scope: string;
    canonicalRequest: string; canonicalRequestScoped: string; header: string;
  }[];
}

test("서명 벡터 — 키 유도가 RFC 8032 TEST 1 과 같다", async () => {
  const { signatures: s } = JSON.parse(await readFile(VECTORS, "utf8")) as { signatures: SigVectors };
  const pem = privatePemOf(s.key);
  // node 가 내보내는 PEM 과 바이트까지 같아야 한다 — 그래야 seed 로 만든 PEM 이 키 파일 형식이다.
  assert.equal(createPrivateKey(pem).export({ format: "pem", type: "pkcs8" }), pem);
  assert.equal(publicKeyFromPrivate(pem), s.key.publicPem, "개인키 PEM(PKCS#8)에서 공개키 PEM(SPKI)이 복원돼야 한다");
  const der = createPrivateKey(pem).export({ format: "der", type: "pkcs8" });
  assert.equal(der.subarray(-32).toString("hex"), s.key.seedHex, "PKCS#8 안의 seed 가 벡터와 같아야 한다");
  const spki = createPublicKey(s.key.publicPem).export({ format: "der", type: "spki" });
  assert.equal(spki.subarray(-32).toString("hex"), s.key.publicHex);
});

test("서명 벡터 — 오브젝트 oid 서명이 바이트까지 같고 검증된다", async () => {
  const raw = JSON.parse(await readFile(VECTORS, "utf8")) as { signatures: SigVectors; accepted: Vector[] };
  const s = raw.signatures;
  assert.ok(s.messages.length >= 2);
  for (const m of s.messages) {
    const got = signMessage(privatePemOf(s.key), m.message);
    const want = m.sig ?? Buffer.from(m.sigHex!, "hex").toString("base64");
    assert.equal(got, want, `${m.name}: 서명이 다르다`);
    assert.ok(verifyMessage(s.key.publicPem, m.message, want), `${m.name}: 검증돼야 한다`);
    assert.ok(!verifyMessage(s.key.publicPem, m.message + "x", want), `${m.name}: 다른 메시지로는 검증되면 안 된다`);
  }
  const obj = s.messages.find((m) => m.name === "object-oid");
  const realOp = raw.accepted.find((v) => v.name === "real-op");
  assert.equal(obj?.message, realOp?.oid, "object-oid 는 real-op 의 oid 를 서명해야 벡터끼리 이어진다");
});

test("서명 벡터 — 허브 요청 서명(AVCS-Sig) 헤더가 바이트까지 같다", async () => {
  const { signatures: s } = JSON.parse(await readFile(VECTORS, "utf8")) as { signatures: SigVectors };
  assert.ok(s.transport.length >= 1);
  for (const t of s.transport) {
    assert.equal(canonicalRequest(t.method, t.path, t.ts, t.nonce, t.body), t.canonicalRequest, `${t.name}: 정규 요청`);
    assert.equal(canonicalRequest(t.method, t.path, t.ts, t.nonce, t.body, t.scope), t.canonicalRequestScoped, `${t.name}: scope 붙은 정규 요청`);
    const header = buildAuthHeader({
      keyId: t.keyId, privateKey: privatePemOf(s.key), method: t.method, path: t.path,
      body: t.body, ts: t.ts, nonce: t.nonce, scope: t.scope,
    });
    assert.equal(header, t.header, `${t.name}: 헤더가 다르다`);
  }
});
