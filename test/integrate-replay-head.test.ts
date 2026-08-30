// 티켓 재제출이 head 를 잃어버린다 (우회 감사 ③).
//
// `submitIntegration` 은 같은 `ticketId` 로 다시 불리면 이전 판정을 그대로 재생한다. 재제출은
// 예외적 상황이 아니라 정상 경로다 — 네트워크 재시도, 에이전트 재시도, 잡 재실행이 전부 여기로
// 온다. 그런데 fast-forward 로 advance 한 티켓은 감사 레코드에 `resultCheckpoint` 를 남기지
// 않는다(`resultIsSubmitted` 이면 `undefined`). 재생 경로는 그 필드를 `!` 로 단언하므로,
// 타입은 `string` 인데 값은 `undefined` 가 흘러나온다.
//
// 소비자 한 곳은 이걸 다섯 줄로 막아 뒀다. 코어를 직접 쓰는 나머지는 그대로 맞는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };

async function author(repo: Repo, path: string, content: string): Promise<string> {
  const intent = await repo.createIntent({ title: `write ${path}`, owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  return repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: ai, path, content, declaredPurpose: `write ${path}`,
  });
}

test("fast-forward 로 advance 한 티켓을 재제출해도 head 가 온다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-replay-"));
  try {
    const repo = await Repo.init(dir);
    await author(repo, "a.ts", "A\n");
    const cp = await repo.createCheckpoint("main", "A");

    const first = await repo.submitIntegration({ view: "main", checkpoint: cp, by: "human:h", ticketId: "t1" });
    assert.equal(first.verdict, "advanced");
    assert.ok(first.head, "첫 제출은 당연히 head 를 준다");

    // 같은 티켓. 재시도한 클라이언트가 보는 것.
    const replay = await repo.submitIntegration({ view: "main", checkpoint: cp, by: "human:h", ticketId: "t1" });

    assert.equal(replay.verdict, "advanced");
    assert.equal(typeof replay.head, "string", `head 는 문자열이어야 한다 — got ${replay.head}`);
    assert.equal(replay.head, first.head, "그리고 처음과 같은 체크포인트여야 한다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 재생된 head 가 **맞는** 체크포인트인지. 위 테스트는 "문자열이 온다"만 보므로, 아무 값이나
// 채워 넣는 고침도 통과시킨다. 재생의 계약은 "그때 그 판정을 그대로" 이므로 재생된 head 는 지금
// 보호 헤드와 같아야 한다.
//
// (원래 이 자리에 "재저자화 경로" 회귀 가드를 두려 했으나, 같은 라인의 후속 체크포인트는 이전
//  헤드를 인과 폐포에 담으므로 그것도 fast-forward 다 — 같은 결함을 두 번 재는 테스트였다.
//  재저자화 경로는 `resultCheckpoint` 를 실제로 기록하므로 애초에 이 결함과 무관하다.)
test("재생된 head 는 지금 보호 헤드와 같다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-replay-2-"));
  try {
    const repo = await Repo.init(dir);
    await author(repo, "a.ts", "A\n");
    const cp = await repo.createCheckpoint("main", "A");
    await repo.submitIntegration({ view: "main", checkpoint: cp, by: "human:h", ticketId: "t1" });
    const head = await repo.protectedHead("main");

    const replay = await repo.submitIntegration({ view: "main", checkpoint: cp, by: "human:h", ticketId: "t1" });

    assert.equal(replay.verdict, "advanced");
    assert.equal(
      replay.verdict === "advanced" ? replay.head : null,
      head,
      "재생은 그때 그 판정을 그대로 돌려줘야 한다",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
