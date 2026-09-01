// 적합성 · core 레벨 — 필수 3개(docs/25 §0)만으로 무엇이 성립하는가.
//
// 이 레벨을 통과하면 avcs 클라이언트가 그 서버로 **클론할 수 있다**. 그것이 "호환" 의 최소
// 정의다. `AVCS_CONFORMANCE_URL` 을 주면 그 서버를, 없으면 참조 구현을 잰다.
//
// 재는 것은 프로토콜 관측 가능한 것뿐이다. 서버 옵션(gated·auth·rateLimit)을 켜고 끄는
// 검증은 여기 오지 않는다 — 그건 참조 서버의 옵션이고 프로토콜이 아니다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTarget, writeHeaders } from "./target.ts";
import { Repo } from "../../src/api/repo.ts";
import { computeOid } from "../../src/core/canonical.ts";
import type { Actor } from "../../src/objects/types.ts";

const human: Actor = { kind: "human", id: "human:h" };

/** 서버에 없을 객체 하나. oid 는 내용에서 나오므로 미리 알 수 있다. */
function noveltyObject(): { body: Record<string, unknown>; oid: string } {
  const body = {
    type: "intent" as const,
    title: `conformance ${Date.now()}-${Math.random().toString(36).slice(2)}`,
    owner: human.id,
    status: "open" as const,
    createdAt: new Date().toISOString(),
  };
  return { body, oid: computeOid("intent", body) };
}

test("GET /have 는 oid 문자열 배열을 준다", async () => {
  const t = await openTarget();
  try {
    // 빈 서버에서는 아래 루프가 돌지 않아 이 검사가 아무것도 재지 못한다. 그래서 먼저 하나
    // 넣는다 — 넣을 수 없는 서버(게이트됨)라면 목록이 비어 있어도 넘어간다.
    const { body: seed } = noveltyObject();
    const seedRaw = JSON.stringify(seed);
    const put = await fetch(`${t.base}/objects`, {
      method: "POST", headers: writeHeaders(t.base, "POST", "/objects", seedRaw), body: seedRaw,
    });
    const seeded = put.status === 200;

    const res = await fetch(`${t.base}/have`);
    assert.equal(res.status, 200);
    const body: unknown = await res.json();
    assert.ok(Array.isArray(body), `배열이어야 한다 — got ${typeof body}`);
    if (seeded) {
      assert.ok((body as unknown[]).length > 0, "방금 넣었으므로 비어 있으면 안 된다");
    }
    for (const o of body as unknown[]) {
      assert.equal(typeof o, "string", "원소는 oid 문자열이다 (객체가 아니다)");
      assert.match(o as string, /^[a-z_]+_[0-9a-f]+$/, `oid 형태가 아니다: ${String(o)}`);
    }
  } finally {
    await t.close();
  }
});

test("POST /objects 는 저장하고 oid 를 돌려준다 — 그리고 멱등이다", async () => {
  const t = await openTarget();
  try {
    const { body, oid } = noveltyObject();
    const send = async (): Promise<Response> => {
      const raw = JSON.stringify(body);
      return fetch(`${t.base}/objects`, {
        method: "POST", headers: writeHeaders(t.base, "POST", "/objects", raw), body: raw,
      });
    };

    const first = await send();
    if (first.status === 401 || first.status === 403) {
      // 게이트된 서버는 서명 없는 쓰기를 거부한다 — 프로토콜에 맞는 응답이다.
      // 이 스위트는 자격을 모르므로 여기서 멈춘다(실패가 아니다).
      return;
    }
    assert.equal(first.status, 200, `저장이면 200 이어야 한다 — got ${first.status}`);
    assert.deepEqual(await first.json(), { oid }, "응답은 { oid } 이고 oid 는 내용에서 나온 값이다");

    const again = await send();
    assert.equal(again.status, 200, "같은 객체를 다시 보내도 200 — 내용주소이므로 멱등이다");
    assert.deepEqual(await again.json(), { oid });
  } finally {
    await t.close();
  }
});

test("GET /objects/:oid 는 저장된 객체를, 없는 것에는 404 를 준다", async () => {
  const t = await openTarget();
  try {
    const missing = "intent_" + "0".repeat(32);
    const res404 = await fetch(`${t.base}/objects/${missing}`);
    assert.equal(res404.status, 404, "없는 oid 는 404 다 — 클라이언트가 축출 경쟁으로 보고 넘어간다");

    // 있는 것을 하나 만들어 되읽는다.
    const { body, oid } = noveltyObject();
    const putRaw = JSON.stringify(body);
    const put = await fetch(`${t.base}/objects`, {
      method: "POST", headers: writeHeaders(t.base, "POST", "/objects", putRaw), body: putRaw,
    });
    if (put.status === 401 || put.status === 403) return; // 게이트된 서버
    assert.equal(put.status, 200);

    const got = await fetch(`${t.base}/objects/${oid}`);
    assert.equal(got.status, 200);
    const back = (await got.json()) as Record<string, unknown>;
    assert.equal(back.title, body.title, "내용이 그대로 돌아와야 한다");
    assert.equal(back.oid, oid, "객체는 oid 필드를 포함해 오간다");
  } finally {
    await t.close();
  }
});

test("변조된 객체는 자기 oid 에 착지한다 — 원본 자리를 뺏지 못한다", async () => {
  // 거부가 아니라 재계산이다(docs/25 §8). 거부는 판단이 필요하고 판단은 틀릴 수 있지만,
  // 주소를 내용에서 다시 계산하는 것은 판단이 없다.
  const t = await openTarget();
  try {
    const { body, oid } = noveltyObject();
    const forged = { ...body, oid, title: "forged" }; // 남의 oid 를 주장한다
    const forgedRaw = JSON.stringify(forged);
    const res = await fetch(`${t.base}/objects`, {
      method: "POST", headers: writeHeaders(t.base, "POST", "/objects", forgedRaw), body: forgedRaw,
    });
    if (res.status === 401 || res.status === 403) return;
    assert.equal(res.status, 200, "받아들여도 된다 — 다만 주장한 주소가 아니어야 한다");
    const { oid: landed } = (await res.json()) as { oid: string };
    assert.notEqual(landed, oid, "주장한 oid 에 착지하면 원본을 오염시킬 수 있다");
    assert.equal(landed, computeOid("intent", { ...forged, oid: undefined }), "내용에서 다시 계산한 주소여야 한다");
  } finally {
    await t.close();
  }
});

test("core 만으로 클론이 된다 — 이것이 '호환' 의 최소 정의다", async () => {
  const t = await openTarget();
  const src = await mkdtemp(join(tmpdir(), "avcs-conf-src-"));
  const dst = await mkdtemp(join(tmpdir(), "avcs-conf-dst-"));
  try {
    // 대상 서버에 내용을 넣는다. 참조 구현을 띄운 경우에만 가능하므로, 외부 URL 이면
    // 이미 들어 있는 내용으로 클론만 시도한다.
    if (t.spawned) {
      const repo = await Repo.init(src);
      const intent = await repo.createIntent({ title: "conf", owner: human.id });
      const sess = await repo.startSession({ intentOid: intent, actor: human });
      await repo.proposeFileWrite({
        sessionOid: sess, intentOid: intent, actor: human,
        path: "a.ts", content: "x\n", declaredPurpose: "seed",
      });
      await repo.createCheckpoint("main", "cp");
      const pushed = await repo.pushHub(t.base);
      assert.ok(pushed.pushed > 0, "푸시가 되어야 이 검사가 의미를 갖는다");
    }

    const clone = await Repo.init(dst);
    const pulled = await clone.pullHub(t.base);
    assert.ok(pulled.pulled > 0, `객체가 넘어와야 한다 — got ${pulled.pulled}`);

    if (t.spawned) {
      const want = await (await Repo.open(src)).materialize("main");
      const got = await clone.materialize("main");
      assert.equal(got.treeHash, want.treeHash, "같은 트리를 내야 한다 — 이것이 계약이다");
    }
  } finally {
    await t.close();
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});
