// 패키지 진입점이 실제로 무엇을 내보내는가.
//
// `src/api/repo.ts` 에서 `export` 하는 것과 소비자가 `import { X } from "@izagood/avcs"` 로
// 받을 수 있는 것은 다르다. 진입점이 이름을 하나씩 재수출하기 때문이다. 클래스에 붙은 메서드는
// 클래스를 따라 자동으로 가지만(`Repo.openOrInit`, `checkpointBytes`), 독립 심볼은 진입점에
// 적히지 않으면 도달하지 않는다.
//
// 실제로 `RepoNotFoundError` 가 그렇게 빠졌다 — 머지되고 npm 에 배포까지 됐는데 소비자에서
// import 되지 않았다. 코어 게이트는 전부 초록이었다. 소비자 안에서 직접 import 해 보기 전까지
// 아무도 몰랐다는 뜻이다.
//
// 그래서 이 테스트는 "에러 타입이 존재하는가" 가 아니라 **"진입점을 통해 도달하는가"** 를 잰다.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as pkg from "../src/index.ts";

// 소비자가 `catch (e) { if (e instanceof X) }` 로 좁히려면 반드시 진입점에 있어야 하는 것들.
const ERRORS = ["RepoNotFoundError", "MassDeleteError"] as const;

for (const name of ERRORS) {
  test(`${name} 은 진입점을 통해 도달한다`, () => {
    const v = (pkg as Record<string, unknown>)[name];
    assert.equal(typeof v, "function", `import { ${name} } from "@izagood/avcs" 가 되어야 한다`);
    assert.ok(Object.prototype.isPrototypeOf.call(Error, (v as new (...a: never[]) => unknown).prototype) || (v as new (d: string) => Error).prototype instanceof Error, `${name} 은 Error 여야 한다`);
  });
}

// 회귀 방지: 클래스 메서드는 클래스를 따라간다. 이건 원래도 통과한다 — 위 실패와 대비해
// "왜 메서드는 되고 심볼은 안 됐는지" 를 코드로 남기는 것이 목적이다.
test("Repo 에 붙은 것은 Repo 를 따라간다", () => {
  assert.equal(typeof pkg.Repo.openOrInit, "function");
  assert.equal(typeof pkg.Repo.prototype.checkpointBytes, "function");
});
