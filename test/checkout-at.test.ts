// 체크포인트를 지정한 체크아웃 (우회 감사 ②).
//
// 잡은 "트리거된 그 트리" 에서 돌아야 한다. 그런데 코어가 시점을 지정할 방법을 주지 않아
// 소비자는 **현재 head 를 체크아웃**했다. 트리거와 클레임 사이에 head 가 전진하면 잡은 다른
// 트리를 검사하고, 그 결과가 evidence 로 원래 체크포인트에 결속된다 —
// `Protection.requireBoundEvidence` 가 그 위에 선다.
//
// 즉 이건 편의 기능이 아니다. **검증하지 않은 트리에 증거가 결속되는** 자리다.
//
// 저장 계층은 이미 시점 지정을 할 수 있다 — `materializeAt(cp.headOps)` 가 그것이고
// `checkpointBytes` 가 이미 그렇게 쓴다. 물리적 체크아웃만 그 통로가 없었다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import type { Actor } from "../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };

async function write(repo: Repo, path: string, content: string, after?: string): Promise<string> {
  const intent = await repo.createIntent({ title: path, owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: human });
  return repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: human, path, content, declaredPurpose: path,
    ...(after ? { causalDeps: [after] } : {}),
  });
}

test("checkoutInto(dir, view, { at }) 는 그 시점의 트리를 쓴다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-at-"));
  const out = await mkdtemp(join(tmpdir(), "avcs-at-out-"));
  try {
    const repo = await Repo.init(dir);
    const first = await write(repo, "a.ts", "v1\n");
    const cp = await repo.createCheckpoint("main", "trigger point");

    // …그리고 head 가 전진한다. 트리거와 클레임 사이에 벌어지는 일이다.
    await write(repo, "a.ts", "v2\n", first);
    await write(repo, "b.ts", "new\n", first);

    const written = await repo.checkoutInto(out, "main", { at: cp });

    assert.equal(await readFile(join(out, "a.ts"), "utf8"), "v1\n", "그 시점의 내용이어야 한다");
    assert.deepEqual(written, ["a.ts"], "그 시점에 없던 파일은 나오면 안 된다");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("`at` 으로 나온 트리가 그 체크포인트의 treeHash 를 재현한다", async () => {
  // 잡이 검사한 트리와 evidence 가 결속될 트리가 **같다** 는 것이 요점이므로, 파일 내용이
  // 아니라 체크포인트가 스스로 기록한 해시로 대조한다.
  const dir = await mkdtemp(join(tmpdir(), "avcs-at-hash-"));
  const out = await mkdtemp(join(tmpdir(), "avcs-at-hash-out-"));
  try {
    const repo = await Repo.init(dir);
    const first = await write(repo, "a.ts", "v1\n");
    const cp = await repo.createCheckpoint("main", "trigger point");
    await write(repo, "a.ts", "v2\n", first);

    const { treeHash, treeHashOk, files } = await repo.checkpointBytes(cp);
    assert.equal(treeHashOk, true);

    await repo.checkoutInto(out, "main", { at: cp });
    for (const f of files) {
      assert.ok((await readFile(join(out, f.path))).equals(f.bytes), `${f.path} 가 체크포인트와 같아야 한다`);
    }
    assert.ok(treeHash.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

// 회귀 방지: `at` 없이는 예전 그대로 현재 head 다. 이건 원래도 통과한다 — 새 옵션이 기본
// 경로를 바꾸지 않았음을 지킨다.
test("`at` 이 없으면 예전 그대로 현재 상태를 쓴다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-at-none-"));
  const out = await mkdtemp(join(tmpdir(), "avcs-at-none-out-"));
  try {
    const repo = await Repo.init(dir);
    const first = await write(repo, "a.ts", "v1\n");
    await repo.createCheckpoint("main", "old");
    await write(repo, "a.ts", "v2\n", first);

    await repo.checkoutInto(out, "main");
    assert.equal(await readFile(join(out, "a.ts"), "utf8"), "v2\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("체크포인트가 아닌 oid 를 주면 조용히 head 로 떨어지지 않는다", async () => {
  // 조용한 폴백은 이 기능을 무의미하게 만든다 — 잡은 자기가 옛 트리를 받았다고 믿는다.
  const dir = await mkdtemp(join(tmpdir(), "avcs-at-bad-"));
  const out = await mkdtemp(join(tmpdir(), "avcs-at-bad-out-"));
  try {
    const repo = await Repo.init(dir);
    const op = await write(repo, "a.ts", "v1\n");
    await assert.rejects(() => repo.checkoutInto(out, "main", { at: op }));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});
