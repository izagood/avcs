// 정규화가 언어 중립인가 — 비-JS 구현이 같은 oid 를 낼 수 있는가.
//
// oid 는 정규 JSON 의 sha256 이다(저장은 CBOR 이지만 oid 는 JSON 파생). 그 정규화에
// **JS 고유 동작**이 셋 들어 있고, 각각 다른 언어에서 다르게 나올 수 있다:
//
//   숫자   `JSON.stringify(n)` = ECMAScript Number::toString. 1.0 → "1", 1e21 → "1e+21".
//          Python `repr` 도 Go `strconv` 도 이것과 다른 경우가 있다.
//   키정렬 `keys.sort()` 는 **UTF-16 코드유닛** 순이다. astral 문자(emoji 등)에서
//          코드포인트 순과 갈린다 — surrogate pair 의 상위 유닛이 U+E000..U+FFFF 보다 작다.
//   문자열 `JSON.stringify(s)` 의 이스케이프 집합과 lone surrogate 처리.
//
// 갈리면 **오류가 나지 않고 수렴하지 않는다.** 서버는 가진 것을 정직하게 답하고
// 클라이언트는 없는 것을 정직하게 요청하는데 영원히 만나지 않는다.
//
// 실측: 지금 저장된 객체(로컬 15,680 + hub 평면 14,073, 스칼라 필드 200만+)에 위반이 0이다.
// 그래서 상호운용 안전 부분집합으로 좁히는 것은 **현재 상태를 기술하는 일**이다.
//
// 다만 위반이 0인 이유는 막혀 있어서가 아니라 아직 아무도 쓰지 않았기 때문이다 —
// `custom:<name>` evidence(4-2 에서 열었다)가 `Checkpoint.evidence` 의 **객체 키**가 되므로
// 사용자가 이름 지은 문자열이 해시 대상의 키로 들어간다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, computeOid } from "../src/core/canonical.ts";
import { assertInteropSafe } from "../src/core/canonical.ts";

// ── ① 키 정렬: UTF-16 ≠ 코드포인트 ────────────────────────────────────────────
test("astral 키가 있으면 정렬 순서가 언어에 따라 갈린다 — 거부해야 한다", () => {
  // U+1F680 ROCKET 은 surrogate pair D83D DE80. UTF-16 정렬에서 D83D 는 U+E000 보다
  // 작으므로 "" 앞에 오지만, 코드포인트 정렬에서는 U+1F680 > U+E000 이라 뒤에 온다.
  const obj = { "\u{1F680}deploy": 1, "x": 2 };
  const utf16First = Object.keys(obj).sort()[0];
  const codePointFirst = [...Object.keys(obj)].sort((a, b) => {
    const ai = [...a].map((c) => c.codePointAt(0)!);
    const bi = [...b].map((c) => c.codePointAt(0)!);
    for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
      const d = (ai[i] ?? -1) - (bi[i] ?? -1);
      if (d !== 0) return d;
    }
    return 0;
  })[0];
  assert.notEqual(
    utf16First, codePointFirst,
    "이 픽스처가 두 정렬을 실제로 갈라놓아야 테스트가 의미를 갖는다",
  );

  assert.throws(
    () => assertInteropSafe(obj),
    /astral|key/i,
    "두 정렬이 갈리는 키를 통과시키면 oid 가 구현마다 달라진다",
  );
});

// ── ② 숫자: 정수만 ──────────────────────────────────────────────────────────
test("정수가 아닌 수는 거부한다 — 부동소수 표기가 언어마다 다르다", () => {
  for (const bad of [1.5, 0.1, -2.75, 1e-7]) {
    assert.throws(() => assertInteropSafe({ n: bad }), /integer|number/i, `${bad} 를 통과시키면 안 된다`);
  }
});

test("안전 정수 범위와 지수 표기 경계를 벗어난 수도 거부한다", () => {
  for (const bad of [2 ** 53, -(2 ** 53), 1e21, 1e300]) {
    assert.throws(() => assertInteropSafe({ n: bad }), /integer|range|number/i, `${bad} 를 통과시키면 안 된다`);
  }
});

// ── ③ 문자열: lone surrogate ────────────────────────────────────────────────
test("lone surrogate 를 거부한다 — 유효한 텍스트에서는 나올 수 없다", () => {
  assert.throws(() => assertInteropSafe({ s: "a\uD800b" }), /surrogate/i);
  assert.throws(() => assertInteropSafe({ "k\uDC00": 1 }), /surrogate/i);
});

// ── ④ NFC: 같은 글자가 다른 바이트 ──────────────────────────────────────────
test("NFC 가 아닌 키를 거부한다 — 같은 글자가 두 oid 를 만든다", () => {
  const composed = "é";        // é
  const decomposed = "é";     // e + combining acute
  assert.notEqual(composed, decomposed, "두 표현이 실제로 달라야 한다");
  assert.equal(composed.normalize("NFC"), decomposed.normalize("NFC"), "…그리고 NFC 로 같아야 한다");
  assert.throws(() => assertInteropSafe({ [decomposed]: 1 }), /NFC|normal/i);
  assert.doesNotThrow(() => assertInteropSafe({ [composed]: 1 }), "합성형은 통과해야 한다");
});

// ── 회귀 방지: 실제 객체 모양은 그대로 통과한다 ──────────────────────────────
test("실제 avcs 객체 모양은 통과한다 — 부분집합이 현재를 기술한다", () => {
  // 실측에서 위반 0 이었던 모양들. 여기서 막히면 부분집합이 너무 좁은 것이다.
  const real = {
    type: "operation",
    lamport: 42,
    path: "packages/api/src/routes/hubRoutes.ts",
    declaredPurpose: "한글 목적 문장 · emoji 값은 허용된다 🚀",
    causalDeps: ["operation_ab12", "operation_cd34"],
    evidence: { unit_test: "pass", "custom:deploy": "pass" },
    nested: { a: [1, 2, { b: null }] },
  };
  assert.doesNotThrow(() => assertInteropSafe(real));
  assert.equal(typeof canonicalize(real), "string");
  assert.match(computeOid("operation", real), /^operation_[0-9a-f]+$/);
});

test("값(키가 아닌)의 astral 문자는 허용한다 — 파일 경로·커밋 메시지가 그렇다", () => {
  // 값은 정렬 대상이 아니므로 UTF-16 문제가 없다. 막으면 정상 사용을 깨뜨린다.
  assert.doesNotThrow(() => assertInteropSafe({ msg: "배포 완료 🚀", path: "docs/이름.md" }));
});
