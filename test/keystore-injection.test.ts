// 키스토어 경로는 인자로 줄 수 있어야 한다 (우회 감사 ⑪).
//
// 지금은 프로세스 env 로만 정해진다(`AVCS_CONFIG_HOME` → `$XDG_CONFIG_HOME/avcs` → `~/.avcs`).
// 그 위에 러너 denylist 가 있어 `node --test`·vitest·jest 아래에서 env 가 없으면 던진다.
//
// denylist 는 완전할 수 없다 — 주석 스스로 그렇게 인정한다. 목록에 없는 러너, 혹은 라이브러리로
// 임베드된 avcs 는 개발자의 진짜 `~/.avcs` 를 오염시킨다(실제로 소비자 스위트에서 픽스처 키
// 11개가 도달한 적이 있다). 근본은 "누가 부르는지 추측한다" 가 아니라 "부르는 쪽이 말한다" 다.
//
// denylist 는 지우지 않는다 — 아무것도 말하지 않은 호출자를 위한 방어 심층화로 남긴다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";

test("Repo.open(dir, { configHome }) 이 env 와 무관하게 그 경로를 쓴다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-ks-repo-"));
  const home = await mkdtemp(join(tmpdir(), "avcs-ks-home-"));
  const envHome = process.env.AVCS_CONFIG_HOME;
  try {
    await Repo.init(dir);
    // env 는 다른 곳을 가리킨다. 인자가 이겨야 한다.
    const decoy = await mkdtemp(join(tmpdir(), "avcs-ks-decoy-"));
    process.env.AVCS_CONFIG_HOME = decoy;

    const repo = await Repo.open(dir, { configHome: home });
    await repo.provisionOwnerKey({ kind: "ai_agent", id: "ai:injected" });

    assert.deepEqual(await readdir(join(home, "private")), ["ai:injected.json"], "주입한 경로에 있어야 한다");
    await assert.rejects(() => readdir(join(decoy, "private")), "env 가 가리킨 곳은 건드리지 않는다");
  } finally {
    if (envHome === undefined) delete process.env.AVCS_CONFIG_HOME;
    else process.env.AVCS_CONFIG_HOME = envHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("주입한 키스토어에서 다시 읽는다 — 쓰기만 갈라지면 소용없다", async () => {
  // env 는 반드시 다른 곳을 가리켜야 한다. 같은 곳이면 주입이 무시돼도 통과하는 거짓 통과가
  // 된다 — 이 파일에서 실제로 한 번 그랬다.
  const dir = await mkdtemp(join(tmpdir(), "avcs-ks-rt-"));
  const home = await mkdtemp(join(tmpdir(), "avcs-ks-rt-home-"));
  const decoy = await mkdtemp(join(tmpdir(), "avcs-ks-rt-decoy-"));
  const envHome = process.env.AVCS_CONFIG_HOME;
  try {
    process.env.AVCS_CONFIG_HOME = decoy;
    const a = await Repo.init(dir, { configHome: home });
    await a.provisionOwnerKey({ kind: "ai_agent", id: "ai:rt" });

    const b = await Repo.open(dir, { configHome: home });
    assert.ok((await b.listLocalKeys()).includes("ai:rt"), "주입 경로가 읽기에도 적용돼야 한다");
    assert.deepEqual(await readdir(join(home, "private")), ["ai:rt.json"], "그리고 그 경로에 실제로 있어야 한다");
  } finally {
    if (envHome === undefined) delete process.env.AVCS_CONFIG_HOME;
    else process.env.AVCS_CONFIG_HOME = envHome;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(decoy, { recursive: true, force: true });
  }
});

// 회귀 방지: 아무것도 주입하지 않으면 예전 해석 그대로다. denylist 도 그대로 살아 있어야 한다.
//
// 가드는 해석 순서의 **세 번째** 다: AVCS_CONFIG_HOME → XDG_CONFIG_HOME/avcs → 러너 가드 →
// ~/.avcs. 그래서 앞의 둘을 모두 지워야 가드에 닿는다. 하나만 지우면 XDG 가 설정된 환경(리눅스
// CI 가 그렇다)에서는 그 전에 반환되어 테스트가 조용히 무의미해진다 — 실제로 그렇게 썼다가
// macOS 에서 초록, CI 에서 빨강을 봤다.
test("주입이 없으면 예전 해석 그대로 — denylist 포함", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-ks-default-"));
  const saved = { avcs: process.env.AVCS_CONFIG_HOME, xdg: process.env.XDG_CONFIG_HOME };
  try {
    const repo = await Repo.init(dir);
    delete process.env.AVCS_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    await assert.rejects(
      () => repo.provisionOwnerKey({ kind: "ai_agent", id: "ai:nope" }),
      /refusing to resolve the machine keystore/,
      "말하지 않은 호출자에게는 denylist 가 그대로 선다",
    );
  } finally {
    for (const [k, v] of [["AVCS_CONFIG_HOME", saved.avcs], ["XDG_CONFIG_HOME", saved.xdg]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
