// 적합성 스위트가 **실패할 수 있는가**. 참조 구현이 통과하는 것은 당연하고, 그것만으로는
// 스위트가 아무것도 증명하지 않는다 — 문서와 같다.
//
// 그래서 일부러 어긋난 서버를 세우고 스위트의 각 단언이 그것을 잡는지 본다. 여기서 잡히지
// 않는 항목은 core.test.ts 에서도 아무 일을 하지 않는다는 뜻이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeOid } from "../../src/core/canonical.ts";
import { startHub } from "../../src/hub/hubServer.ts";
import { Repo } from "../../src/api/repo.ts";
import type { Actor } from "../../src/objects/types.ts";

/** 지정한 방식으로 어긋나는 최소 서버. */
async function brokenHub(kind:
  | "have-returns-objects"    // /have 가 oid 대신 객체를 준다
  | "missing-is-500"          // 없는 oid 에 404 대신 500
  | "trusts-claimed-oid"      // 주장한 oid 를 그대로 믿는다
  | "post-returns-bare-oid"   // { oid } 가 아니라 문자열
): Promise<{ base: string; close: () => Promise<void> }> {
  const store = new Map<string, unknown>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/have") {
      if (kind === "have-returns-objects") return send(200, [...store.values()]);
      return send(200, [...store.keys()]);
    }
    if (req.method === "GET" && url.pathname.startsWith("/objects/")) {
      const oid = decodeURIComponent(url.pathname.slice("/objects/".length));
      if (!store.has(oid)) return send(kind === "missing-is-500" ? 500 : 404, { error: "not found" });
      return send(200, store.get(oid));
    }
    if (req.method === "POST" && url.pathname === "/objects") {
      let raw = "";
      req.on("data", (c) => { raw += String(c); });
      req.on("end", () => {
        const obj = JSON.parse(raw) as Record<string, unknown> & { type: string; oid?: string };
        const { oid: claimed, ...payload } = obj;
        const oid = kind === "trusts-claimed-oid"
          ? (claimed as string)
          : computeOid(obj.type, payload);
        store.set(oid, { ...payload, oid });
        if (kind === "post-returns-bare-oid") return send(200, oid);
        return send(200, { oid });
      });
      return;
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** core.test.ts 의 단언을 그대로 옮긴 것 — 스위트가 실제로 쓰는 검사여야 의미가 있다. */
async function checkHave(base: string): Promise<void> {
  // 먼저 객체를 하나 넣는다. 빈 목록에서는 아래 루프가 한 번도 돌지 않아 검사가 아무것도
  // 재지 못한다 — 이 파일이 실제로 그렇게 통과하는 것을 봤다(거짓 통과 패턴 ①).
  await checkPostShape(base);
  const body: unknown = await (await fetch(`${base}/have`)).json();
  assert.ok(Array.isArray(body), "배열이어야 한다");
  assert.ok((body as unknown[]).length > 0, "방금 넣었으므로 비어 있으면 안 된다 — 빈 목록은 검사를 무력화한다");
  for (const o of body as unknown[]) {
    assert.equal(typeof o, "string", "원소는 oid 문자열이다");
    assert.match(o as string, /^[a-z_]+_[0-9a-f]+$/);
  }
}
async function checkMissing404(base: string): Promise<void> {
  const res = await fetch(`${base}/objects/intent_${"0".repeat(32)}`);
  assert.equal(res.status, 404);
}
async function checkPostShape(base: string): Promise<string> {
  const body = { type: "intent", title: "t", owner: "human:h", status: "open", createdAt: new Date().toISOString() };
  const res = await fetch(`${base}/objects`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const j: unknown = await res.json();
  assert.ok(j && typeof j === "object" && !Array.isArray(j), "응답은 객체다");
  const oid = (j as { oid?: unknown }).oid;
  assert.equal(typeof oid, "string", "{ oid } 형태여야 한다");
  return oid as string;
}
async function checkRecomputesOid(base: string): Promise<void> {
  const body = { type: "intent", title: "t2", owner: "human:h", status: "open", createdAt: new Date().toISOString() };
  const claimed = "intent_" + "f".repeat(32);
  const res = await fetch(`${base}/objects`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, oid: claimed }),
  });
  const { oid } = (await res.json()) as { oid: string };
  assert.notEqual(oid, claimed, "주장한 oid 를 믿으면 원본을 오염시킬 수 있다");
  assert.equal(oid, computeOid("intent", body));
}

const CASES = [
  { kind: "have-returns-objects", check: checkHave, label: "/have 가 객체를 준다" },
  { kind: "missing-is-500", check: checkMissing404, label: "없는 oid 에 500" },
  { kind: "post-returns-bare-oid", check: checkPostShape, label: "POST 가 문자열을 준다" },
  { kind: "trusts-claimed-oid", check: checkRecomputesOid, label: "주장한 oid 를 믿는다" },
] as const;

for (const c of CASES) {
  test(`스위트가 잡는다: ${c.label}`, async () => {
    const hub = await brokenHub(c.kind);
    try {
      await assert.rejects(
        async () => { await c.check(hub.base); },
        `이 어긋남을 잡지 못하면 core.test.ts 의 그 단언은 아무 일도 하지 않는다`,
      );
    } finally {
      await hub.close();
    }
  });
}

// 대조군: 어긋나지 않은 최소 서버는 네 검사를 다 통과한다. 이게 없으면 위 넷은
// "모든 서버를 거부한다" 로도 초록이 된다.
test("올바른 최소 서버는 네 검사를 다 통과한다", async () => {
  const hub = await brokenHub("have-returns-objects" as never); // kind 를 안 쓰는 경로만 씀
  await hub.close();

  // 어긋남 없는 서버를 따로 세운다.
  const ok = await brokenHub("none" as never);
  try {
    await checkPostShape(ok.base);
    await checkHave(ok.base);
    await checkMissing404(ok.base);
    await checkRecomputesOid(ok.base);
  } finally {
    await ok.close();
  }
});

// ── reduced 확장 (docs/27 §5) ──────────────────────────────────────────────────
// 환원을 흉내낼 필요는 없다 — 참조 허브를 뒤에 두고 GET /reduced 응답만 지정한 방식으로
// 어긋나게 바꾸는 프록시다. 나머지 경로는 그대로 통과시킨다.

/** 참조 허브를 뒤에 둔 프록시. `kind` 대로 /reduced 만 비튼다. */
async function brokenReduced(kind: "truncates-tree" | "stale-etag"): Promise<{ base: string; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-broken-red-"));
  const hub = await startHub({ repoDir: dir, port: 0 });
  // 씨: 파일 둘 — 자를 것이 있어야 잘라 줄 수 있다.
  const seed = await mkdtemp(join(tmpdir(), "avcs-broken-seed-"));
  const repo = await Repo.init(seed);
  const human: Actor = { kind: "human", id: "human:h" };
  const intent = await repo.createIntent({ title: "t", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: human });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: human, path: "a.txt", content: "a\n", declaredPurpose: "a" });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: human, path: "b.txt", content: "b\n", declaredPurpose: "b" });
  await repo.pushHub(hub.url);

  const readBody = (req: import("node:http").IncomingMessage): Promise<string> =>
    new Promise((r) => { let s = ""; req.on("data", (c) => { s += String(c); }); req.on("end", () => r(s)); });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const init: RequestInit = { method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json", ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) } };
      if (req.method === "POST") init.body = await readBody(req);
      const upstream = await fetch(`${hub.url}${url.pathname}${url.search}`, init);
      const text = await upstream.text();
      const headers: Record<string, string> = { "content-type": upstream.headers.get("content-type") ?? "application/json" };
      const etag = upstream.headers.get("etag");
      if (url.pathname === "/reduced" && upstream.status === 200) {
        const j = JSON.parse(text) as { tree?: Record<string, string>; treeOmitted: boolean };
        if (kind === "truncates-tree" && j.tree) {
          const [first] = Object.entries(j.tree);
          j.tree = first ? { [first[0]]: first[1] } : {};
          j.treeOmitted = false;
        }
        headers.etag = kind === "stale-etag" ? '"deadbeefdeadbeefdeadbeefdeadbeef"' : (etag ?? "");
        res.writeHead(200, headers);
        res.end(JSON.stringify(j));
        return;
      }
      if (etag) headers.etag = etag;
      res.writeHead(upstream.status, headers);
      res.end(text);
    })().catch((e) => { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String((e as Error).message) })); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await hub.close();
      await rm(dir, { recursive: true, force: true });
      await rm(seed, { recursive: true, force: true });
    },
  };
}

/** reduced.test.ts 의 "treeOmitted 가 아니면 tree 는 완전하다" 를 그대로 옮긴 것. */
async function checkTreeComplete(base: string, dst: string): Promise<void> {
  const clone = await Repo.init(dst);
  await clone.pullHub(base);
  const local = await clone.materialize("main");
  const j = (await (await fetch(`${base}/reduced?view=main`)).json()) as { tree?: Record<string, string>; treeOmitted: boolean };
  if (!j.treeOmitted) assert.equal(Object.keys(j.tree!).length, local.tree.size, "treeOmitted 가 아니면 tree 는 완전해야 한다 — 잘린 트리는 틀린 트리다");
}

/** reduced.test.ts 의 "push 하면 ETag 가 바뀐다" 를 그대로 옮긴 것. */
async function checkEtagMoves(base: string, dir: string): Promise<void> {
  const first = await fetch(`${base}/reduced?view=main`);
  const before = first.headers.get("etag");
  await first.arrayBuffer();
  const repo = await Repo.init(dir);
  const human: Actor = { kind: "human", id: "human:h" };
  const intent = await repo.createIntent({ title: "more", owner: human.id });
  const sess = await repo.startSession({ intentOid: intent, actor: human });
  await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: human, path: "c.txt", content: "c\n", declaredPurpose: "c" });
  await repo.pushHub(base);
  const second = await fetch(`${base}/reduced?view=main`);
  const after = second.headers.get("etag");
  await second.arrayBuffer();
  assert.notEqual(after, before, "객체가 늘었는데 ETag 가 같다 — 낡은 답이다");
}

test("reduced 확장은 트리를 잘라 주는 서버를 잡는다", async () => {
  const b = await brokenReduced("truncates-tree");
  const dst = await mkdtemp(join(tmpdir(), "avcs-broken-dst-"));
  try {
    await assert.rejects(checkTreeComplete(b.base, dst), /완전해야 한다/);
  } finally { await b.close(); await rm(dst, { recursive: true, force: true }); }
});

test("reduced 확장은 낡은 ETag 를 주는 서버를 잡는다", async () => {
  const b = await brokenReduced("stale-etag");
  const dir = await mkdtemp(join(tmpdir(), "avcs-broken-seed2-"));
  try {
    await assert.rejects(checkEtagMoves(b.base, dir), /낡은 답이다/);
  } finally { await b.close(); await rm(dir, { recursive: true, force: true }); }
});

test("같은 두 검사가 참조 구현은 통과시킨다 — 검사가 서버를 가리지 않는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-ok-red-"));
  const hub = await startHub({ repoDir: dir, port: 0 });
  const dst = await mkdtemp(join(tmpdir(), "avcs-ok-red-dst-"));
  const more = await mkdtemp(join(tmpdir(), "avcs-ok-red-more-"));
  try {
    await checkTreeComplete(hub.url, dst);
    await checkEtagMoves(hub.url, more);
  } finally {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
    await rm(more, { recursive: true, force: true });
  }
});
