// docs/27 — 복제하지 않는 클라이언트가 판정과 트리 지도를 묻는다. 서버는 reduce() 를 대신
// 부를 뿐이고 답은 어느 복제본이 계산해도 같다(§3.6). 그래서 계약은 "로컬 환원과 같은가" 다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
import { startHub, HUB_PROTOCOL_VERSION, type ReducedBody } from "../src/hub/hubServer.ts";
import { hubReduced, hubReducedBlob } from "../src/hub/hubClient.ts";
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

/** 같은 base 에서 서로 다른 줄을 고친 동시 edit_file 둘 → 3-way 병합 → 합성 blob. */
async function seedConcurrentEdits(dir: string): Promise<{ repo: Repo; path: string }> {
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "merge", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  const baseText = "one\ntwo\nthree\nfour\nfive\n";
  const base = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "m.txt", content: baseText, declaredPurpose: "base" });
  await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: ai, path: "m.txt", baseText, newText: "ONE\ntwo\nthree\nfour\nfive\n", declaredPurpose: "edit head", causalDeps: [base] });
  await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: human, path: "m.txt", baseText, newText: "one\ntwo\nthree\nfour\nFIVE\n", declaredPurpose: "edit tail", causalDeps: [base] });
  return { repo, path: "m.txt" };
}

test("합성 blob: /objects/:oid 는 404, /reduced/blob/:oid 는 200 이고 바이트가 로컬 환원과 같다", async () => {
  const r = await rig({});
  try {
    const { repo: A, path } = await seedConcurrentEdits(r.dirA);
    await A.pushHub(r.hub.url);
    const want = await A.materialize("main");
    const synthOid = want.tree.get(path)!;
    assert.ok(want.synthBlobs.has(synthOid), "시드가 합성 blob 을 만들어야 이 테스트가 무언가를 잰다");

    const reduced = await getReduced(r.hub.url);
    const etag = reduced.headers.get("etag")!;
    const body = (await reduced.json()) as ReducedBody;
    assert.deepEqual(body.synth, [synthOid], "synth 목록이 합성 oid 를 가리킨다");
    assert.equal(body.tree?.[path], synthOid);

    const asObject = await fetch(`${r.hub.url}/objects/${synthOid}`);
    assert.equal(asObject.status, 404, "합성 blob 은 저장소에 없다 — 있어서도 안 된다");

    const res = await fetch(`${r.hub.url}/reduced/blob/${synthOid}?view=main`, { headers: { "if-match": etag } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("etag"), etag);
    const blob = (await res.json()) as { oid: string; data: string; encoding: string };
    assert.equal(blob.oid, synthOid);
    assert.equal(blob.encoding, "base64");
    assert.equal(Buffer.from(blob.data, "base64").toString("utf8"), Buffer.from(want.synthBlobs.get(synthOid)!).toString("utf8"));
    assert.equal(Buffer.from(blob.data, "base64").toString("utf8"), "ONE\ntwo\nthree\nfour\nFIVE\n");
  } finally { await r.close(); }
});

test("/reduced/blob: 저장된 blob 은 404, If-Match 불일치는 412, 없는 view 는 404", async () => {
  const r = await rig({});
  try {
    const { repo: A } = await seedConcurrentEdits(r.dirA);
    await A.pushHub(r.hub.url);
    const reduced = await getReduced(r.hub.url);
    const etag = reduced.headers.get("etag")!;
    const body = (await reduced.json()) as ReducedBody;
    const synthOid = body.synth![0]!;

    // 저장된 blob: 시드의 base 내용 blob 은 저장소에 있다 → 여기서는 404 (두 경로는 겹치지 않는다)
    const storedOid = await A.putBlob("one\ntwo\nthree\nfour\nfive\n");
    assert.equal((await fetch(`${r.hub.url}/objects/${storedOid}`)).status, 200, "전제: 저장된 blob 이다");
    assert.equal((await fetch(`${r.hub.url}/reduced/blob/${storedOid}?view=main`)).status, 404);

    const stale = await fetch(`${r.hub.url}/reduced/blob/${synthOid}?view=main`, { headers: { "if-match": '"00000000000000000000000000000000"' } });
    assert.equal(stale.status, 412);
    assert.equal(stale.headers.get("etag"), etag, "412 는 현재 ETag 를 알려 준다");

    assert.equal((await fetch(`${r.hub.url}/reduced/blob/${synthOid}?view=nope`)).status, 404);
  } finally { await r.close(); }
});

test("hubReduced: 200 → ok, 같은 etag → unchanged, 미지원 서버 → null", async () => {
  const r = await rig({});
  try {
    const A = await seedTwoFiles(r.dirA);
    await A.pushHub(r.hub.url);
    const first = await hubReduced(r.hub.url, "main");
    assert.ok(first && first.status === "ok");
    assert.equal(first.body.treeHash, (await A.materialize("main")).treeHash);
    const second = await hubReduced(r.hub.url, "main", { etag: first.etag });
    assert.deepEqual(second, { status: "unchanged", etag: first.etag });
    assert.equal(await hubReduced(r.hub.url, "nope"), null, "없는 view 도 null — 부르는 쪽은 폴백한다");
    assert.equal(await hubReduced("http://127.0.0.1:9", "main"), null, "닿지 않는 서버는 null");
  } finally { await r.close(); }
});

test("hubReducedBlob: 합성 oid → bytes, 낡은 etag → stale, 저장된 oid → null", async () => {
  const r = await rig({});
  try {
    const { repo: A, path } = await seedConcurrentEdits(r.dirA);
    await A.pushHub(r.hub.url);
    const red = await hubReduced(r.hub.url, "main");
    assert.ok(red && red.status === "ok");
    const synthOid = red.body.tree![path]!;
    const got = await hubReducedBlob(r.hub.url, "main", synthOid, { etag: red.etag });
    assert.ok(got && got.status === "ok");
    assert.equal(Buffer.from(got.bytes).toString("utf8"), "ONE\ntwo\nthree\nfour\nFIVE\n");
    const stale = await hubReducedBlob(r.hub.url, "main", synthOid, { etag: '"00000000000000000000000000000000"' });
    assert.ok(stale && stale.status === "stale" && stale.etag === red.etag);
    const storedOid = await A.putBlob("one\ntwo\nthree\nfour\nfive\n");
    assert.equal(await hubReducedBlob(r.hub.url, "main", storedOid), null);
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
