// ingest 의 fsync 증폭 (#55 성능 조사).
//
// 객체 하나 저장 = writeAtomic(fsync 2) + objlog append(2) + 연산이면 oplog(2), pull 은
// 엔티티 인덱스(2)까지 — 직렬 fsync 4~6회. macOS 에서 한 번이 수~수십 ms 라 전송이
// 객체당 ~25ms 로 측정됐다(1,602객체 push = 145초, CPU 프로파일 98.4% idle — 전부 I/O 대기).
//
// putMany 는 배치의 fsync 를 묶는다: 본문은 병렬로 내구화하고, oplog·objlog 는 청크당
// 한 번씩 追記한다. **순서가 계약이다** — oplog 는 리듀서가 믿고 읽으므로 본문이 내구화된
// 뒤에만 追記한다(기존 put 의 "AFTER the object is durable" 그대로). 크래시 창은 청크
// 크기로 bound 된다.
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
function intent(i: number): AnyObject {
  return { type: "intent", title: `t${i}`, owner: "human:h", status: "open", createdAt: new Date(2026, 0, 2, 0, 0, i).toISOString() } as unknown as AnyObject;
}

async function fresh(): Promise<{ dir: string; store: ObjectStore }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-pm-"));
  const store = new ObjectStore(dir);
  await store.init();
  return { dir, store };
}

test("putMany 는 순차 put 과 같은 oid·objlog·oplog 를 만든다", async () => {
  const a = await fresh();
  const b = await fresh();
  try {
    const objs = [op(1), intent(1), op(2), intent(2), op(3)];
    const seq: string[] = [];
    for (const o of objs) seq.push(await a.store.put(o as never));
    const many = await b.store.putMany(objs as never[]);

    assert.deepEqual(many.map((r) => r.oid), seq, "oid 가 같아야 한다 — 내용주소이므로 갈리면 버그");
    assert.deepEqual(await b.store.readObjLog(), await a.store.readObjLog(), "objlog 내용·순서가 같아야 한다");
    assert.deepEqual(await b.store.readOpLog(), await a.store.readOpLog(), "oplog 내용·순서가 같아야 한다");
    for (const oid of seq) assert.ok(await b.store.has(oid));
  } finally {
    await rm(a.dir, { recursive: true, force: true });
    await rm(b.dir, { recursive: true, force: true });
  }
});

test("이미 있는 객체는 건너뛰고 existed 로 표시한다 — 로그에 중복 줄을 만들지 않는다", async () => {
  const { dir, store } = await fresh();
  try {
    const first = await store.putMany([op(1), intent(1)] as never[]);
    assert.deepEqual(first.map((r) => r.existed), [false, false]);

    const again = await store.putMany([op(1), op(9), intent(1)] as never[]);
    assert.deepEqual(again.map((r) => r.existed), [true, false, true], "섞여 있어도 각자 판정된다");
    assert.equal(again[0]!.oid, first[0]!.oid);

    const log = await store.readObjLog();
    assert.equal(new Set(log).size, log.length, "readObjLog 는 dedup 하므로 같으면 원본 파일에도 중복이 없다는 뜻");
    assert.equal(log.length, 3, "새로 들어온 3개만 로그에 있다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("putMany 도 oid 를 주장이 아니라 내용에서 계산한다", async () => {
  const { dir, store } = await fresh();
  try {
    const forged = { ...op(1), oid: "operation_" + "f".repeat(32) };
    const [r] = await store.putMany([forged as never]);
    assert.notEqual(r!.oid, forged.oid, "주장한 oid 에 착지하면 원본을 오염시킬 수 있다");
    assert.equal(r!.oid, await new ObjectStore(dir).put(op(1) as never), "내용에서 나온 주소여야 한다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendEntityIndexMany 는 per-key 호출과 같은 인덱스를 만든다", async () => {
  const a = await fresh();
  const b = await fresh();
  try {
    const entries: [string, string][] = [
      ["file:x.ts", "operation_" + "1".repeat(32)],
      ["file:y.ts", "operation_" + "2".repeat(32)],
      ["file:x.ts", "operation_" + "3".repeat(32)],
    ];
    for (const [k, o] of entries) await a.store.appendEntityIndex(k, o);
    await b.store.appendEntityIndexMany(entries);
    for (const k of ["file:x.ts", "file:y.ts"]) {
      assert.deepEqual(
        await b.store.readEntityIndex(k), await a.store.readEntityIndex(k),
        `${k}: 같은 키의 항목 순서까지 같아야 한다 — blame 이 이 순서를 읽는다`,
      );
    }
  } finally {
    await rm(a.dir, { recursive: true, force: true });
    await rm(b.dir, { recursive: true, force: true });
  }
});

test("putMany 도 상호운용 관문을 지난다 — put 만 지키면 우회 있는 검사다", async () => {
  const { dir, store } = await fresh();
  try {
    await assert.rejects(
      () => store.putMany([{ type: "evidence", "\u{1F680}": 1 } as never]),
      /astral|interop/i,
      "putMany 가 assertInteropSafe 를 건너뛰면 docs/24 의 관문이 뚫린다",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
