# 02 — 객체 모델

단일 진실 공급원: [`src/objects/types.ts`](../src/objects/types.ts). 모든 객체는 content-addressed, append-only.

## 공통

```ts
type ObjectType = "blob"|"intent"|"session"|"operation"|"evidence"|"decision"|"checkpoint"|"view"|"policy";
interface BaseObject { type: ObjectType; oid?: string }  // oid는 저장 시 채워짐
interface Actor { kind: "human"|"ai_agent"|"ci_bot"; id: string; model?: string }
```

`oid`는 `computeOid(type, payload)`로 계산(`src/core/canonical.ts`). 같은 내용은 같은 oid → 저장은 멱등.

## 7개 1급 객체

### Intent — 왜 바꾸는가
목적·제약·성공 기준·허용 범위. 에이전트는 intent **없이** 작업하지 않으며, 그 `allowedScopes` 밖을 건드리지 않는다.
```ts
{ title, owner, kind, priority, constraints[], successCriteria[], allowedScopes[] }
```
`constraints`(예: "public API 변경 금지")는 reducer의 의미 충돌 판정에 직접 쓰인다.

### Session — 누가 어떤 맥락에서
한 에이전트/사람의 작업 에피소드. **distilled, redaction-safe** 요약만 저장한다. raw transcript는 저장소가 아니라 별도 단기 암호화 스토어로(이유: [06](06-mcp-interface.md#보안) — Entire처럼 transcript를 repo에 영구 저장하면 안 됨).
```ts
{ intentOid, actor, baseViewOid, summary, openedEntities[], toolCalls[] }
```

### Operation — 진짜 히스토리
의미 단위 변경 1개. MVP는 파일 단위지만 **의미 봉투(envelope)**를 함께 들고 있어 Phase-2 AST 업그레이드가 가산적이다.
```ts
{ sessionOid, intentOid, actor,
  target: { entityKind: "file"|"symbol"|"contract"|"config"|"test", entityId },
  body:   { kind: "put_file"|"delete_file"|"rename_file"|"note", path?, fromPath?, blobOid? },
  causalDeps[],            // 이 연산이 "보고 나서" 작성된 선행 연산들
  declaredPurpose,
  effects?: { reads[], changesBehavior?, breaksPublicApi? },
  lamport,                 // 동시 연산의 결정론적 tie-break
  confidence? }            // 자기 보고 — 절대 권위 아님
```
연산의 **status는 객체에 저장하지 않는다.** evidence/decision + policy로 materialize 시점에 *유도*된다(`OperationStatus`: proposed/validating/accepted/rejected/superseded/needs_decision/quarantined).

### Evidence — 근거
연산에 붙는 기계 검증. "에이전트가 고쳤다"는 증거가 아니다.
```ts
{ forOps[], kind: "unit_test"|"typecheck"|"lint"|..., result: "pass"|"fail"|"partial"|"not_run", producedBy, command?, detail? }
```

### Decision — 충돌/선택의 기록
충돌 해결도 저장소 데이터다. 다음 에이전트가 같은 충돌을 반복하지 않게 한다.
```ts
{ conflictId, chosenOps[], rejectedOps[], reason, decidedBy, futurePolicy? }
```
`futurePolicy`("UserService cache는 Redis 우선")는 정책으로 승격될 수 있는 재사용 규칙.

### View — branch 대체 (쿼리)
```ts
{ name, baseViewOid, query: { includeStatuses[], intentOids?, sessionOids?, excludeOps? } }
```
실제 fork가 아니라 연산 그래프에 대한 **선언적 쿼리**. 에이전트 100개가 붙어도 branch 폭발이 없다(상세: [05](05-views-checkpoints.md)).

### Checkpoint — commit 대체 (상태 벡터)
```ts
{ viewOid, headOps[], treeHash, policyOid, materializerVersion, evidence{}, status: "draft"|"verified"|"released", summary }
```
단순 스냅샷이 아니라 **(연산 frontier + 정책 + materializer + 증거)**의 묶음. 정책이 다르면 다른 checkpoint.

## 보조 객체

- **Blob** — raw 콘텐츠(base64; 추후 청크 분할).
- **Policy** — reduce를 매개변수화하는 규칙 집합. [04](04-policy.md) 참조.

## Entity ID가 핵심

파일 경로는 정체성이 아니다. MVP에선 `entityId = 파일 경로`지만, Phase 2에선:
```
symbol:UserService.findById   (이름이 바뀌어도 동일 id 유지)
```
덕분에 "A가 rename, B가 body edit"이 같은 symbol에 대한 두 연산으로 자동 병합된다. Pijul이 파일/디렉토리를 이름 vertex와 inode vertex로 분리하는 것과 같은 발상이다.

→ 다음: [03 — Reducer](03-reducer.md)
