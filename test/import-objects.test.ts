// 객체를 in-process 로 들여오기 (우회 감사 ⑤의 코어 절반).
//
// 코어가 "객체를 받는" 통로를 **HTTP 하나만** 두었다. 그래서 자기 안에 이미 객체를 들고 있는
// 소비자 — 저장소 서비스가 그렇다 — 는 자기 자신에게 HTTP 를 건다. 루프백 하나를 세우고,
// 그것을 감출 비밀 라우트를 만들고, 그 라우트가 새는지 지키는 코드를 또 만든다.
//
// 비용이 성능만이 아니다. 그 루프백 주소를 알 수 없는 상황(포트 미확정, 소켓 없음)이 곧
// "객체를 못 받는다" 가 되고, 그것이 통합 제출에서 `rejected` 로 나타난다 — 정책 판정이
// 아닌 것이 정책 판정의 얼굴을 하고 나온다.
//
// 그래서 여는 것은 통로 하나다. `pullHub` 이 하는 일에서 **HTTP 만 걷어낸 것**이어야 한다 —
// 저장, 연산 인덱싱, Lamport 전진, redaction 적용까지 똑같이. 하나라도 빠지면 소비자는
// 그 빠진 것을 다시 밖에서 만들게 되고, 처음 문제로 돌아간다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor, AnyObject, Operation } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };

/** A repo with `n` writes, plus every object it holds. */
async function seeded(n: number): Promise<{ dir: string; repo: Repo; objects: AnyObject[] }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-src-"));
  const repo = await Repo.init(dir);
  let prev: string | undefined;
  for (let i = 0; i < n; i++) {
    const intent = await repo.createIntent({ title: `w${i}`, owner: human.id });
    const sess = await repo.startSession({ intentOid: intent, actor: human });
    prev = await repo.proposeFileWrite({
      sessionOid: sess, intentOid: intent, actor: human,
      path: `f${i}.ts`, content: `v${i}\n`, declaredPurpose: `w${i}`,
      ...(prev ? { causalDeps: [prev] } : {}),
    });
  }
  const objects: AnyObject[] = [];
  for (const oid of await repo.store.readObjLog()) objects.push(await repo.store.get(oid));
  return { dir, repo, objects };
}

test("importObjects 로 들여온 저장소가 원본과 같은 트리를 낸다", async () => {
  const src = await seeded(3);
  const dstDir = await mkdtemp(join(tmpdir(), "avcs-dst-"));
  try {
    const dst = await Repo.init(dstDir);
    const r = await dst.importObjects(src.objects);

    assert.ok(r.imported > 0, "무언가는 들어와야 한다");
    const want = await src.repo.materialize("main");
    const got = await dst.materialize("main");
    assert.equal(got.treeHash, want.treeHash, "treeHash 가 같아야 한다 — 이것이 계약이다");
  } finally {
    await rm(src.dir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
  }
});

// `pullHub` 이 하는 부수 작업들. 하나라도 빠지면 소비자가 밖에서 다시 만들게 된다.
test("연산 인덱스가 함께 만들어진다 — blame·history 가 그것으로 답한다", async () => {
  const src = await seeded(2);
  const dstDir = await mkdtemp(join(tmpdir(), "avcs-dst-idx-"));
  try {
    const dst = await Repo.init(dstDir);
    await dst.importObjects(src.objects);

    const hist = await dst.historyOf("file:f0.ts");
    assert.ok(hist.length > 0, "엔티티 인덱스가 없으면 history 가 비어 나온다");
  } finally {
    await rm(src.dir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
  }
});

test("Lamport 시계가 들여온 히스토리 뒤로 전진한다", async () => {
  // 이게 빠지면 들여온 뒤 저자화한 op 이 과거에 끼어들어 순서가 뒤집힌다.
  const src = await seeded(3);
  const dstDir = await mkdtemp(join(tmpdir(), "avcs-dst-lam-"));
  try {
    const dst = await Repo.init(dstDir);
    await dst.importObjects(src.objects);

    const maxIn = Math.max(
      ...src.objects.filter((o) => o.type === "operation").map((o) => (o as Operation).lamport),
    );
    const intent = await dst.createIntent({ title: "after", owner: human.id });
    const sess = await dst.startSession({ intentOid: intent, actor: human });
    const opOid = await dst.proposeFileWrite({
      sessionOid: sess, intentOid: intent, actor: human,
      path: "after.ts", content: "x\n", declaredPurpose: "after",
    });
    const op = await dst.store.get<Operation>(opOid);
    assert.ok(op.lamport > maxIn, `들여온 최대(${maxIn}) 뒤여야 한다 — got ${op.lamport}`);
  } finally {
    await rm(src.dir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
  }
});

test("이미 있는 객체는 다시 세지 않는다 — 반복 호출이 안전하다", async () => {
  const src = await seeded(2);
  const dstDir = await mkdtemp(join(tmpdir(), "avcs-dst-twice-"));
  try {
    const dst = await Repo.init(dstDir);
    const first = await dst.importObjects(src.objects);
    const second = await dst.importObjects(src.objects);

    assert.ok(first.imported > 0);
    assert.equal(second.imported, 0, "두 번째는 새로 들어온 것이 없다");
    assert.equal(second.skipped, first.imported, "대신 건너뛴 것으로 센다");
  } finally {
    await rm(src.dir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
  }
});

// 위조 내성. **거부가 아니라 재계산이다** — 이게 더 강한 성질이다. 거부는 판단이 필요하고
// 판단은 틀릴 수 있지만, 주소를 내용에서 다시 계산하는 것은 판단이 없다. HTTP 통로가 이미
// 그렇게 한다("lands it at its own oid rather than poisoning ours"). in-process 통로가
// 신뢰 경계가 가깝다고 이걸 건너뛰면 content-addressing 이 무너진다.
test("위조된 객체는 원본 자리를 차지하지 못한다", async () => {
  const src = await seeded(1);
  const dstDir = await mkdtemp(join(tmpdir(), "avcs-dst-forge-"));
  try {
    const dst = await Repo.init(dstDir);
    const original = src.objects.find((o) => o.type === "operation") as Operation;
    const originalOid = original.oid as string;
    const forged = { ...original, declaredPurpose: "위조" };

    await dst.importObjects([forged as AnyObject]);

    // 원본 주소에는 아무것도 없다 — 위조본이 그 자리를 뺏지 못했다.
    assert.equal(await dst.store.has(originalOid), false, "위조본이 원본 oid 를 차지하면 안 된다");

    // 그리고 원본을 들여오면 원본 자리에 정확히 앉는다.
    await dst.importObjects([original as AnyObject]);
    const back = await dst.store.get<Operation>(originalOid);
    assert.equal(back.declaredPurpose, original.declaredPurpose);
  } finally {
    await rm(src.dir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
  }
});
