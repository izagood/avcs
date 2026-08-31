// 이벤트 기반 대기 (issue #55).
//
// `until` 은 폴링이고, 폴링은 두 실패를 구분하지 못한다: "조건이 거짓" 과 "조건을 평가할 틈이
// 없었다". #55 는 `minPolls` 로 후자를 걸러냈고 그건 옳았다. 그런데 최근 실패 로그는
// **160 polls / 8001ms** 다 — 160번 평가했으니 틈은 있었고, 조건이 8초간 진짜로 거짓이었다.
//
// 원인은 굶주림이 아니라 작업량이다. `AVCS_VERIFY_INCREMENTAL=1` 에서 전체 reduce 가 비싸므로
// watch 주기(2초) 자체가 느려지고, 4주기 안에 못 끝나면 실패한다. 예산을 늘리면 같은 결함이
// 더 드물어질 뿐이고, 진짜 실패도 그만큼 늦어진다.
//
// 근본은 **기다리는 방식**이다. `runSyncWatch` 는 이미 `onEvent` 콜백을 준다. 조건이 충족되는
// 순간 콜백에서 깨우면 몇 주기가 걸리든 무관해지고, 타임아웃은 진짜 hang 에만 쓰인다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collector } from "./collect.ts";

test("이미 도착한 이벤트에 즉시 resolve 한다", async () => {
  const c = collector<{ n: number }>();
  c.push({ n: 1 });
  c.push({ n: 2 });
  await c.waitFor((e) => e.n === 2, { label: "n=2" });
  assert.deepEqual(c.all.map((e) => e.n), [1, 2], "모은 것은 그대로 읽을 수 있다");
});

test("나중에 도착해도 깨운다 — 폴링 간격을 기다리지 않는다", async () => {
  const c = collector<{ n: number }>();
  const t0 = Date.now();
  setTimeout(() => c.push({ n: 7 }), 20);
  await c.waitFor((e) => e.n === 7, { label: "n=7" });
  // 폴링이면 최소 간격(50ms)을 기다린다. 이벤트 기반이면 도착 즉시다.
  assert.ok(Date.now() - t0 < 50, `도착 즉시 깨어나야 한다 — ${Date.now() - t0}ms 걸렸다`);
});

test("여러 대기자를 함께 깨운다", async () => {
  const c = collector<{ n: number }>();
  const a = c.waitFor((e) => e.n === 3, { label: "a" });
  const b = c.waitFor((e) => e.n === 3, { label: "b" });
  c.push({ n: 3 });
  await Promise.all([a, b]);
});

test("조건에 안 맞는 이벤트로는 깨지 않는다", async () => {
  const c = collector<{ n: number }>();
  let settled = false;
  const p = c.waitFor((e) => e.n === 99, { label: "n=99", timeoutMs: 200 }).then(
    () => { settled = true; },
    () => { settled = true; },
  );
  c.push({ n: 1 });
  c.push({ n: 2 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false, "맞지 않는 이벤트가 대기를 끝내면 안 된다");
  await p;
});

test("타임아웃은 진짜 hang 에만 쓰이고, 무엇을 기다렸는지 말한다", async () => {
  const c = collector<{ n: number }>();
  c.push({ n: 1 });
  await assert.rejects(
    () => c.waitFor((e) => e.n === 99, { label: "n=99", timeoutMs: 100 }),
    (e: unknown) => {
      const m = String((e as Error).message);
      assert.match(m, /n=99/, "라벨이 있어야 한다");
      assert.match(m, /1 event/, `본 이벤트 수를 말해야 한다 — got: ${m}`);
      return true;
    },
  );
});

test("타임아웃 후에는 대기자를 남기지 않는다 — 프로세스가 매달리지 않게", async () => {
  const c = collector<{ n: number }>();
  await assert.rejects(() => c.waitFor((e) => e.n === 99, { label: "x", timeoutMs: 50 }));
  assert.equal(c.pending, 0, "타임아웃된 대기자가 남으면 나중 push 가 죽은 promise 를 깨운다");
});
