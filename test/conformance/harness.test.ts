// 적합성 스위트의 하네스 — **부착 지점**이 계약이다.
//
// 지금 hub 테스트 14개는 `startHub()` 를 직접 부른다. 그건 "참조 구현이 맞게 동작하는가" 를
// 재는 것이고, 제3자가 "내 서버가 호환인가" 를 물을 방법이 없다.
//
// 다만 14개를 그대로 옮길 수는 없다. 7개는 서버 옵션(`gated`·`auth`·`rateLimit`·
// `resolvePublicKey`)을 켜고 끄며 검증하므로 외부 URL 로는 불가능하다 — 그건 참조 서버의
// **옵션**을 재는 테스트이고 프로토콜을 재는 게 아니다. 적합성 스위트는 14개의 변환이 아니라
// **프로토콜 관측 가능한 것만의 부분집합**이다.
//
// 그래서 하네스의 계약은 둘이다:
//   ① URL 을 받으면 그 서버를 잰다.
//   ② 안 받으면 참조 구현을 띄워 잰다 — 그래야 기존 커버리지가 그대로 유지되고,
//      스위트 자체가 CI 에서 계속 검증된다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openTarget, LEVELS, type Level } from "./target.ts";

test("URL 을 주면 그 서버를 잰다 — 참조 구현을 띄우지 않는다", async () => {
  const t = await openTarget({ url: "http://127.0.0.1:9/acme/web" });
  try {
    assert.equal(t.base, "http://127.0.0.1:9/acme/web");
    assert.equal(t.spawned, false, "URL 을 줬으면 서버를 띄워선 안 된다");
  } finally {
    await t.close();
  }
});

test("URL 이 없으면 참조 구현을 띄운다 — 기존 커버리지가 유지된다", async () => {
  // 이 자기검증은 "URL 없음" 조건 자체를 재므로 env 기본값을 명시적으로 끈다 — 스위트를
  // AVCS_CONFORMANCE_URL 로 외부 서버에 돌리면 env 가 여기까지 주입되어 자기모순이 된다.
  // 실제로 첫 외부 실행(제3 구현)이 이 버그를 찾았다.
  const saved = process.env.AVCS_CONFORMANCE_URL;
  delete process.env.AVCS_CONFORMANCE_URL;
  const t = await openTarget();
  if (saved !== undefined) process.env.AVCS_CONFORMANCE_URL = saved;
  try {
    assert.equal(t.spawned, true, "URL 이 없으면 참조 구현을 띄워야 한다");
    assert.match(t.base, /^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await fetch(`${t.base}/have`);
    assert.equal(r.status, 200, "띄운 서버가 실제로 응답해야 한다");
  } finally {
    await t.close();
  }
});

test("레벨은 누적이다 — 상위가 하위를 포함한다", () => {
  assert.deepEqual(LEVELS, ["core", "sync", "governance", "queue"]);
  // 누적이 아니면 "queue 통과" 가 "core 통과" 를 뜻하지 않게 되고, 배지가 의미를 잃는다.
  const idx = (l: Level): number => LEVELS.indexOf(l);
  assert.ok(idx("core") < idx("sync"));
  assert.ok(idx("sync") < idx("governance"));
  assert.ok(idx("governance") < idx("queue"));
});

test("서버가 광고하지 않는 능력의 레벨은 건너뛴다 — 실패가 아니다", async () => {
  // 부분 구현 서버가 1급 시민이라는 것이 프로토콜의 약속이다(docs/26 §0). 스위트가 그것을
  // 실패로 처리하면 약속을 어기는 쪽이 스위트가 된다.
  // "참조 구현은 전부 켜져 있다" 를 재므로 env 주입을 끈다 (위 테스트와 같은 이유).
  const saved = process.env.AVCS_CONFORMANCE_URL;
  delete process.env.AVCS_CONFORMANCE_URL;
  const t = await openTarget();
  if (saved !== undefined) process.env.AVCS_CONFORMANCE_URL = saved;
  try {
    const caps = await t.capabilities();
    assert.equal(typeof caps.batch, "boolean");
    assert.equal(typeof caps.integrate, "boolean");
    // 참조 구현은 전부 켜져 있으므로 어느 레벨도 건너뛰지 않는다.
    assert.deepEqual(await t.applicableLevels(), LEVELS);
  } finally {
    await t.close();
  }
});

test("능력을 광고하지 않는 서버는 상위 레벨이 적용 대상에서 빠진다", async () => {
  // /version 이 없는 서버를 흉내낸다 — 클라이언트가 모든 능력을 off 로 가정하는 그 상황.
  const t = await openTarget({ url: "http://127.0.0.1:9", capabilitiesOverride: {} });
  try {
    assert.deepEqual(
      await t.applicableLevels(), ["core"],
      "능력 광고가 없으면 core 만 적용된다 — 나머지는 실패가 아니라 미적용이다",
    );
  } finally {
    await t.close();
  }
});
