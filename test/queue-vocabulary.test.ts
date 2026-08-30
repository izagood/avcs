// 코어가 소비자에게 이름을 주지 않아 밖에서 지어 쓰던 둘 (우회 감사 ⑥·⑦).
//
// 둘의 모양이 같다. 코어가 어떤 개념을 **내부에만** 두면, 그것이 필요한 소비자는 그 개념을
// 밖에서 다시 만든다. 그리고 그 재현물은 코어와 조용히 갈라진다 — 타입 검사가 닿지 않기
// 때문이다.
//
//   ⑥ 예약: 코어가 로컬 aux 파일에만 둬서 다중 인스턴스가 못 쓴다. 소비자는 그림자 스키마와
//     양방향 번역기를 만들었고, 번역기 반환형이 `Record<string, unknown>` 이라 **코어가
//     필드를 하나 추가해도 아무도 모른다.**
//
//   ⑦ evidence 어휘: `EvidenceKind` 가 닫힌 8개 union 이라 build·deploy·publish·smoke 같은
//     잡은 표현할 이름이 없다. 소비자는 evidence 를 두 평면에 두 번 기록하고, 매핑에서
//     빠진 잡들은 **영원히 unbound** 다.
//
// 여기서 여는 것은 최소한이다 — 이름을 준다. 저장 포트 주입(⑥의 큰 안)과 hub 의 M4 경로
// 접기(⑦의 큰 안)는 이름이 먼저 있어야 할 수 있는 일이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";
// 진입점에서 — 소비자가 실제로 받는 경로다.
import type { IntegrationReservation } from "../src/index.ts";
// `EvidenceKind` 는 `@izagood/avcs/types` 서브패스로 이미 도달하므로 진입점 문제는 아니다.
import type { EvidenceKind } from "../src/objects/types.ts";
import type { Actor, Protection, RoleName } from "../src/objects/types.ts";
import { generateKeypair } from "../src/core/identity.ts";

const ai: Actor = { kind: "ai_agent", id: "ai:a" };
const ci: Actor = { kind: "ci_bot", id: "ci:runner" };

/**
 * A repo with a protected `main` and real memberships — the shape `integrate-evidence.test.ts`
 * already uses. Without the memberships `submitIntegration` answers `rejected` for lack of
 * `finalizeRole`, which is not what these tests are about (and it silently made a regression
 * guard here pass for the wrong reason once).
 */
async function org(requiredChecks: EvidenceKind[]) {
  const dir = await mkdtemp(join(tmpdir(), "avcs-vocab-"));
  const repo = await Repo.init(dir);
  const root = generateKeypair();
  const keys = new Map<string, string>();
  const mk = async (id: string, role: RoleName): Promise<void> => {
    const k = generateKeypair();
    keys.set(id, k.privateKey);
    await repo.registerMembership({
      actorId: id, publicKey: k.publicKey, role,
      root: { keyId: "root", privateKey: root.privateKey },
    });
  };
  await mk("human:h", "maintainer");
  await mk("ci:runner", "proposer");
  await mk("ai:a", "proposer");
  await repo.setProtection({
    view: "main", requiredApprovals: 0, requireOwnerApproval: false, requiredChecks,
    finalizeRole: "maintainer", requireSignedOps: false, requireUpToDate: true, allowForcePush: false,
  } as Omit<Protection, "type" | "createdAt">);
  return { dir, repo, ciSign: { keyId: "ci:runner", privateKey: keys.get("ci:runner")! } };
}

async function author(repo: Repo, path: string, content: string): Promise<string> {
  const intent = await repo.createIntent({ title: path, owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  return repo.proposeFileWrite({
    sessionOid: sess, intentOid: intent, actor: ai, path, content, declaredPurpose: path,
  });
}

// ⑥ — 소비자의 번역기가 타입 검사를 받으려면 이 이름이 있어야 한다.
test("IntegrationReservation 은 진입점을 통해 도달하는 타입이다", async () => {
  const { dir, repo, ciSign } = await org(["unit_test"]);
  try {
    const opA = await author(repo, "a.ts", "A\n");
    // 증거 → 체크포인트 순서. 반대로 하면 체크포인트의 evidence 가 비어 rejected 가 된다.
    await repo.attachEvidence({
      forOps: [opA], kind: "unit_test", result: "pass", producedBy: ci,
      treeHash: (await repo.materialize()).treeHash, signWith: ciSign });
    const cpA = await repo.createCheckpoint("main", "A");
    const advanced = await repo.submitIntegration({ view: "main", checkpoint: cpA, by: "human:h" });
    assert.equal(advanced.verdict, "advanced", JSON.stringify(advanced));

    // 겹치는 제출을 만들어 needs_evidence 예약을 남긴다.
    const opB = await author(repo, "a.ts", "B\n");
    const frontier = await repo.materializeAt([opB]);
    const view = await repo.getView("main");
    const stale = await repo.store.put({
      type: "checkpoint", viewOid: view.oid as string, headOps: frontier.headOps,
      treeHash: frontier.treeHash, policyOid: (await repo.store.getRef("policy"))!,
      materializerVersion: (await import("../src/reducer/policy.ts")).MATERIALIZER_VERSION,
      evidence: {}, status: "draft" as const, summary: "stale", createdAt: new Date().toISOString(),
    });
    const r = await repo.submitIntegration({ view: "main", checkpoint: stale, by: "human:h" });
    assert.equal(r.verdict, "needs_evidence", JSON.stringify(r));

    const raw = await repo.store.readAux("queue/main.json");
    assert.ok(raw, "needs_evidence 는 예약을 남긴다");

    // 소비자가 하는 일 그대로: 읽어서 **이름 있는 타입** 에 담는다. 코어가 필드를 추가하면
    // 여기서 잡힌다 — Record<string, unknown> 이었을 때는 잡히지 않았다.
    const resv = JSON.parse(raw.toString("utf8")) as IntegrationReservation;
    assert.equal(typeof resv.ticketId, "string");
    assert.equal(typeof resv.treeHash, "string");
    assert.ok(Array.isArray(resv.requiredChecks));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ⑦ — 닫힌 어휘가 표현하지 못하던 잡.
//
// 이 결함은 **타입 수준에만** 있다. 엔진은 문자열을 그대로 비교하므로 `custom:deploy` 는
// 런타임에서 이미 동작한다. 그래서 이 테스트들의 빨강은 테스트 러너가 아니라 `tsc` 에서
// 난다 — 캐스트를 쓰면 결함이 가려진다(실제로 처음에 그렇게 써서 초록이 났다).
test("custom:<name> 이 evidence 종류로 통한다", async () => {
  const kind: EvidenceKind = "custom:deploy";
  const { dir, repo, ciSign } = await org([kind]);
  try {
    const op = await author(repo, "a.ts", "A\n");
    // 증거를 먼저 붙인다 — `createCheckpoint` 가 증거를 스냅샷하므로 뒤에 붙이면
    // 그 체크포인트에는 없다(docs/05: checkpoint = 프론티어 + 정책 + 증거).
    const T = (await repo.materialize()).treeHash;
    await repo.attachEvidence({ forOps: [op], kind, result: "pass", producedBy: ci, treeHash: T , signWith: ciSign });
    const cp = await repo.createCheckpoint("main", "A");
    const r = await repo.submitIntegration({ view: "main", checkpoint: cp, by: "human:h" });
    assert.equal(r.verdict, "advanced", `custom 증거가 요구를 만족해야 한다 — got ${JSON.stringify(r)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 위조 방지: 매칭은 정확 문자열이다. `custom:` 이 열렸다고 비슷한 이름이 서로를 만족시키면
// required check 가 의미를 잃는다.
test("custom 이름은 정확히 일치해야 만족한다", async () => {
  const { dir, repo, ciSign } = await org(["custom:deploy"]);
  try {
    const op = await author(repo, "a.ts", "A\n");
    // 증거를 먼저 붙인다 — `createCheckpoint` 가 증거를 스냅샷하므로 뒤에 붙이면
    // 그 체크포인트에는 없다(docs/05: checkpoint = 프론티어 + 정책 + 증거).
    const T = (await repo.materialize()).treeHash;
    await repo.attachEvidence({
      forOps: [op], kind: "custom:deploy-staging",
      result: "pass", producedBy: ci, treeHash: T, signWith: ciSign });
    const cp = await repo.createCheckpoint("main", "A");
    const r = await repo.submitIntegration({ view: "main", checkpoint: cp, by: "human:h" });
    assert.notEqual(r.verdict, "advanced", "다른 이름이 요구를 만족시키면 안 된다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 회귀 방지: 기존 8개 어휘는 그대로다. 위 두 테스트가 "아무것도 통과 못 한다" 로 초록이
// 되는 것을 막는 대조군이기도 하다.
test("기존 evidence 어휘는 그대로 동작한다", async () => {
  const { dir, repo, ciSign } = await org(["unit_test"]);
  try {
    const op = await author(repo, "a.ts", "A\n");
    // 증거를 먼저 붙인다 — `createCheckpoint` 가 증거를 스냅샷하므로 뒤에 붙이면
    // 그 체크포인트에는 없다(docs/05: checkpoint = 프론티어 + 정책 + 증거).
    const T = (await repo.materialize()).treeHash;
    await repo.attachEvidence({ forOps: [op], kind: "unit_test", result: "pass", producedBy: ci, treeHash: T , signWith: ciSign });
    const cp = await repo.createCheckpoint("main", "A");
    const r = await repo.submitIntegration({ view: "main", checkpoint: cp, by: "human:h" });
    assert.equal(r.verdict, "advanced", JSON.stringify(r));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
