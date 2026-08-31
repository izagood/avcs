// 골든 벡터 — 비-JS 구현이 자기 정규화를 검증할 통로.
//
// 명세 문장은 읽고 오해할 수 있다. 입력과 기대 oid 의 쌍은 오해를 실패로 바꿔 준다.
// 이 파일이 `spec/canonical-vectors.json` 을 **생성하지 않고 검증한다** — 생성하면
// 구현이 바뀔 때 벡터가 함께 따라가 버려서 아무것도 고정하지 못한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonicalize, computeOid, assertInteropSafe } from "../src/core/canonical.ts";

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
