// 저자화 경로의 fsync 증폭 (#33 의 유력 원인, #55 성능 조사의 3번째 자리).
//
// commitWorkingTree 는 파일마다 blob put + op put + 인덱스 append 를 직렬로 돈다 —
// 부하 없는 로컬에서 100파일 커밋 4.69초(파일당 ~47ms) 실측. avcs 훅은 워킹트리 전체를
// 스테이징하므로 수백 op 커밋이 흔하고, 부하가 겹치면 pre-commit ingest 30초(#33)가 된다.
//
// store.batched(fn): fn 안의 put/appendEntityIndex 는 메모리에 스테이징되고, fn 이 끝나면
// putMany 의 group-commit 으로 한 번에 내구화된다. 반환 시점의 내구성은 이전과 같고,
// fn 중간의 크래시는 부분 커밋 대신 **깨끗한 no-op** 이 된다 — 오히려 낫다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStore } from "../src/store/objectStore.ts";
import type { AnyObject } from "../src/objects/types.ts";

function op(i: number): AnyObject {
  return {
    type: "operation", lamport: i, path: `f${i}.ts`, declaredPurpose: `w${i}`,
    actor: { kind: "human", id: "human:h" }, causalDeps: [], createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
  } as unknown as AnyObject;
}

async function fresh(): Promise<{ dir: string; store: ObjectStore }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-bat-"));
  const store = new ObjectStore(dir);
  await store.init();
  return { dir, store };
}

test("batched 안의 put 은 즉시 읽힌다 — read-your-writes", async () => {
  const { dir, store } = await fresh();
  try {
    await store.batched(async () => {
      const oid = await store.put(op(1) as never);
      assert.equal(await store.has(oid), true, "스테이징된 것도 has 로 보여야 한다");
      const back = await store.get(oid);
      assert.equal((back as { declaredPurpose?: string }).declaredPurpose, "w1", "get 도 스테이징을 서빙해야 한다");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("batched 가 끝나면 순차 put 과 같은 상태다", async () => {
  const a = await fresh();
  const b = await fresh();
  try {
    const objs = [op(1), op(2), op(3)];
    for (const o of objs) await a.store.put(o as never);
    for (const [k, oid] of [["file:f1.ts", "operation_" + "1".repeat(32)]] as [string, string][]) {
      await a.store.appendEntityIndex(k, oid);
    }

    await b.store.batched(async () => {
      for (const o of objs) await b.store.put(o as never);
      await b.store.appendEntityIndex("file:f1.ts", "operation_" + "1".repeat(32));
    });

    assert.deepEqual(await b.store.readObjLog(), await a.store.readObjLog(), "objlog 동일");
    assert.deepEqual(await b.store.readOpLog(), await a.store.readOpLog(), "oplog 동일");
    assert.deepEqual(await b.store.readEntityIndex("file:f1.ts"), await a.store.readEntityIndex("file:f1.ts"));
  } finally {
    await rm(a.dir, { recursive: true, force: true });
    await rm(b.dir, { recursive: true, force: true });
  }
});

test("fn 이 던지면 아무것도 디스크에 남지 않는다 — 부분 커밋 대신 no-op", async () => {
  const { dir, store } = await fresh();
  try {
    let staged = "";
    await assert.rejects(
      store.batched(async () => {
        staged = await store.put(op(7) as never);
        throw new Error("중간 실패");
      }),
      /중간 실패/,
    );
    assert.equal(await store.has(staged), false, "스테이징은 디스크에 닿지 않았어야 한다");
    assert.equal((await store.readObjLog()).length, 0, "objlog 도 비어 있어야 한다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("batched 밖에서는 put 이 예전 그대로 즉시 내구화된다", async () => {
  const { dir, store } = await fresh();
  try {
    const oid = await store.put(op(1) as never);
    // 새 스토어 핸들(같은 디렉터리)로 읽힌다 = 디스크에 실재한다.
    const other = new ObjectStore(dir);
    assert.equal(await other.has(oid), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("중첩 batched 는 거부한다 — 조용히 평탄화하면 바깥 배치의 원자성 가정이 깨진다", async () => {
  const { dir, store } = await fresh();
  try {
    await assert.rejects(
      store.batched(async () => { await store.batched(async () => {}); }),
      /nested|batched/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readOpLog/readObjLog 도 스테이징을 본다 — 로그 파생 읽기의 read-your-writes", async () => {
  // contention() 의 closure 가 #allOpsTailed ← readOpLog 로 "내 op" 를 찾는다. 배치의
  // 스테이징이 여기 안 보이면 내가 딛고 선 op 이 남의 것처럼 보여 허위 경고가 난다 —
  // contention-across-lines.test.ts 가 batched 첫 출하에서 실제로 잡았다.
  const { dir, store } = await fresh();
  try {
    await store.batched(async () => {
      const oid = await store.put(op(1) as never);
      assert.ok((await store.readOpLog()).includes(oid), "oplog 읽기에 스테이징이 보여야 한다");
      assert.ok((await store.readObjLog()).includes(oid), "objlog 도 마찬가지");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
