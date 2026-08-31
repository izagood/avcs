// 명세(docs/25)가 구현과 어긋나지 않는지 고정한다.
//
// 문서만 두면 드리프트한다 — 이 저장소에서 이미 봤다: `docs/13` 이 엔드포인트를 언급하지만
// 진행 보고였고, 구현이 바뀌어도 아무도 몰랐다. 그리고 제3자가 명세를 믿고 서버를 만드는
// 순간 그 드리프트는 남의 서버를 조용히 깨뜨린다.
//
// 그래서 문서에서 **기계가 읽을 수 있는 사실**만 뽑아 구현과 대조한다: 프로토콜 버전,
// 필수/선택 엔드포인트 목록, 판정→상태코드 매핑, 능력 플래그 이름.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub, HUB_PROTOCOL_VERSION } from "../src/hub/hubServer.ts";
import { Repo } from "../src/api/repo.ts";

const SPEC = fileURLToPath(new URL("../docs/26-hub-protocol.md", import.meta.url));
const spec = await readFile(SPEC, "utf8");

test("명세가 적은 프로토콜 버전이 구현의 것과 같다", () => {
  // "현재 **5**" 같은 표현에서 숫자를 뽑는다.
  const m = /`protocol`[^\n]*현재 \*\*(\d+)\*\*/.exec(spec);
  assert.ok(m, "명세가 프로토콜 버전을 적어야 한다");
  assert.equal(
    Number(m[1]), HUB_PROTOCOL_VERSION,
    `명세는 ${m[1]}, 구현은 ${HUB_PROTOCOL_VERSION} — 둘이 갈리면 제3자가 틀린 값을 광고한다`,
  );
});

test("명세가 필수라고 적은 셋이 실제로 필수다", async () => {
  // 필수 목록을 명세의 코드블록에서 뽑는다.
  const block = /## 0\.[\s\S]*?```\n([\s\S]*?)```/.exec(spec);
  assert.ok(block, "§0 에 필수 엔드포인트 블록이 있어야 한다");
  const listed = [...(block[1] ?? "").matchAll(/^(GET|POST)\s+(\S+)/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(
    listed.sort(),
    ["GET /have", "GET /objects/:oid", "POST /objects"].sort(),
    "명세의 필수 목록이 바뀌었다 — 구현과 함께 바뀐 것인지 확인해야 한다",
  );

  // 그리고 그 셋만으로 실제 클론이 되는지. 이것이 "필수" 의 정의다.
  const src = await mkdtemp(join(tmpdir(), "avcs-spec-src-"));
  const dst = await mkdtemp(join(tmpdir(), "avcs-spec-dst-"));
  let hub: Awaited<ReturnType<typeof startHub>> | null = null;
  try {
    const repo = await Repo.init(src);
    const intent = await repo.createIntent({ title: "t", owner: "human:h" });
    const sess = await repo.startSession({ intentOid: intent, actor: { kind: "human", id: "human:h" } });
    await repo.proposeFileWrite({
      sessionOid: sess, intentOid: intent, actor: { kind: "human", id: "human:h" },
      path: "a.ts", content: "x\n", declaredPurpose: "seed",
    });
    await repo.createCheckpoint("main", "cp");

    hub = await startHub({ repoDir: src, port: 0 });
    const clone = await Repo.init(dst);
    const r = await clone.pullHub(hub.url);
    assert.ok(r.pulled > 0, "필수 셋만으로 객체가 넘어와야 한다");
    assert.equal(
      (await clone.materialize("main")).treeHash,
      (await repo.materialize("main")).treeHash,
      "그리고 같은 트리를 내야 한다",
    );
  } finally {
    await hub?.close();
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test("명세의 판정→상태코드 표가 구현과 일치한다", async () => {
  // 표에서 (판정, 상태) 쌍을 뽑는다.
  const rows = [...spec.matchAll(/^\|\s*`(advanced|queued|conflict|needs_evidence|rejected)`\s*\|\s*`(\d{3})`\s*\|/gm)];
  assert.equal(rows.length, 5, `판정 5종이 표에 있어야 한다 (찾은 것 ${rows.length})`);
  const fromSpec = Object.fromEntries(rows.map((m) => [m[1], Number(m[2])]));

  // 구현의 매핑을 소스에서 읽는다 — 하드코딩하면 둘이 같은 실수를 공유한다.
  const impl = await readFile(fileURLToPath(new URL("../src/hub/hubServer.ts", import.meta.url)), "utf8");
  const mapBlock = /const status = result\.verdict === "advanced" \? (\d+)[\s\S]*?: (\d+);/.exec(impl);
  assert.ok(mapBlock, "구현의 매핑 블록을 찾지 못했다 — 정규식을 고쳐야 한다");
  const pairs = [...(mapBlock[0]).matchAll(/verdict === "(\w+)" \? (\d+)/g)].map((m) => [m[1], Number(m[2])]);
  const fallback = Number(mapBlock[2]);

  for (const [verdict, code] of pairs) {
    assert.equal(fromSpec[verdict as string], code, `${verdict}: 명세 ${fromSpec[verdict as string]} vs 구현 ${code}`);
  }
  assert.equal(fromSpec.rejected, fallback, `rejected: 명세 ${fromSpec.rejected} vs 구현 폴백 ${fallback}`);
  assert.equal(fromSpec.advanced, 200, "advanced 는 200 이어야 한다");
});

test("명세가 적은 능력 플래그가 실제 /version 에 있다", async () => {
  const src = await mkdtemp(join(tmpdir(), "avcs-spec-ver-"));
  let hub: Awaited<ReturnType<typeof startHub>> | null = null;
  try {
    await Repo.init(src);
    hub = await startHub({ repoDir: src, port: 0 });
    const v = (await (await fetch(`${hub.url}/version`)).json()) as Record<string, unknown>;

    // 명세 §3 의 표에서 플래그 이름을 뽑는다.
    const table = /## 3\.[\s\S]*?\n\n(\|[\s\S]*?)\n\n/.exec(spec);
    assert.ok(table, "§3 에 능력 표가 있어야 한다");
    const names = [...(table[1] ?? "").matchAll(/^\|\s*`(\w+)`\s*\|/gm)].map((m) => m[1]);
    assert.ok(names.length >= 6, `표에서 플래그를 ${names.length}개만 뽑았다 — 정규식 확인`);

    for (const n of names) {
      assert.ok(n! in v, `/version 에 \`${n}\` 이 없다 — 명세가 없는 필드를 약속한다`);
    }
    // 역방향도 본다: 구현이 광고하는데 명세에 없는 것.
    const undocumented = Object.keys(v).filter((k) => !names.includes(k));
    assert.deepEqual(
      undocumented, [],
      `구현이 광고하는데 명세에 없다: ${undocumented.join(", ")} — 제3자가 그 필드를 모른다`,
    );
  } finally {
    await hub?.close();
    await rm(src, { recursive: true, force: true });
  }
});

test("명세가 언급한 선택 엔드포인트가 참조 구현에 다 있다", async () => {
  // 참조 구현은 프로토콜 전량을 서빙해야 한다 — 그것이 "참조" 의 뜻이다.
  const impl = await readFile(fileURLToPath(new URL("../src/hub/hubServer.ts", import.meta.url)), "utf8");
  const served = new Set([...impl.matchAll(/path === "(\/[a-z/]*)"|path\.startsWith\("(\/[a-z]+\/)/g)]
    .map((m) => m[1] ?? m[2]).filter(Boolean) as string[]);

  for (const p of ["/version", "/have", "/sync", "/refs", "/objects", "/finalize", "/integrate", "/events"]) {
    assert.ok(
      [...served].some((s) => s === p || p.startsWith(s)),
      `참조 구현이 ${p} 를 서빙하지 않는다 — 명세가 그것을 설명한다`,
    );
  }
});

// README 가 명세로 가는 입구다. 링크가 깨지면 제3자가 명세에 도달하지 못하고, 그 실패는
// 아무 테스트도 잡지 않는다 — 문서 링크는 조용히 깨진다.
test("README 의 '자기 서버 만들기' 절이 실재하는 파일을 가리킨다", async () => {
  const readme = await readFile(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  const section = /## Build your own server([\s\S]*?)\n## /.exec(readme);
  assert.ok(section, "README 에 'Build your own server' 절이 있어야 한다");

  const links = [...(section[1] ?? "").matchAll(/\]\((docs\/[^)]+|spec\/[^)]+)\)/g)].map((m) => m[1]!);
  assert.ok(links.length >= 3, `절이 명세·벡터를 가리켜야 한다 (찾은 링크 ${links.length})`);

  for (const rel of links) {
    const abs = fileURLToPath(new URL(`../${rel}`, import.meta.url));
    await assert.doesNotReject(() => readFile(abs), `README 가 없는 파일을 가리킨다: ${rel}`);
  }

  // 그리고 그 절이 필수 셋을 실제로 적어야 한다 — 이게 이 프로토콜의 판매 논거다.
  for (const ep of ["/have", "/objects/:oid", "POST /objects"]) {
    assert.ok((section[1] ?? "").includes(ep), `절이 ${ep} 를 보여줘야 한다`);
  }
});
