// land 는 REF 로 기록되는데, ref 는 hub→client 한 방향으로만 흐른다 — `GET /refs` 가
// 거버넌스 ref 를 배포하고, 클라이언트는 ref 를 밀지 않는다(docs/26 §5). 거버넌스는 hub 가
// 권위이므로 그 방향이 맞지만, **land 는 `avcs land` 를 실행한 replica 가 authoring 한다.**
// 그래서 그 사실이 hub 에 닿을 길이 아예 없었다.
//
// 증상이 조용해서 나쁘다: 이름 배열을 담은 blob 은 일반 객체로 push 되어 hub 에 멀쩡히
// 있고, 그것을 가리키는 ref 만 못 간다. 받는 쪽은 landed 집합이 비어 있으니 그 workspace 의
// op 를 base view 에서 도로 걸러내고, **push 는 성공을 보고했는데 clone 은 land 이전 트리를
// 낸다.** 올릴 에러가 없어서 아무도 모른다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub } from "../src/hub/hubServer.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };

/** base op 하나 + workspace op 하나를 쓰고 그 workspace 를 land 한 replica. */
async function seedLanded(dir: string, workspace: string) {
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  await repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: ai,
    path: "base.txt", content: "base\n", declaredPurpose: "base",
  });
  await repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: ai,
    path: "ws.txt", content: "from ws\n", declaredPurpose: "ws", workspace,
  });
  await repo.landWorkspace(workspace);
  return repo;
}

test("land 한 workspace 는 hub 를 건너 clone 에서도 base view 에 남는다", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "avcs-landed-A-"));
  const dirB = await mkdtemp(join(tmpdir(), "avcs-landed-B-"));
  const dirHub = await mkdtemp(join(tmpdir(), "avcs-landed-hub-"));
  const hub = await startHub({ repoDir: dirHub, port: 0 });
  try {
    const A = await seedLanded(dirA, "feature");
    const want = await A.materialize("main");
    assert.deepEqual(await A.landedWorkspaces(), ["feature"]);
    await A.pushHub(hub.url);

    const B = await Repo.init(dirB);
    await B.pullHub(hub.url);

    // 이것이 계약이다 — 같은 op 집합이면 같은 트리다. land 사실이 안 건너오면 여기서 갈린다.
    const got = await B.materialize("main");
    assert.deepEqual(await B.landedWorkspaces(), ["feature"], "landed 집합이 건너와야 한다");
    assert.equal(got.treeHash, want.treeHash, "같은 트리를 내야 한다");

    const files = (await B.materializedFiles(got)).map((f) => f.path).sort();
    assert.deepEqual(files, ["base.txt", "ws.txt"], "land 된 workspace 의 파일이 보여야 한다");
  } finally {
    await hub.close();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
    await rm(dirHub, { recursive: true, force: true });
  }
});

// land 는 추가 전용이고 unland 는 없다(docs/16 §5). 그래서 두 집합을 합치는 것이 언제나
// 안전하고, 그 성질이 CAS 없이도 수렴을 보장한다 — 도착 순서가 결과를 바꾸지 않는다.
test("landed 집합은 합집합이다 — 양쪽이 서로 다른 workspace 를 land 해도 잃지 않는다", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "avcs-landed-uA-"));
  const dirB = await mkdtemp(join(tmpdir(), "avcs-landed-uB-"));
  const dirHub = await mkdtemp(join(tmpdir(), "avcs-landed-uhub-"));
  const hub = await startHub({ repoDir: dirHub, port: 0 });
  try {
    const A = await seedLanded(dirA, "wsA");
    await A.pushHub(hub.url);

    const B = await seedLanded(dirB, "wsB");
    await B.pushHub(hub.url);          // hub 는 이제 둘 다 알아야 한다
    await B.pullHub(hub.url);
    assert.deepEqual(await B.landedWorkspaces(), ["wsA", "wsB"], "pull 이 로컬 land 를 지우면 안 된다");

    await A.pullHub(hub.url);
    assert.deepEqual(await A.landedWorkspaces(), ["wsA", "wsB"], "A 도 B 의 land 를 받아야 한다");
  } finally {
    await hub.close();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
    await rm(dirHub, { recursive: true, force: true });
  }
});

// land 한 적이 없는 replica 는 POST 를 보내지 않는다. 빈 집합을 밀어 hub 를 건드릴 이유가 없다.
test("land 이 없으면 아무것도 바꾸지 않는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-landed-none-"));
  const dirHub = await mkdtemp(join(tmpdir(), "avcs-landed-nonehub-"));
  const hub = await startHub({ repoDir: dirHub, port: 0 });
  try {
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "t", owner: human.id });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    await repo.proposeFileWrite({
      sessionOid: sess, intentOid: intent, actor: ai,
      path: "a.txt", content: "a\n", declaredPurpose: "a",
    });
    await repo.pushHub(hub.url);
    await repo.pullHub(hub.url);
    assert.deepEqual(await repo.landedWorkspaces(), [], "빈 채로 남아야 한다");
  } finally {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
    await rm(dirHub, { recursive: true, force: true });
  }
});
