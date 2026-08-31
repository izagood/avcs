// 적합성 스위트의 진입점 검증. 제3자가 실제로 돌릴 수 있어야 스위트가 의미를 갖는다 —
// 돌릴 방법이 없으면 우리 CI 안의 테스트일 뿐이다.
//
// 이 파일은 `test/conformance/` **밖**에 있다. 안에 두면 `npm run conformance` 가 자기
// 자신을 부르는 재귀가 된다 — 실제로 그렇게 짰다가 실패했다. 진입점을 검증하는 테스트는
// 그 진입점이 실행하는 집합에 속할 수 없다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";


test("package.json 이 적합성 스크립트를 노출한다", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.ok(pkg.scripts.conformance, "npm run conformance 가 있어야 한다");
  assert.match(
    pkg.scripts.conformance, /test\/conformance\//,
    "적합성 테스트만 돌려야 한다 — 전체 스위트를 돌리면 제3자에게 무의미한 실패가 섞인다",
  );
});

// "진입점이 실제로 동작한다" 는 **여기서 검증할 수 없다.** node 의 테스트 러너 안에서
// 러너를 다시 부르면 `run() is being called recursively within a test file. skipping
// running files.` 로 아무 파일도 돌지 않는다 — 파일을 스위트 밖으로 옮겨도 마찬가지다.
// 중첩 실행 자체가 막혀 있다.
//
// 그래서 그 검증은 CI 의 **별도 잡**이 한다(.github/workflows/ci.yml 의 conformance 잡).
// 테스트로 흉내내면 초록이 나되 아무것도 재지 못한다.

test("메인 test 스크립트가 적합성을 포함하지 않는다 — 두 번 돌면 낭비다", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  // `test/*.test.ts` 는 하위 디렉터리를 포함하지 않으므로 원래도 안 겹친다. 그 사실을
  // 고정한다 — 누가 `test/**/*.test.ts` 로 넓히면 적합성이 두 번 돈다.
  assert.doesNotMatch(pkg.scripts.test ?? "", /\*\*/, "test 글롭이 하위 디렉터리를 삼키면 적합성이 중복 실행된다");
});
