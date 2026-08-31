// 부분집합이 **저자화 경로에 실제로 선다**는 것. 검사 함수가 있어도 아무도 부르지 않으면
// 문서와 다를 게 없다 — 이 프로그램에서 정확히 그런 결함(주입되지 않은 훅)을 두 번 봤다.
//
// 가장 중요한 자리는 `custom:<name>` evidence 다. 그 이름이 `Checkpoint.evidence` 의
// **객체 키**가 되므로 사용자 입력이 해시 대상의 키로 들어간다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor, EvidenceKind } from "../src/objects/types.ts";

const ci: Actor = { kind: "ci_bot", id: "ci:runner" };
const human: Actor = { kind: "human", id: "human:h" };

async function seeded(): Promise<{ dir: string; repo: Repo; op: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-canon-"));
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: human });
  const op = await repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: human,
    path: "a.ts", content: "x\n", declaredPurpose: "seed",
  });
  return { dir, repo, op };
}

// `kind` 는 Evidence 객체 안에서는 **값**이므로 `attachEvidence` 는 통과한다 — 그게 맞다.
// 키가 되는 곳은 체크포인트를 만들 때다(`evidence[ev.kind] = ev.result`). 그래서 위반은
// evidence 부착이 아니라 **그 evidence 를 담은 checkpoint 를 저장할 때** 걸려야 한다.
// 처음에 부착 시점을 겨눴다가 이 구조를 확인하고 고쳤다.
test("astral 이름의 evidence 를 담은 체크포인트는 저장되지 않는다", async () => {
  const { dir, repo, op } = await seeded();
  try {
    await repo.attachEvidence({
      forOps: [op], kind: "custom:\u{1F680}deploy" as EvidenceKind, result: "pass", producedBy: ci,
    });
    await assert.rejects(
      () => repo.createCheckpoint("main", "with astral evidence key"),
      /astral|interop/i,
      "이 체크포인트의 oid 는 구현마다 갈린다 — 저장되면 안 된다",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NFC 가 아닌 이름의 evidence 도 체크포인트에서 걸린다", async () => {
  const { dir, repo, op } = await seeded();
  try {
    await repo.attachEvidence({
      forOps: [op], kind: ("custom:" + "배포".normalize("NFD")) as EvidenceKind,
      result: "pass", producedBy: ci,
    });
    await assert.rejects(
      () => repo.createCheckpoint("main", "with NFD evidence key"),
      /NFC|normal|interop/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 회귀 방지: 정상 이름은 그대로 통과한다. 이 둘이 없으면 위 두 테스트는 "전부 거부한다" 로도
// 초록이 된다.
test("평범한 custom 이름은 통과한다", async () => {
  const { dir, repo, op } = await seeded();
  try {
    const oid = await repo.attachEvidence({
      forOps: [op], kind: "custom:deploy" as EvidenceKind, result: "pass", producedBy: ci,
    });
    assert.match(oid, /^evidence_/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("한글·이모지가 든 값은 그대로 통과한다 — 값은 정렬 대상이 아니다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-canon-val-"));
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "배포 준비 🚀", owner: human.id });
    const sess = await repo.startSession({ intentOid: intent, actor: human });
    const op = await repo.proposeFileWrite({
      sessionOid: sess, intentOid: intent, actor: human,
      path: "docs/이름.md", content: "내용 🚀\n", declaredPurpose: "한글 목적 🚀",
    });
    assert.match(op, /^operation_/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 마지막 방어선: 어떤 경로로 들어와도 저장 시점에 걸린다.
test("store.put 이 최종 관문이다 — 우회 경로가 있어도 여기서 걸린다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-canon-put-"));
  try {
    const repo = await Repo.init(dir);
    await assert.rejects(
      () => repo.store.put({ type: "evidence", "🚀": 1 } as never),
      /astral|interop/i,
      "저자화 API 를 우회해 직접 put 하는 경로가 열려 있으면 부분집합이 보장이 아니다",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
