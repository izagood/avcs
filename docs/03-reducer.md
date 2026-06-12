# 03 — Reducer와 충돌 등급

구현: [`src/reducer/reducer.ts`](../src/reducer/reducer.ts). AVCS에는 **merge가 없다.** 대신:

```
ReductionResult = reduce({ ops, evidence, decisions, intents, policy })
  → { tree, treeHash, statuses, conflicts, headOps }
```

## 알고리즘

1. **인과 그래프 구축** — `causalDeps`의 전이 폐포로 각 연산의 조상 집합 `ancestry()`.
2. **충돌 키로 그룹화** — `conflictKey(op)` = 다툼의 단위. MVP: 파일 경로(쓰기는 `path`, 삭제/리네임은 `fromPath`라 "삭제 vs 동시 편집"이 다툼이 됨). Phase 2: `symbol:...`, `contract:...`.
3. **각 키의 frontier(heads) 산출** — 그룹 내 다른 연산의 조상이 아닌 연산들. 비-head는 후손에 의해 `superseded`.
4. **head 수로 분기:**
   - **head 1개** → 비충돌. `evaluateOp`로 평가:
     - `blocked`(증거 게이트 실패) 또는 decision이 reject → `rejected`
     - `requiresHuman`이고 decision 없음 → `needs_decision` (+ conflict 생성, 트리에서 제외)
     - 그 외 → `accepted`
   - **head 2개+** → 충돌:
     - 해당 충돌의 **decision**이 있으면 그대로 적용(chosen accept / 나머지 reject)
     - 없으면 **정책 환원**: `blocked` 제거 → 점수 순 정렬 → 유일 최고점이면 자동 결정(L2), `requiresHuman`/동점이면 `needs_decision`(L4)
5. **Materialize** — accepted 연산을 (인과 → lamport → oid) 순으로 정렬해 트리에 적용. `treeHash = sha256(canonical(정렬된 path→blob))`.

`statuses`는 모든 연산의 유도 상태 맵, `conflicts`는 사람 결정 대기열이다.

## 충돌 5등급

| 등급 | 상황 | AVCS 처리 | 데모 |
|------|------|-----------|------|
| **L0** | 서로 다른 entity (다른 파일) | 자동 병합 | Scene 1 |
| **L1** | 같은 파일, 다른 의미 슬롯 | 자동 병합 (Phase 2: AST 슬롯) | — |
| **L2** | 같은 슬롯 동시 변경, 정책 결정 가능 | 정책 자동 결정 (예: human 우선) | Scene 2 |
| **L3** | 문법 병합되나 의미 깨질 수 있음 | 증거 필요 — 없으면 차단 | Scene 3 |
| **L4** | 정책으로도 불가 (아키텍처 선택) | `needs_decision` → 사람 | Scene 4 |

> MVP는 파일 단위라 L0와 L1이 사실상 같게 동작한다. Phase 2에서 `conflictKey`를 symbol/슬롯으로 좁히면 L1(같은 파일·다른 함수)이 L0처럼 자동 병합된다. reducer의 나머지는 그대로다.

### L3가 중요한 이유: 의미 충돌

텍스트 충돌이 없어도 의미가 깨질 수 있다.
```
A: findById return type을 User|null 로 변경
B: findById가 항상 User를 반환한다고 가정하고 호출부 추가
```
줄이 겹치지 않으니 Git은 통과시키지만 런타임은 깨진다. AVCS는 `effects.breaksPublicApi`/`changesBehavior` 선언 + 증거 게이트로 이를 잡는다. MVP는 선언 기반, Phase 2는 타입체크/정적분석을 머지 파이프라인에 넣어 자동 판정.

## 결정론 보장

- 정렬은 전순서다: 인과(조상 우선) → `lamport` → `oid`. 동점 없는 전순서이므로 replica 독립적.
- wall-clock은 절대 승부에 쓰지 않는다(텔레메트리 전용).
- `treeHash`는 정렬된 트리의 정규 직렬화 해시 → 같은 입력 같은 해시(테스트로 고정).

## Conflict 객체 (유도)

```ts
{ id,                       // = conflict_ + sha256(key + 정렬된 opOids)[:24]
  key, kind: "concurrent_write"|"needs_human",
  options: [{ opOid, actor, purpose, evidence[], score, blocked, requiresHuman }],
  recommendedOp,            // 정책 추천 (requiresHuman이면 null — 자동 적용 금지)
  reason }
```
`id`가 결정론적이므로, 사람이 같은 충돌에 대해 내린 decision은 재-materialize 시 자동 매칭된다.

## 사람이 보는 것

conflict marker가 아니다. 이런 형태다:
```
결정 필요: UserService.findById not-found 정책
  A. User|null 반환  — API breaking, 호출부 7곳 수정
  B. 기존 exception 유지 — public API 유지, intent와 일치
  추천: B (intent 제약: public API 변경 금지)
```

→ 다음: [04 — 정책 엔진](04-policy.md)
