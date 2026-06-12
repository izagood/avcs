# 04 — 정책 엔진

구현: [`src/reducer/policy.ts`](../src/reducer/policy.ts). reducer는 정책 객체로 **매개변수화**되어 있어, materialize는 `(ops, decisions, policy, materializer)`의 순수 함수다. 정책이 바뀌면 같은 연산 집합도 다른 결과/다른 checkpoint를 낸다 — 그래서 checkpoint는 `policyOid`를 명시 기록한다.

## 우선순위 사다리

코드에 **last-write-wins를 기본값으로 쓰지 않는다.** 동시 연산이 같은 entity를 다툴 때, 정책이 결정론적으로 + 근거를 남기며 정한다(높은 것부터):

1. 안전/보안 (rule)
2. 명시적 **사람 결정** (Decision 객체 — reducer가 우선 적용)
3. code-owner / **human actor** (`actorTrust` + `prefer_actor`)
4. **intent 제약 만족** 여부 (선언된 effects vs intent constraints)
5. **증거로 검증됨** (require_evidence 게이트 + 보너스)
6. **actor 신뢰도** (`actorTrust` 사다리)
7. 작은 blast radius (advisory)
8. recency(Lamport) — 최후의 tie-break, 단독으로는 결코 승부를 가르지 않음

## 점수화 (`evaluateOp`)

```
score  = actorTrust(actor)            // kind별 사다리 * 100
       ± 200  (intent 제약 만족/위반)
       + 150  (신뢰된 통과 테스트 보유)
       + Σ rule effects
       // lamport는 score에 더하지 않는다. 점수 동률일 때만 reducer의
       // 정렬 비교 단계에서 tie-break으로 쓴다 (lamport → oid).
```
출력: `{ blocked, requiresHuman, score, notes[] }`.
- `blocked` → accepted 불가 (require_evidence 미충족)
- `requiresHuman` → 자동 accept 불가 (require_human 매칭)

> **lamport를 점수에 더하면 안 되는 이유** — lamport는 무한히 증가하므로, 저장소에 연산이 수백 개만 쌓여도 "나중에 쓴 AI"가 `human_wins_conflicts`(+500)를 넘어선다. 즉 원칙 1(last-write-wins 금지)이 조용히 무너진다. 그래서 recency는 *오직 점수 동률일 때만* 비교에 쓴다. (회귀 테스트 `C1`)

> **증거 신뢰** — 연산의 작성자는 자기 변경을 보증할 수 없다. `require_evidence` 게이트와 통과-테스트 보너스는 **작성자가 아닌 신뢰 actor(ci_bot/human)**가 생산한 증거만 센다. 같은 ai_agent가 자기 연산에 붙인 증거는 무시된다(서명은 Phase 3). (회귀 테스트 `H2`)

## 기본 정책 (`defaultPolicy`)

```ts
actorTrust: ["ai_agent", "ci_bot", "human"]   // human이 가장 신뢰됨
rules:
  behavior_change_requires_test   when changesBehavior  → require_evidence unit_test=pass
  public_api_break_requires_human when breaksPublicApi  → require_human
  formatting_low_priority         when kind=note        → priority -50
  human_wins_conflicts            when onConflict        → prefer_actor human (+500)
```

이 4개 규칙만으로 데모의 4개 시나리오가 모두 결정된다:
- Scene 2: 같은 파일 AI vs human → `human_wins_conflicts` → human 자동 채택(L2)
- Scene 3: 동작 변경 + 테스트 없음 → `behavior_change_requires_test` → blocked → 테스트 첨부 후 accepted(L3)
- Scene 4: API 파괴 → `public_api_break_requires_human` → needs_decision(L4)

## 규칙 형태

```ts
PolicyRule = {
  name,
  when: { opKind?, breaksPublicApi?, changesBehavior?, onConflict? },
  effect:
    | { type: "require_human" }
    | { type: "require_evidence", evidence, result }
    | { type: "priority", weight }
    | { type: "prefer_actor", kind }
}
```

## 왜 정책이 위험하고 중요한가

Git에선 충돌 시 사람이 고르므로 잘못된 정책이라는 개념이 없다. AVCS는 시스템이 자동 판단하므로, **정책이 틀리면 잘못된 변경이 조용히 들어간다.** 그래서:

- 정책은 버전이 있고(`version`), checkpoint에 어떤 정책으로 materialize했는지 기록된다.
- `require_human`은 안전판이다 — 정책으로 자신 없는 변경(공개 API 등)은 자동 결정에서 빼고 사람 큐로 보낸다.
- Decision의 `futurePolicy`로 사람이 내린 판단을 규칙으로 승격해 점진적으로 자동화 범위를 넓힌다.

## 확장 (Phase 5)

- code-owner 매핑(경로/심볼 → 소유자)으로 `require_human`을 특정 소유자에게 라우팅
- API contract 규칙(공개 시그니처 변경 탐지)
- security 규칙(취약점 fix 최우선)
- 신뢰도 학습: 에이전트별 과거 accept/reject 비율 → `actorTrust` 동적 조정

→ 다음: [05 — View · Checkpoint · Release](05-views-checkpoints.md)
