// 적합성 · sync · governance · queue 레벨.
//
// core 는 "클론이 되는가" 였다. 위 셋은 능력 광고에 달려 있고, **광고하지 않으면 건너뛴다** —
// 부분 구현 서버가 1급 시민이라는 것이 프로토콜의 약속이므로(docs/26 §0), 스위트가 그것을
// 실패로 처리하면 약속을 어기는 쪽이 스위트가 된다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openTarget, type Target } from "./target.ts";

/** 이 레벨이 적용되지 않는 서버면 조용히 통과시킨다. 이유를 남긴다. */
async function requireLevel(t: Target, level: string): Promise<boolean> {
  const levels = await t.applicableLevels();
  if (!(levels as readonly string[]).includes(level)) {
    // 미적용은 실패가 아니다. 어떤 레벨까지 적용됐는지 남겨 CI 로그에서 읽을 수 있게 한다.
    console.log(`  (skip ${level}: 적용 레벨 = ${levels.join(", ") || "없음"})`);
    return false;
  }
  return true;
}

test("sync: GET /sync 가 oids 와 cursor 를 주고, 커서가 실제로 증분을 만든다", async () => {
  const t = await openTarget();
  try {
    if (!(await requireLevel(t, "sync"))) return;

    const first = await (await fetch(`${t.base}/sync?since=0`)).json() as { oids: string[]; cursor: number };
    assert.ok(Array.isArray(first.oids), "oids 는 배열이다");
    assert.equal(typeof first.cursor, "number", "cursor 는 수다");

    // 커서 뒤로 물으면 그 이후만 온다. 같은 커서로 다시 물으면 비어야 한다 —
    // 이것이 "증분" 의 뜻이고, 안 지키면 클라이언트가 매번 전량을 받는다.
    const again = await (await fetch(`${t.base}/sync?since=${first.cursor}`)).json() as { oids: string[]; cursor: number };
    assert.deepEqual(again.oids, [], "커서 이후에 추가된 것이 없으면 비어야 한다");
    assert.equal(again.cursor, first.cursor, "커서는 그대로다");

    // 범위를 벗어난 커서는 전량으로 떨어진다(docs/26 §4-2) — 정확성이 커서에 의존하지 않는다.
    const wild = await (await fetch(`${t.base}/sync?since=999999999`)).json() as { oids: string[] };
    assert.deepEqual(wild.oids, first.oids, "범위 밖 커서는 전량을 준다");
  } finally {
    await t.close();
  }
});

test("sync: POST /objects/fetch 는 없는 oid 를 조용히 빼고, 매 응답에 최소 하나를 담는다", async () => {
  const t = await openTarget();
  try {
    if (!(await requireLevel(t, "sync"))) return;

    const have = await (await fetch(`${t.base}/have`)).json() as string[];
    const missing = "intent_" + "0".repeat(32);
    const ask = [...have.slice(0, 3), missing];

    const res = await fetch(`${t.base}/objects/fetch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ oids: ask }),
    });
    assert.equal(res.status, 200);
    const j = await res.json() as { objects: { oid: string }[]; truncated?: boolean };
    assert.ok(Array.isArray(j.objects));
    assert.ok(!j.objects.some((o) => o.oid === missing), "없는 oid 는 에러가 아니라 누락이다");
    if (j.truncated === true) {
      assert.ok(j.objects.length > 0, "truncated 면 최소 하나는 담아야 한다 — 안 그러면 클라이언트가 진전 없음으로 포기한다");
    }
  } finally {
    await t.close();
  }
});

test("sync: 형태가 틀린 fetch 는 400 이다", async () => {
  const t = await openTarget();
  try {
    if (!(await requireLevel(t, "sync"))) return;
    const res = await fetch(`${t.base}/objects/fetch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nope: 1 }),
    });
    assert.equal(res.status, 400, "{ oids: [...] } 가 아니면 400 이다");
  } finally {
    await t.close();
  }
});

test("governance: GET /refs 는 { refs } 를 주고, 값은 oid 다", async () => {
  const t = await openTarget();
  try {
    if (!(await requireLevel(t, "governance"))) return;
    const j = await (await fetch(`${t.base}/refs`)).json() as { refs: Record<string, string> };
    assert.ok(j.refs && typeof j.refs === "object", "{ refs } 형태여야 한다");
    for (const [name, oid] of Object.entries(j.refs)) {
      assert.equal(typeof oid, "string", `${name} 의 값은 oid 문자열이다`);
      assert.match(oid, /^[a-z_]+_[0-9a-f]+$/, `${name} → ${oid} 가 oid 형태가 아니다`);
    }
  } finally {
    await t.close();
  }
});

test("queue: /integrate 가 없는 체크포인트를 422 로 거부한다", async () => {
  const t = await openTarget();
  try {
    if (!(await requireLevel(t, "queue"))) return;
    const res = await fetch(`${t.base}/integrate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: "main", checkpoint: "checkpoint_" + "0".repeat(32), by: "human:h" }),
    });
    // 게이트된 서버는 서명을 먼저 요구한다 — 그것도 프로토콜에 맞는 응답이다.
    if (res.status === 401 || res.status === 403) return;
    assert.equal(res.status, 422, "hub 에 없는 체크포인트는 rejected/422 다");
    const j = await res.json() as { verdict?: string };
    assert.equal(j.verdict, "rejected", "판정을 본문에도 담는다");
  } finally {
    await t.close();
  }
});

test("queue: /events 는 커서를 존중하고 하트비트를 준다", async () => {
  const t = await openTarget();
  try {
    if (!(await requireLevel(t, "queue"))) return;
    // 따라잡은 커서로 짧은 타임아웃을 주면 빈 목록 하트비트가 와야 한다.
    const sync = await (await fetch(`${t.base}/sync?since=0`)).json() as { cursor: number };
    const res = await fetch(`${t.base}/events?since=${sync.cursor}&timeoutMs=300`);
    assert.equal(res.status, 200);
    const j = await res.json() as { cursor: number; oids: string[]; refs?: unknown };
    assert.deepEqual(j.oids, [], "따라잡았으면 빈 목록이다");
    assert.equal(typeof j.cursor, "number");
    // 매 응답이 거버넌스 ref 전체를 담는다(docs/26 §6-3) — 객체 없이 head 만 움직여도 보이게.
    assert.ok(j.refs !== undefined, "응답에 refs 가 함께 와야 한다");
  } finally {
    await t.close();
  }
});
