// 적합성 · reduced 확장(docs/27 §5) — 사다리 밖이다. 광고하지 않으면 건너뛴다.
//
// 재는 것: 서버가 "같은 객체로 로컬 환원한 것과 같은 판정·트리" 를 내는가. core 는 서버측
// projection 을 재지 않는다고 명시했다(#172) — 이 확장이 그 빈칸을 재는 유일한 자리다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTarget, writeHeaders, type Target } from "./target.ts";
import { Repo } from "../../src/api/repo.ts";
import type { Actor } from "../../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };
const ai: Actor = { kind: "ai_agent", id: "ai:a" };

const STATUSES = ["proposed", "validating", "accepted", "rejected", "superseded", "needs_decision", "quarantined"];

interface Reduced {
  view: string; cursor: number; materializer: string; treeHash: string;
  statuses: Record<string, string>; headOps: string[]; tree?: Record<string, string>; synth?: string[]; treeOmitted: boolean;
}

async function requireExtension(t: Target, x: "reduced"): Promise<boolean> {
  const xs = await t.applicableExtensions();
  if (!xs.includes(x)) { console.log(`  (skip ${x}: 광고 없음)`); return false; }
  return true;
}

/** 이 서버에 쓸 수 있는가. 게이트된 서버에서 자격이 없으면 false — 측정하지 않음이지 실패가 아니다. */
async function canWrite(t: Target): Promise<boolean> {
  const probe = JSON.stringify({ type: "intent", title: `probe ${Date.now()}`, owner: human.id, status: "open", createdAt: new Date().toISOString() });
  const res = await fetch(`${t.base}/objects`, { method: "POST", headers: writeHeaders(t.base, "POST", "/objects", probe), body: probe });
  return res.status !== 401 && res.status !== 403;
}

/** 파일 하나를 쓴 replica 를 서버에 push 한다. 못 쓰는 서버면 null. */
async function seedViaPush(t: Target, dir: string): Promise<Repo | null> {
  if (!(await canWrite(t))) return null;
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: `conf ${Date.now()}`, owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: `conf-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`, content: "x\n", declaredPurpose: "seed" });
  await repo.pushHub(t.base);
  return repo;
}

test("reduced: /version 이 reduced 를 광고하면 reducedTreeMaxEntries 는 양의 정수다", async () => {
  const t = await openTarget();
  try {
    if (!(await requireExtension(t, "reduced"))) return;
    const caps = await t.capabilities();
    assert.equal(typeof caps.reducedTreeMaxEntries, "number");
    assert.ok(Number.isInteger(caps.reducedTreeMaxEntries) && (caps.reducedTreeMaxEntries as number) > 0, "상한을 광고하지 않으면 클라이언트가 실패로 배운다");
  } finally { await t.close(); }
});

test("reduced: 응답 형태 · cursor 는 /sync 와 같은 축 · ETag 가 있고 되돌려 주면 304", async () => {
  const t = await openTarget();
  const dir = await mkdtemp(join(tmpdir(), "avcs-conf-red-"));
  try {
    if (!(await requireExtension(t, "reduced"))) return;
    await seedViaPush(t, dir);
    const res = await fetch(`${t.base}/reduced?view=main`);
    assert.equal(res.status, 200);
    const etag = res.headers.get("etag");
    assert.ok(etag, "ETag 가 없으면 캐시할 수 없다");
    const j = (await res.json()) as Reduced;
    assert.equal(j.view, "main");
    assert.equal(typeof j.cursor, "number");
    assert.equal(typeof j.materializer, "string");
    assert.match(j.treeHash, /^[0-9a-f]{64}$/);
    for (const v of Object.values(j.statuses)) assert.ok(STATUSES.includes(v), `상태 값이 아니다: ${v}`);
    assert.equal(typeof j.treeOmitted, "boolean");
    if (!j.treeOmitted) {
      assert.ok(j.tree && j.synth, "treeOmitted 가 아니면 tree 와 synth 가 있다");
      const caps = await t.capabilities();
      assert.ok(Object.keys(j.tree!).length <= (caps.reducedTreeMaxEntries as number), "상한을 넘는 트리를 잘라 주면 안 된다 — 빼야 한다");
      const treeOids = new Set(Object.values(j.tree!));
      for (const s of j.synth!) assert.ok(treeOids.has(s), "synth 는 tree 값의 부분집합이다");
    } else {
      assert.equal(j.tree, undefined);
      assert.equal(j.synth, undefined);
    }
    // 커서: 살아 있는 서버는 그 사이 자랄 수 있으니 "≥" 로 잰다. /sync 커서가 더 작을 수는 없다.
    const sync = (await (await fetch(`${t.base}/sync?since=0`)).json()) as { cursor: number };
    assert.ok(sync.cursor >= j.cursor, "cursor 는 /sync 의 objlog 커서와 같은 축이다");

    const again = await fetch(`${t.base}/reduced?view=main`, { headers: { "if-none-match": etag! } });
    assert.ok(again.status === 304 || again.status === 200, "304 또는(그 사이 변경) 200");
    if (again.status === 304) assert.equal(await again.text(), "");
    else await again.arrayBuffer();
  } finally { await t.close(); await rm(dir, { recursive: true, force: true }); }
});

test("reduced: 서버의 판정·트리는 같은 객체로 로컬 환원한 것과 같다 — 이것이 계약이다", async () => {
  const t = await openTarget();
  const src = await mkdtemp(join(tmpdir(), "avcs-conf-red-src-"));
  const dst = await mkdtemp(join(tmpdir(), "avcs-conf-red-dst-"));
  try {
    if (!(await requireExtension(t, "reduced"))) return;
    await seedViaPush(t, src);
    // 서버가 가진 전부를 받아 로컬에서 환원한다 — 얇은 클라이언트가 아닌 복제본의 답.
    const clone = await Repo.init(dst);
    await clone.pullHub(t.base);
    const local = await clone.materialize("main");
    const j = (await (await fetch(`${t.base}/reduced?view=main`)).json()) as Reduced;
    // 살아 있는 서버는 pull 과 /reduced 사이에 자랄 수 있다 — 커서가 같을 때만 단언한다.
    const sync = (await (await fetch(`${t.base}/sync?since=0`)).json()) as { cursor: number };
    if (sync.cursor !== j.cursor) { console.log("  (skip treeHash 대조: 측정 중 서버가 변했다)"); return; }
    assert.equal(j.treeHash, local.treeHash, "다른 환원기를 돌리거나 정책을 무시하는 서버다");
    assert.deepEqual(j.statuses, Object.fromEntries(local.statuses));
    if (!j.treeOmitted) assert.equal(Object.keys(j.tree!).length, local.tree.size, "treeOmitted 가 아니면 tree 는 완전해야 한다 — 잘린 트리는 틀린 트리다");
  } finally { await t.close(); await rm(src, { recursive: true, force: true }); await rm(dst, { recursive: true, force: true }); }
});

test("reduced: 객체를 하나 push 하면 ETag 가 바뀐다 — 낡은 답을 주는 서버를 잡는다", async () => {
  const t = await openTarget();
  const dir = await mkdtemp(join(tmpdir(), "avcs-conf-red-"));
  try {
    if (!(await requireExtension(t, "reduced"))) return;
    const first = await fetch(`${t.base}/reduced?view=main`);
    const before = first.headers.get("etag");
    await first.arrayBuffer();
    const repo = await seedViaPush(t, dir);
    if (!repo) { console.log("  (skip: 쓰기 자격 없음)"); return; }
    const second = await fetch(`${t.base}/reduced?view=main`);
    const after = second.headers.get("etag");
    await second.arrayBuffer();
    assert.notEqual(after, before, "객체가 늘었는데 ETag 가 같다 — 낡은 답이다");
  } finally { await t.close(); await rm(dir, { recursive: true, force: true }); }
});

test("reduced: synth 는 /objects 에서 404 · /reduced/blob 에서 200; 비-synth 는 /reduced/blob 에서 404; 없는 view 는 404", async () => {
  const t = await openTarget();
  const dir = await mkdtemp(join(tmpdir(), "avcs-conf-red-"));
  try {
    if (!(await requireExtension(t, "reduced"))) return;
    if (!(await canWrite(t))) { console.log("  (skip: 쓰기 자격 없음)"); return; }
    // 합성 blob 을 만들려면 같은 base 에서 서로 다른 줄을 고친 동시 edit 둘이 필요하다.
    const repo = await Repo.init(dir);
    const intent = await repo.createIntent({ title: "merge", owner: human.id });
    const sess = await repo.startSession({ intentOid: intent, actor: ai });
    const p = `conf-merge-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
    const baseText = "one\ntwo\nthree\nfour\nfive\n";
    const base = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: p, content: baseText, declaredPurpose: "base" });
    await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: ai, path: p, baseText, newText: "ONE\ntwo\nthree\nfour\nfive\n", declaredPurpose: "h", causalDeps: [base] });
    await repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: human, path: p, baseText, newText: "one\ntwo\nthree\nfour\nFIVE\n", declaredPurpose: "t", causalDeps: [base] });
    await repo.pushHub(t.base);

    const res = await fetch(`${t.base}/reduced?view=main`);
    const etag = res.headers.get("etag")!;
    const j = (await res.json()) as Reduced;
    if (j.treeOmitted) { console.log("  (skip: 트리가 상한을 넘어 생략됨)"); return; }
    const synthOid = j.tree![p];
    assert.ok(synthOid && j.synth!.includes(synthOid), "동시 edit 의 결과는 synth 에 있어야 한다");
    assert.equal((await fetch(`${t.base}/objects/${synthOid}`)).status, 404, "합성 blob 을 저장소에 넣는 서버다");
    const b = await fetch(`${t.base}/reduced/blob/${synthOid}?view=main`, { headers: { "if-match": etag } });
    assert.ok(b.status === 200 || b.status === 412, `합성 oid 는 200(또는 그 사이 변경으로 412) — got ${b.status}`);
    if (b.status === 200) {
      const blob = (await b.json()) as { oid: string; data: string; encoding: string };
      assert.equal(blob.oid, synthOid);
      assert.equal(blob.encoding, "base64");
      assert.equal(Buffer.from(blob.data, "base64").toString("utf8"), "ONE\ntwo\nthree\nfour\nFIVE\n");
    } else {
      await b.arrayBuffer();
    }
    const stored = Object.values(j.tree!).find((o) => !j.synth!.includes(o));
    if (stored) assert.equal((await fetch(`${t.base}/reduced/blob/${stored}?view=main`)).status, 404, "두 경로를 겹치는 서버다");
    assert.equal((await fetch(`${t.base}/reduced?view=no-such-view-${Date.now()}`)).status, 404);
  } finally { await t.close(); await rm(dir, { recursive: true, force: true }); }
});
