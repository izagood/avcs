// Path alias map — the pure function Stage 1 Pass A is built on (docs/19 §3.2).
//
// `buildAliasMap` turns the accepted `rename_file` closure into "original path → final
// path", so a content op can be routed to where the file actually LIVES rather than to
// the path its author happened to name. Everything here is a unit test of that pure
// function; the real Repo/reduce() pipeline is exercised by
// test/rename-identity-matrix.test.ts.
//
//   node --experimental-strip-types --test test/reducer-aliases.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAliasMap, resolvePath } from "../src/reducer/aliases.ts";
import type { Operation } from "../src/objects/types.ts";

const never = () => false; // not a causal descendant
const always = () => true;

/** Minimal `rename_file` fixture — buildAliasMap reads only oid/lamport/body. */
function op(a: { oid: string; fromPath: string; path: string; lamport?: number; causalDeps?: string[] }): Operation {
  return {
    type: "operation",
    oid: a.oid,
    sessionOid: "session_s",
    intentOid: "intent_i",
    actor: { kind: "ai_agent", id: "ai:a" },
    target: { entityKind: "file", entityId: a.fromPath },
    body: { kind: "rename_file", fromPath: a.fromPath, path: a.path },
    causalDeps: a.causalDeps ?? [],
    declaredPurpose: `rename ${a.fromPath}→${a.path}`,
    lamport: a.lamport ?? 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Operation;
}

test("단일 rename: from → to", () => {
  const r = op({ oid: "op_1", fromPath: "a.ts", path: "b.ts" });
  const m = buildAliasMap([r], () => true);
  assert.equal(m.final.get("a.ts"), "b.ts");
  assert.equal(m.contested.size, 0);
});

test("체인 P→Q→R 폐포: P와 Q 모두 R로", () => {
  const r1 = op({ oid: "op_1", fromPath: "p.ts", path: "q.ts", lamport: 1 });
  const r2 = op({ oid: "op_2", fromPath: "q.ts", path: "r.ts", lamport: 2, causalDeps: ["op_1"] });
  const m = buildAliasMap([r1, r2], () => false); // causally ordered ⇒ not concurrent
  assert.equal(m.final.get("p.ts"), "r.ts");
  assert.equal(m.final.get("q.ts"), "r.ts");
  assert.equal(m.contested.size, 0);
});

test("동시 다목적지: contested로 격리, 이동하지 않는다", () => {
  const r1 = op({ oid: "op_1", fromPath: "p.ts", path: "q.ts", lamport: 1 });
  const r2 = op({ oid: "op_2", fromPath: "p.ts", path: "z.ts", lamport: 2 });
  const m = buildAliasMap([r1, r2], () => true); // concurrent with each other
  assert.ok(m.contested.has("p.ts"));
  assert.equal(m.final.has("p.ts"), false);
});

test("인과 순서의 같은 출발지 rename 체인: 마지막이 이기고 contested 아님", () => {
  const r1 = op({ oid: "op_1", fromPath: "p.ts", path: "q.ts", lamport: 1 });
  const r2 = op({ oid: "op_2", fromPath: "p.ts", path: "z.ts", lamport: 2, causalDeps: ["op_1"] });
  const m = buildAliasMap([r1, r2], () => false);
  assert.equal(m.contested.size, 0);
  assert.equal(m.final.get("p.ts"), "z.ts");
});

test("동시 사이클 P→Q, Q→P: 관여 경로 전부 contested", () => {
  const r1 = op({ oid: "op_1", fromPath: "p.ts", path: "q.ts", lamport: 1 });
  const r2 = op({ oid: "op_2", fromPath: "q.ts", path: "p.ts", lamport: 2 });
  const m = buildAliasMap([r1, r2], () => true);
  assert.ok(m.contested.has("p.ts"));
  assert.ok(m.contested.has("q.ts"));
  assert.equal(m.final.size, 0);
});

test("resolvePath: 인과 후손은 별칭을 타지 않는다", () => {
  const r = op({ oid: "op_r", fromPath: "a.ts", path: "b.ts" });
  const m = buildAliasMap([r], () => true);
  assert.equal(resolvePath(m, "a.ts", "op_concurrent", never), "b.ts");
  assert.equal(resolvePath(m, "a.ts", "op_after", always), "a.ts");
});

test("별칭 없는 경로는 그대로", () => {
  const m = buildAliasMap([], () => true);
  assert.equal(resolvePath(m, "x.ts", "op_1", never), "x.ts");
});

test("결정론: rename 입력 순서를 뒤집어도 같은 맵", () => {
  const r1 = op({ oid: "op_1", fromPath: "p.ts", path: "q.ts", lamport: 1 });
  const r2 = op({ oid: "op_2", fromPath: "q.ts", path: "r.ts", lamport: 2, causalDeps: ["op_1"] });
  const a = buildAliasMap([r1, r2], () => false);
  const b = buildAliasMap([r2, r1], () => false);
  assert.deepEqual([...a.final], [...b.final]);
  assert.deepEqual([...a.contested], [...b.contested]);
});

test("byOp: rename oid → 그 op이 옮긴 fromPath", () => {
  const r1 = op({ oid: "op_1", fromPath: "p.ts", path: "q.ts", lamport: 1 });
  const r2 = op({ oid: "op_2", fromPath: "q.ts", path: "r.ts", lamport: 2, causalDeps: ["op_1"] });
  const m = buildAliasMap([r1, r2], () => false);
  assert.equal(m.byOp.get("op_1"), "p.ts");
  assert.equal(m.byOp.get("op_2"), "q.ts");
});

test("체인의 중간 경로가 contested면 그 앞 구간은 거기서 멈춘다", () => {
  // p→q (uncontested), then q→r ∥ q→s (concurrent, contested). p must not silently
  // resolve past the contested hop.
  const r1 = op({ oid: "op_1", fromPath: "p.ts", path: "q.ts", lamport: 1 });
  const r2 = op({ oid: "op_2", fromPath: "q.ts", path: "r.ts", lamport: 2 });
  const r3 = op({ oid: "op_3", fromPath: "q.ts", path: "s.ts", lamport: 3 });
  const m = buildAliasMap([r1, r2, r3], (a, b) => !(a === "op_1" || b === "op_1"));
  assert.ok(m.contested.has("q.ts"));
  assert.equal(m.final.get("p.ts"), "q.ts", "p stops at the contested hop, it does not vanish");
});
