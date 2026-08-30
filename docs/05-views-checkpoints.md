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

### 투영의 기본형은 bytes다

checkpoint를 파일로 되돌리는(투영) API 는 두 층이다. **bytes 가 본체이고 string 은 그 위의 얇은 래퍼다** — 반대가 아니다.

```ts
repo.checkpointBytes(cp)  // { treeHash, treeHashOk, files: [{ path, bytes: Buffer }] }
repo.checkpointFiles(cp)  // 같은 것의 utf8 view. bytes.toString("utf8")
```

저장 계층은 이미 전부 Buffer 다(`readBlob`, `materializedBytes`, `putBlob` 은 `string | Uint8Array` 를 받는다). string 은 가장 바깥 한 겹에만 있었고, 그 한 겹이 바이너리를 파괴했다:

```
원본    89504e470d0a1a0afffe0080      12 bytes   PNG 시그니처 + 유효하지 않은 UTF-8
왕복 후 efbfbd504e470d0a1a0aefbfbd…  20 bytes   유효하지 않은 시퀀스가 전부 U+FFFD
```

U+FFFD 로의 치환은 되돌릴 수 없다. 그래서 손상의 무게가 호출자마다 다르다:

- **비교하는 쪽**(`avcs verify-git` 등)에서는 서로 다른 두 바이너리가 **같다고** 나온다. "푸시 전에 검증한다"가 아무것도 검증하지 않게 된다.
- **되돌리는 쪽**(`revert`)이 훨씬 나쁘다. `revert` 는 이전 내용을 **새 op 으로 다시 저자화**하므로, 손상된 바이트가 append-only 그래프에 기록되고 회수할 수 없다.

판단 기준은 하나다 — **투영을 밖으로 내보내면 bytes, 줄 단위로 다루면 string**. `blame`·`diff` hunk·merge3 는 진짜로 줄을 원하므로 string view 를 그대로 쓴다.

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
