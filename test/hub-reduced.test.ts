// docs/27 — 복제하지 않는 클라이언트가 판정과 트리 지도를 묻는다. 서버는 reduce() 를 대신
// 부를 뿐이고 답은 어느 복제본이 계산해도 같다(§3.6). 그래서 계약은 "로컬 환원과 같은가" 다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub, HUB_PROTOCOL_VERSION, type ReducedBody } from "../src/hub/hubServer.ts";
import type { Actor } from "../src/objects/types.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const human: Actor = { kind: "human", id: "human:h" };

/** 파일 둘을 쓴 replica. 두 op 은 accepted 다. */
async function seedTwoFiles(dir: string): Promise<Repo> {
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "a.txt", content: "a\n", declaredPurpose: "a" });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "b.txt", content: "b\n", declaredPurpose: "b" });
  return repo;
}

async function getReduced(base: string, view = "main", headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/reduced?view=${encodeURIComponent(view)}`, { headers });
}

/** 테스트 하나가 쓰는 디렉터리 셋 + 허브. finally 에서 한 번에 정리한다. */
async function rig(hubOpts: Omit<Parameters<typeof startHub>[0], "repoDir">) {
  const dirA = await mkdtemp(join(tmpdir(), "avcs-red-A-"));
  const dirHub = await mkdtemp(join(tmpdir(), "avcs-red-hub-"));
  const hub = await startHub({ repoDir: dirHub, port: 0, ...hubOpts });
  return {
    dirA, hub,
    async close() {
      await hub.close();
      await rm(dirA, { recursive: true, force: true });
      await rm(dirHub, { recursive: true, force: true });
    },
  };
}

test("/version 은 reduced 와 reducedTreeMaxEntries 를 광고하고 protocol 은 5 다", async () => {
  const r = await rig({});
  try {
    const v = (await (await fetch(`${r.hub.url}/version`)).json()) as Record<string, unknown>;
    assert.equal(v.reduced, true);
    assert.equal(v.reducedTreeMaxEntries, 50_000);
    assert.equal(v.protocol, 5, "능력 추가는 버전을 올리지 않는다 (docs/26 §9)");
    assert.equal(HUB_PROTOCOL_VERSION, 5);
  } finally { await r.close(); }
});

test("GET /reduced 는 로컬 환원과 같은 treeHash·statuses·tree 를 주고, cursor 는 /sync 와 같다", async () => {
  const r = await rig({});
  try {
    const A = await seedTwoFiles(r.dirA);
    await A.pushHub(r.hub.url);
    const want = await A.materialize("main");

    const res = await getReduced(r.hub.url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("etag") ?? "", /^"[0-9a-f]{32}"$/, "강한 ETag, 따옴표 포함");
    const body = (await res.json()) as ReducedBody;
    assert.equal(body.view, "main");
    assert.equal(body.treeHash, want.treeHash);
    assert.deepEqual(body.statuses, Object.fromEntries(want.statuses));
    assert.deepEqual(body.tree, Object.fromEntries(want.tree));
    assert.deepEqual(body.synth, []);
    assert.equal(body.treeOmitted, false);
    assert.deepEqual(body.headOps.slice().sort(), want.headOps.slice().sort());
    assert.equal(body.untrustedEvidence, 0);
    assert.equal(typeof body.materializer, "string");

    const sync = (await (await fetch(`${r.hub.url}/sync?since=0`)).json()) as { cursor: number };
    assert.equal(body.cursor, sync.cursor, "커서는 /sync 와 같은 뜻이다");
  } finally { await r.close(); }
});

test("If-None-Match 가 맞으면 304 본문 없음; 객체가 push 되면 ETag 가 바뀐다", async () => {
  const r = await rig({});
  try {
    const A = await seedTwoFiles(r.dirA);
    await A.pushHub(r.hub.url);
    const first = await getReduced(r.hub.url);
    const etag = first.headers.get("etag")!;

    const again = await getReduced(r.hub.url, "main", { "if-none-match": etag });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get("etag"), etag);
    assert.equal(await again.text(), "");

    // 새 객체 하나 → 환원 입력이 바뀌었으니 ETag 도 바뀐다 (R5)
    const intent = await A.createIntent({ title: "more", owner: human.id });
    const sess = await A.startSession({ intentOid: intent, actor: ai });
    await A.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "c.txt", content: "c\n", declaredPurpose: "c" });
    await A.pushHub(r.hub.url);

    const after = await getReduced(r.hub.url, "main", { "if-none-match": etag });
    assert.equal(after.status, 200, "낡은 ETag 로는 304 를 받을 수 없다");
    assert.notEqual(after.headers.get("etag"), etag);
    const body = (await after.json()) as ReducedBody;
    assert.ok("c.txt" in (body.tree ?? {}));
  } finally { await r.close(); }
});

test("없는 view 는 404, view 생략은 main", async () => {
  const r = await rig({});
  try {
    const A = await seedTwoFiles(r.dirA);
    await A.pushHub(r.hub.url);
    const missing = await getReduced(r.hub.url, "nope");
    assert.equal(missing.status, 404);
    const bare = await fetch(`${r.hub.url}/reduced`);
    assert.equal(bare.status, 200);
    assert.equal(((await bare.json()) as ReducedBody).view, "main");
  } finally { await r.close(); }
});

test("tree 가 상한을 넘으면 잘라 주지 않고 뺀다 — 판정 필드는 그대로", async () => {
  const r = await rig({ reduced: { treeMaxEntries: 1 } });
  try {
    const A = await seedTwoFiles(r.dirA);
    await A.pushHub(r.hub.url);
    const v = (await (await fetch(`${r.hub.url}/version`)).json()) as { reducedTreeMaxEntries: number };
    assert.equal(v.reducedTreeMaxEntries, 1, "상한은 광고된다");

    const body = (await (await getReduced(r.hub.url)).json()) as ReducedBody;
    assert.equal(body.treeOmitted, true);
    assert.equal(body.tree, undefined);
    assert.equal(body.synth, undefined);
    assert.equal(Object.keys(body.statuses).length, 2, "판정은 온전하다");
    assert.equal(typeof body.treeHash, "string");
  } finally { await r.close(); }
});

test("같은 ETag 면 서버는 다시 환원하지 않는다 — 변경당 1회", async () => {
  const r = await rig({});
  try {
    const A = await seedTwoFiles(r.dirA);
    await A.pushHub(r.hub.url);
    await getReduced(r.hub.url);
    type Snap = { counters: Record<string, number> };
    const n = async (): Promise<number> => ((await (await fetch(`${r.hub.url}/metrics`)).json()) as Snap).counters["hub.reduced.materialize"] ?? 0;
    const before = await n();
    for (let i = 0; i < 3; i++) await getReduced(r.hub.url);
    assert.equal(await n(), before, "캐시 히트에서 materialize 카운터는 늘지 않는다");
    // push 만 받은 허브의 첫 환원은 `view:main` 을 스스로 시드해 객체를 하나 append 한다(#171).
    // 그러면 환원 앞뒤 ETag 가 달라 서버가 한 번 더 환원하므로 첫 요청은 2회까지 정상이다 —
    // 그 이상이면 캐시가 아니라 루프가 새는 것이다.
    assert.ok(before >= 1 && before <= 2, `첫 요청의 환원 횟수가 ${before} — 1 또는 2 여야 한다`);
  } finally { await r.close(); }
});
