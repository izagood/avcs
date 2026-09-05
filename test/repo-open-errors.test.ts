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

// ── #171: "없음" 과 "열 수 없음" 만으로는 상태 공간이 덮이지 않는다 ────────────────
//
// 세 번째 상태가 있다: **있지만 덜 시드된** 저장소. `isRepo` 는 `.avcs/objects` 하나만 보므로,
// `init` 이 아닌 경로로 객체 저장소가 생긴 디렉터리(객체 import, 백업 복원, 서버가 호스팅 저장소를
// 채우는 경우)는 그 순간부터 영원히 "있음" 이고 `init` 은 다시는 돌지 않는다. 그렇게 만들어진
// 저장소는 멀쩡히 열리고 연산도 받다가 `materialize()` 마다 `no such view: main` 으로 죽었다.

test("openOrInit 은 덜 시드된 저장소도 쓸 수 있는 상태로 돌려준다", async () => {
  const root = await mkdtemp(join(tmpdir(), "avcs-unseeded-"));
  const dir = join(root, "repo");
  try {
    // `init` 을 거치지 않고 객체 저장소만 만든다 — 이것만으로 isRepo 는 참이 된다.
    await mkdir(join(dir, ".avcs", "objects"), { recursive: true });

    const repo = await Repo.openOrInit(dir); // init 이 아니라 open 으로 간다
    // 예전에는 여기서 `no such view: main` 이 났다.
    await repo.materialize();
    assert.equal((await repo.getView("main")).name, "main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// policy() 는 없으면 defaultPolicy() 로 살아남는데 getView 만 던졌다. 두 ref 는 같은 시드
// 블록이 쓰므로 같은 이유로 함께 없을 수 있다 — 한쪽만 생존 가능한 것이 비대칭이었다.
test("이미 덜 시드된 채 열린 저장소도 main 을 되찾는다 — policy() 와 같은 대칭", async () => {
  const root = await mkdtemp(join(tmpdir(), "avcs-unseeded-getview-"));
  const dir = join(root, "repo");
  try {
    await mkdir(join(dir, ".avcs", "objects"), { recursive: true });
    await mkdir(join(dir, ".avcs", "refs"), { recursive: true });

    const repo = await Repo.open(dir); // open 은 시드하지 않는다 — 읽기가 쓰면 안 되니까
    assert.ok(await repo.policy(), "policy 는 원래도 살아남았다");
    assert.equal((await repo.getView("main")).name, "main", "main 도 같아야 한다");

    // 되살린 뷰는 남는다 — 읽을 때마다 다시 만드는 저장소는 조용히 고장난 것이다.
    const again = await Repo.open(dir);
    assert.ok(await again.store.getRef("view:main"), "view:main 이 영속화되어야 한다");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 되살림은 `main` 에만 해당한다. main 은 누가 만든 뷰가 아니라 저장소가 태어날 때부터 갖는
// 것이고, 그 부재는 "시드가 안 됐다" 는 뜻이다. 다른 이름의 부재는 진짜 조회 실패다.
test("main 이 아닌 뷰는 없으면 여전히 던진다 — 이름을 지어내지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "avcs-getview-other-"));
  const dir = join(root, "repo");
  try {
    await Repo.init(dir);
    await assert.rejects(() => Repo.open(dir).then((r) => r.getView("nope")), /no such view: nope/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
