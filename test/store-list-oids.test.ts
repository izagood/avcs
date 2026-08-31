// oid 만 필요한 자리가 객체 전량을 읽고 디코드한다 (#55 성능 조사에서 실측).
//
// `/have` 는 oid 목록만 답하는데 `store.list()` 를 쓴다 — list 는 모든 객체 파일을 읽어
// CBOR/JSON 디코드해 통째로 yield 한다. oid 는 이미 **파일명**인데도. 그래서 변화 없는
// 재-sync(push 협상의 GET /have)가 저장소 크기에 비례한다:
//
//   208객체 283ms · 808객체 584ms · 3,208객체 3,534ms   (~1ms/객체)
//
// 도그푸딩 저장소(39k 객체)면 재-sync 마다 ~40초다. watch 데몬은 이것을 주기마다 돈다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };

async function seeded(n: number): Promise<{ dir: string; repo: Repo }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-oids-"));
  const repo = await Repo.init(dir);
  for (let i = 0; i < n; i++) {
    const intent = await repo.createIntent({ title: `w${i}`, owner: human.id });
    const sess = await repo.startSession({ intentOid: intent, actor: human });
    await repo.proposeFileWrite({
      sessionOid: sess, intentOid: intent, actor: human,
      path: `f${i}.ts`, content: `v${i}\n`, declaredPurpose: `w${i}`,
    });
  }
  return { dir, repo };
}

test("listOids 는 list 가 yield 하는 것과 같은 집합을 준다", async () => {
  const { dir, repo } = await seeded(6);
  try {
    const fromList: string[] = [];
    for await (const o of repo.store.list()) fromList.push(o.oid as string);
    const oids = await repo.store.listOids();
    assert.deepEqual([...oids].sort(), fromList.sort(), "집합이 갈리면 push 협상이 객체를 놓치거나 중복 전송한다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listOids 는 pack 된 객체도 포함한다", async () => {
  // list() 는 loose + pack 을 합친다. oid 목록도 같아야 한다 — pack 은 읽기 최적화이지
  // 집합 변화가 아니다.
  const { dir, repo } = await seeded(5);
  try {
    const before = await repo.store.listOids();
    const packed = await repo.store.pack();
    assert.ok(packed.packed > 0, "pack 이 실제로 일어나야 이 테스트가 의미를 갖는다");
    const after = await repo.store.listOids();
    assert.deepEqual([...after].sort(), [...before].sort(), "pack 전후로 집합이 같아야 한다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listOids 는 객체 본문을 읽지 않는다 — 손상된 파일이 있어도 목록은 나온다", async () => {
  // "디코드하지 않는다" 를 직접 재는 방법: 본문이 깨진 객체를 하나 두면, 디코드하는 구현은
  // 던지고 파일명 기반 구현은 그대로 나열한다. (list() 는 여기서 던진다 — 그것이 대조군.)
  const { dir, repo } = await seeded(3);
  try {
    const oids = await repo.store.listOids();
    const victim = [...oids][0]!;
    const { writeFileSync } = await import("node:fs");
    const shard = victim.split("_")[1]!.slice(0, 2);
    writeFileSync(join(dir, ".avcs", "objects", shard, `${victim}.json`), "not an object");

    const again = await repo.store.listOids();
    assert.ok(again.includes(victim), "본문을 읽지 않으므로 손상과 무관하게 나열된다");

    await assert.rejects(async () => {
      for await (const _ of repo.store.list()) void _;
    }, "대조군: list() 는 디코드하므로 여기서 던진다 — 안 던지면 이 테스트가 아무것도 재지 않는 것");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
