# 03 — Reducer와 충돌 등급

구현: [`src/reducer/reducer.ts`](../src/reducer/reducer.ts). AVCS에는 **merge가 없다.** 대신:

```
ReductionResult = reduce({ ops, evidence, decisions, intents, policy })
  → { tree, treeHash, statuses, conflicts, headOps }
```

## 알고리즘

1. **인과 그래프 구축** — `causalDeps`의 전이 폐포로 각 연산의 조상 집합 `ancestry()`.
2. **충돌 키로 그룹화** — `keysOf(op)` = 다툼의 단위. 모든 파일 연산은 `file:<path>`로 키잉된다(쓰기·편집·삭제·리네임이 같은 경로 키를 공유하므로 "삭제 vs 동시 편집"도 다툼이 된다). 코어는 언어 중립이라 symbol/슬롯 단위 키는 쓰지 않는다([15](15-language-neutral-core.md)).
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
| **L1** | 같은 파일, 겹치지 않는 라인 | 자동 병합 (line-level 3-way / `merge3`) | — |
| **L2** | 같은 슬롯 동시 변경, 정책 결정 가능 | 정책 자동 결정 (예: human 우선) | Scene 2 |
| **L3** | 문법 병합되나 의미 깨질 수 있음 | 증거 필요 — 없으면 차단 | Scene 3 |
| **L4** | 정책으로도 불가 (아키텍처 선택) | `needs_decision` → 사람 | Scene 4 |

> 같은 파일이라도 겹치지 않는 편집은 line-level 3-way(`merge3`)로 자동 병합되고, 겹치는 라인 범위만 충돌로 승격된다. 머지 기질은 언어 중립이라 함수/심볼 경계를 알지 못한다 — 행 범위만 본다([15](15-language-neutral-core.md)).

### L3가 중요한 이유: 의미 충돌

텍스트 충돌이 없어도 의미가 깨질 수 있다.
```
A: findById return type을 User|null 로 변경
B: findById가 항상 User를 반환한다고 가정하고 호출부 추가
```
줄이 겹치지 않으니 Git은 통과시키지만 런타임은 깨진다. AVCS는 `effects.breaksPublicApi`/`changesBehavior` 선언 + 증거 게이트로 이를 잡는다. 타입체크·정적분석 같은 검사는 evidence(`typecheck`/`api_compat`/`security_scan` 등)로 부착돼 게이트에 반영된다.

## 결정론 보장

- 정렬은 전순서다: 인과(조상 우선) → `lamport` → `oid`. 동점 없는 전순서이므로 replica 독립적.
- wall-clock은 절대 승부에 쓰지 않는다(텔레메트리 전용).
- `treeHash`는 정렬된 트리의 정규 직렬화 해시 → 같은 입력 같은 해시(테스트로 고정).

## Conflict 객체 (유도)

```ts
{ id,                       // = conflict_ + sha256(key)[:24] — 충돌 entity로만 결정
  key, kind: "concurrent_write"|"needs_human",
  options: [{ opOid, actor, purpose, evidence[], score, blocked, requiresHuman }],
  recommendedOp,            // 정책 추천 (requiresHuman이면 null — 자동 적용 금지)
  reason }
```
`id`는 충돌 entity(key)로만 결정되므로 head 집합이 바뀌어도 **안정적**이다. 단, Decision은 conflictId가 아니라 **op oid 단위**(chosenOps/rejectedOps)로 적용된다 — 그래서 사람이 거부한 연산은 이후 같은 키에 새 동시 연산이 추가돼도 부활하지 않는다(회귀 대상 `H1`). 같은 충돌에 모순된 decision이 둘이면 **정규 순서상 나중 것이 이긴다**(C2).

### 정책 자동 결정도 기록된다 (autoDecision)

L2에서 정책이 패자를 조용히 reject하지 않는다. 모든 자동 결정은 `ReductionResult.autoDecisions`에 `{ key, chosenOp, rejectedOps, reason, policyVersion }`로 남아 감사 가능하다(`H4`). 사람의 Decision과 동일한 추적성을 정책 결정에도 부여한다.

## 사람이 보는 것

conflict marker가 아니다. 이런 형태다:
```
결정 필요: UserService.findById not-found 정책
  A. User|null 반환  — API breaking, 호출부 7곳 수정
  B. 기존 exception 유지 — public API 유지, intent와 일치
  추천: B (intent 제약: public API 변경 금지)
```

→ 다음: [04 — 정책 엔진](04-policy.md)
