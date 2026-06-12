// End-to-end demo of the AVCS MVP.
//   node --experimental-strip-types src/demo.ts
//
// It walks the agent workflow and shows the four merge outcomes AVCS is built for:
//   • auto-merge of disjoint entities          (Level 0/1)
//   • policy auto-decision on a contended file  (Level 2)
//   • evidence gating of a behavior change      (Level 3)
//   • human decision on a public-API break      (Level 4)
// …then a multi-machine scene (Phase 7): two replicas work independently and
// reconcile by object gossip (`pull`) — converging to the same treeHash, and
// surfacing a genuine conflict as the SAME Decision on both sides (no merge step).

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { Repo } from "./api/repo.ts";
import type { Actor } from "./objects/types.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoDir = join(here, "..", "scratch", "demo-repo");
const workDir = join(here, "..", "scratch", "demo-workspace");

const human: Actor = { kind: "human", id: "human:jinbin" };
const agentA: Actor = { kind: "ai_agent", id: "ai:claude-code", model: "claude-opus" };
const agentB: Actor = { kind: "ai_agent", id: "ai:codex", model: "gpt-5.5" };

function hr(title: string): void {
  console.log(`\n${"─".repeat(64)}\n▶ ${title}\n${"─".repeat(64)}`);
}

async function main(): Promise<void> {
  // Start from a clean slate so the run is reproducible. (Object payloads carry
  // createdAt timestamps, so re-authoring "the same" intent across runs yields new
  // oids; without this, repeated runs would accumulate cross-run operations.)
  await rm(repoDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
  const repo = await Repo.init(repoDir);

  hr("Intent: UserService에 Redis cache 추가 (public API 유지 제약)");
  const intent = await repo.createIntent({
    title: "UserService에 Redis cache 추가",
    owner: human.id,
    kind: "feature",
    priority: "high",
    constraints: ["public API 변경 금지", "Redis 장애 시 DB fallback"],
    successCriteria: ["unit test pass", "cache hit/miss 테스트"],
    allowedScopes: ["file:src/user/service.ts", "file:src/cache/redis.ts"],
  });
  console.log(`intent = ${intent}`);

  const sessA = await repo.startSession({ intentOid: intent, actor: agentA, summary: "Redis cache 추가" });
  const sessB = await repo.startSession({ intentOid: intent, actor: agentB, summary: "timeout fallback" });

  // ── Scene 1: disjoint entities → auto-merge ──────────────────────────────
  hr("Scene 1 — 서로 다른 파일 동시 수정 → 자동 병합");
  await repo.proposeFileWrite({
    sessionOid: sessA, intentOid: intent, actor: agentA,
    path: "src/cache/redis.ts",
    content: "export class RedisCache { get(k:string){/*...*/} }\n",
    declaredPurpose: "RedisCache 클래스 추가",
  });
  await repo.proposeFileWrite({
    sessionOid: sessB, intentOid: intent, actor: agentB,
    path: "src/user/service.test.ts",
    content: "test('findById cache', () => {/*...*/})\n",
    declaredPurpose: "cache 테스트 추가",
  });
  await report(repo);

  // ── Scene 2: same file, concurrent → policy auto-decision ────────────────
  hr("Scene 2 — 같은 파일 동시 수정(인과 무관) → 정책 자동 결정(human 우선)");
  await repo.proposeFileWrite({
    sessionOid: sessA, intentOid: intent, actor: agentA,
    path: "src/user/service.ts",
    content: "// by agent: in-memory cache\nexport class UserService {}\n",
    declaredPurpose: "in-memory cache 적용",
  });
  await repo.proposeFileWrite({
    sessionOid: sessB, intentOid: intent, actor: human, // 사람이 직접 같은 파일 작성
    path: "src/user/service.ts",
    content: "// by human: redis cache\nexport class UserService {}\n",
    declaredPurpose: "Redis cache 적용",
  });
  await report(repo);

  // ── Scene 3: behavior change without test → evidence gating ──────────────
  hr("Scene 3 — 동작 변경인데 테스트 없음 → 차단(rejected), 이후 테스트 첨부 → 통과");
  const behaviorOp = await repo.proposeFileWrite({
    sessionOid: sessA, intentOid: intent, actor: agentA,
    path: "src/user/repository.ts",
    content: "export class UserRepository { findById(){ /* new cache path */ } }\n",
    declaredPurpose: "findById에 cache 경로 추가",
    effects: { changesBehavior: true },
  });
  console.log("테스트 첨부 전:");
  await report(repo);
  await repo.attachEvidence({
    forOps: [behaviorOp], kind: "unit_test", result: "pass",
    producedBy: { kind: "ci_bot", id: "ci:tests" }, command: "node --test",
  });
  console.log("\n테스트(pass) 첨부 후:");
  await report(repo);

  // ── Scene 4: public API break → needs human decision ─────────────────────
  hr("Scene 4 — public API 파괴 → 사람 결정 필요(needs_decision)");
  const apiOp = await repo.proposeFileWrite({
    sessionOid: sessA, intentOid: intent, actor: agentA,
    path: "src/user/api.ts",
    content: "export function findById(): User | null { return null }\n",
    declaredPurpose: "return type을 User|null 로 변경",
    effects: { breaksPublicApi: true, changesBehavior: true },
  });
  await repo.attachEvidence({
    forOps: [apiOp], kind: "unit_test", result: "pass",
    producedBy: { kind: "ci_bot", id: "ci:tests" },
  });
  const res4 = await report(repo);

  hr("Scene 4b — 사람이 결정(reject) → 히스토리에 Decision 기록");
  const conflict = res4.conflicts.find((c) => c.options.some((o) => o.opOid === apiOp));
  if (conflict) {
    await repo.recordDecision({
      conflictId: conflict.id,
      chosenOps: [],
      rejectedOps: [apiOp],
      reason: "intent 제약: public API 변경 금지. exception 유지 방식으로 재작업 요청.",
      decidedBy: human,
      futurePolicy: "UserService public signature는 유지한다",
    });
    console.log(`decision recorded for ${conflict.id}`);
  }
  await report(repo);

  // ── Checkpoint + workspace projection ────────────────────────────────────
  hr("Checkpoint 생성 + working tree projection");
  const cp = await repo.createCheckpoint("main", "Redis cache 작업 체크포인트");
  const cpObj = await repo.store.get(cp);
  console.log(`checkpoint = ${cp}`);
  console.log(`  status   = ${(cpObj as { status: string }).status}`);
  console.log(`  treeHash = ${(cpObj as { treeHash: string }).treeHash}`);

  const final = await repo.materialize("main");
  await repo.writeWorkspace(final, workDir);
  console.log(`\nmaterialized files → ${workDir}`);
  for (const p of [...final.tree.keys()].sort()) console.log(`  ${p}`);

  await multiMachineScene();
}

// ── Multi-machine sync (Phase 7) ────────────────────────────────────────────
// Two machines work independently and reconcile by object gossip (`pull`). There is
// no "merge" step: sync just makes both sides hold the same append-only object set,
// and each side's deterministic reduce yields the same tree. A genuine conflict
// becomes the SAME Decision on both replicas — data, not a broken working copy.
const greet = (v: string) => `export function greet() {\n  return "${v}";\n}`;

async function multiMachineScene(): Promise<void> {
  const dirL = join(here, "..", "scratch", "demo-machine-L"); // dev jinbin's laptop
  const dirR = join(here, "..", "scratch", "demo-machine-R"); // a remote teammate
  await rm(dirL, { recursive: true, force: true });
  await rm(dirR, { recursive: true, force: true });
  const L = await Repo.init(dirL);
  const R = await Repo.init(dirR);

  hr("멀티머신 — 공유 base, 그리고 R이 L을 clone(pull)");
  const intent = await L.createIntent({ title: "greeting 모듈", owner: human.id });
  const sL = await L.startSession({ intentOid: intent, actor: agentA });
  const base = await L.proposeFileWrite({ sessionOid: sL, intentOid: intent, actor: agentA, path: "src/mod.ts", content: greet("v0") + "\n", declaredPurpose: "scaffold greet" });
  await R.pull(dirL);
  console.log(`L scaffolds src/mod.ts → R.pull(L): R가 base를 받음`);

  hr("Scene A — 서로 다른 파일 동시 작업 → gossip 후 같은 treeHash로 수렴");
  await L.proposeFileWrite({ sessionOid: sL, intentOid: intent, actor: agentA, path: "src/cache.ts", content: "export class Cache {}\n", declaredPurpose: "L: cache", causalDeps: [base] });
  const sR = await R.startSession({ intentOid: intent, actor: agentB });
  await R.proposeFileWrite({ sessionOid: sR, intentOid: intent, actor: agentB, path: "src/config.ts", content: "export const cfg = {}\n", declaredPurpose: "R: config", causalDeps: [base] });
  await L.pull(dirR);
  await R.pull(dirL);
  const ra = await L.materialize();
  const rb = await R.materialize();
  console.log(`L files: ${[...ra.tree.keys()].sort().join(", ")}`);
  console.log(`R files: ${[...rb.tree.keys()].sort().join(", ")}`);
  console.log(`treeHash L == R ? ${ra.treeHash === rb.treeHash ? "✅ 수렴 (충돌 단계 없음)" : "❌"}`);

  hr("Scene B — 같은 symbol 동시 수정 → 양쪽에 동일한 Decision(충돌은 데이터)");
  await L.proposeSymbolEdit({ sessionOid: sL, intentOid: intent, actor: agentA, path: "src/mod.ts", symbolName: "greet", newText: greet("L-version"), declaredPurpose: "L: greet 변경", causalDeps: [base] });
  await R.proposeSymbolEdit({ sessionOid: sR, intentOid: intent, actor: agentB, path: "src/mod.ts", symbolName: "greet", newText: greet("R-version"), declaredPurpose: "R: greet 변경", causalDeps: [base] });
  await L.pull(dirR);
  await R.pull(dirL);
  const ca = await L.materialize();
  const cb = await R.materialize();
  console.log(`L conflicts: ${ca.conflicts.length}  |  R conflicts: ${cb.conflicts.length}`);
  console.log(`동일 conflict id? ${ca.conflicts[0]?.id === cb.conflicts[0]?.id ? `✅ ${ca.conflicts[0]?.id}` : "❌"}`);
  console.log(`동일 materialized 상태(treeHash)? ${ca.treeHash === cb.treeHash ? "✅" : "❌"}`);
  console.log("→ 사람이 한쪽에서 decision.record 하면, 다음 pull로 양쪽이 같은 해소 상태로 수렴");
}

async function report(repo: Repo) {
  const res = await repo.materialize("main");
  const counts: Record<string, number> = {};
  for (const s of res.statuses.values()) counts[s] = (counts[s] ?? 0) + 1;
  console.log(`status: ${JSON.stringify(counts)}  |  files: ${res.tree.size}  |  conflicts: ${res.conflicts.length}`);
  for (const c of res.conflicts) {
    console.log(`  ⚠ ${c.kind} @ ${c.key} — ${c.reason}`);
    for (const o of c.options) {
      console.log(
        `      · ${o.actor} "${o.purpose}" score=${o.score}` +
          `${o.blocked ? " [blocked]" : ""}${o.requiresHuman ? " [needs-human]" : ""}`,
      );
    }
    if (c.recommendedOp) console.log(`      → 추천: ${c.recommendedOp}`);
  }
  return res;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
