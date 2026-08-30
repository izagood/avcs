// "저장소가 없다" 와 "저장소를 열 수 없다" 는 다른 사건이다 (우회 감사 ⑨).
//
// 소비자는 `Repo.open` 을 `try { open } catch { init }` 로 감싼다. 의도는 "없으면 만든다" 인데
// `catch {}` 가 **모든** 실패를 잡으므로 권한 오류·손상·EMFILE 이 전부 "없음" 으로 승격되고,
// 그 위에 빈 저장소가 만들어진다. 캐시된 promise 라 프로세스가 사는 동안 복구되지 않는다.
//
// 코어가 두 사건을 구분해 주지 않는 한 소비자는 구분할 수 없다. 그래서 고침은 소비자가 아니라
// 여기다: 없음은 판별 가능한 타입으로 던지고, "없으면 만든다" 자체를 코어가 제공한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo, RepoNotFoundError } from "../src/api/repo.ts";

test("저장소가 없으면 RepoNotFoundError 로 던진다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-open-none-"));
  try {
    await assert.rejects(() => Repo.open(dir), RepoNotFoundError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("openOrInit 은 없으면 만든다 — 소비자가 재구현하던 것", async () => {
  const root = await mkdtemp(join(tmpdir(), "avcs-openorinit-"));
  try {
    const dir = join(root, "org", "repo");
    const made = await Repo.openOrInit(dir); // 중간 디렉터리까지 만들어야 한다
    await made.createIntent({ title: "t", owner: "human:h" });

    const again = await Repo.openOrInit(dir);
    assert.equal((await again.listIntents()).length, 1, "두 번째는 열어야지 다시 만들면 안 된다");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 이것이 핵심이다. 열 수 없는 저장소는 **없는 저장소가 아니다** — 그 위에 빈 저장소를 만들면
// 원본이 가려진다.
test("열 수 없는 저장소를 openOrInit 이 빈 저장소로 덮지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "avcs-open-denied-"));
  const dir = join(root, "repo");
  try {
    await Repo.init(dir); // 진짜 저장소가 여기 있다
    await mkdir(join(dir, ".avcs", "objects"), { recursive: true });
    await chmod(join(dir, ".avcs"), 0o000); // …그리고 읽을 수 없다

    await assert.rejects(
      () => Repo.openOrInit(dir),
      (e: unknown) => {
        assert.ok(!(e instanceof RepoNotFoundError), `"없음" 으로 승격되면 안 된다: ${String(e)}`);
        return true;
      },
      "읽을 수 없는 저장소는 던져야 한다 — 조용히 빈 것으로 대체되면 안 된다",
    );
  } finally {
    await chmod(join(dir, ".avcs"), 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

// 회귀 방지: 저장소가 아닌 **파일** 이 있는 경로. init 도 open 도 할 수 없으니 던져야 한다.
test("경로가 파일이면 조용히 넘어가지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "avcs-open-file-"));
  try {
    const p = join(root, "notadir");
    await writeFile(p, "x", "utf8");
    await assert.rejects(() => Repo.openOrInit(p));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
