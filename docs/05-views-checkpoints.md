# 05 — View · Checkpoint · Release

## View — branch를 대체한다

Git branch는 commit 포인터이고, 합치려면 복사·merge가 필요하다. 에이전트 100개가 동시에 붙으면 branch가 폭발한다.

AVCS의 **view는 연산 그래프에 대한 쿼리**다(실제 fork 아님). 구현: `Repo.materialize` ([`src/api/repo.ts`](../src/api/repo.ts)).

```ts
View.query = { includeStatuses[], intentOids?, sessionOids?, excludeOps? }
```

개념적으로:
```sql
SELECT ops FROM operation_log
WHERE (intentOids 비었거나 op.intent ∈ intentOids)
  AND (sessionOids 비었거나 op.session ∈ sessionOids)
  AND op.oid ∉ excludeOps
ORDER BY causal_order;
-- 그 위에 reduce(policy)를 적용해 tree/status/conflicts 산출
```

대표 view:

| view | 쿼리 의미 |
|------|-----------|
| `main` | 후보 전체 → accepted만 materialize (기본) |
| `intent/<id>` | 특정 intent의 연산만 |
| `agent/<session>` | 특정 세션의 speculative 연산 포함 |
| `validated` | 검증 통과 연산만 |
| `review-required` | `needs_decision` 연산만 (사람 큐) |
| `release-candidate` | accepted + full validation pass |

같은 연산 그래프 위에서 view를 갈아끼우는 것이므로, "agent/123이 main에 합쳐지면?"은 복사가 아니라 **쿼리 결과를 다시 reduce**하는 것이다.

## Checkpoint — commit을 대체한다

Git commit = 파일 트리 스냅샷. AVCS checkpoint = **상태 벡터**:

```ts
{ viewOid, headOps[], treeHash, policyOid, materializerVersion, evidence{}, status, summary }
```

즉 **(연산 frontier + 정책 + materializer + 증거)**의 묶음이다. 핵심 함의:
- 같은 연산 집합이라도 **정책이 다르면 다른 checkpoint** → 재현성.
- `status`: 충돌 0개면 `verified`, 아니면 `draft`. accepted 연산에 붙은 증거만 집계.
- checkpoint는 rewind/resume/review/release의 단위. Entire의 checkpoint(되돌릴 수 있는 save point)를 commit에 묶지 않고 일반화한 것.

checkpoint 생성 시점(권장): 큰 편집 완료 / 테스트 통과 / build 실패 전후 / 사람 승인 / 머지 전후 / export 직전.

## Release — tag를 대체한다 (설계, Phase 6)

```ts
Release = { checkpointOid, signedBy[], evidence{ full_test, security_scan, container_build }, artifacts[] }
```

단순 이름표가 아니라 **검증된 checkpoint + 증거 + 아티팩트 + 서명**. MLOps/온프렘까지 보면 release가 container image·Helm chart·SBOM·firmware까지 provenance로 연결한다.

## 동시성: WorkLease (설계, Phase 3+)

충돌을 사후에 푸는 대신, 작업 **시작 단계**에서 가능성을 줄인다. lock이 아니라 soft lease:

```ts
WorkLease = { intent, session, scope: { write[], read[] }, mode: "optimistic", expiresAt }
```
- 같은 symbol의 **public contract**는 동시에 한 에이전트만 변경(exclusive)
- 같은 함수 **body**는 여러 에이전트가 speculative proposal 허용(optimistic)
- formatting/test 추가는 대체로 병렬 허용
- migration/schema 변경은 exclusive lease 필요

## Context Pack (설계, Phase 3+)

에이전트가 코드베이스를 과도하게 읽는 문제를 줄이려, 저장소가 필요한 맥락을 직접 만들어 준다:

```ts
ContextPack = { symbols[], tests[], decisions[], risks[], suggestedOps[] }
```
MCP `resources`로 노출. 과거 `decision`을 포함시켜 "이 repo에선 cache는 Redis 우선" 같은 학습된 제약을 주입한다.

→ 다음: [06 — MCP / Skill 인터페이스](06-mcp-interface.md)
