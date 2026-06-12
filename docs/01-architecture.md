# 01 — 아키텍처

## 계층

```
┌──────────────────────────────────────────────┐
│ Human Decision Layer                          │  사람이 봐야 하는 설계 선택만
│  - conflict → 선택지 + 영향도 + 검증 결과       │  (cli.ts conflicts / MCP conflict.list)
├──────────────────────────────────────────────┤
│ Agent Protocol Layer        ← 1급 인터페이스    │  MCP tools / skill rules
│  - intent/session/operation/evidence 제출      │  (src/mcp/server.ts)
├──────────────────────────────────────────────┤
│ Intent & Session Layer                        │  왜·누가·무슨 맥락에서
│  - 목적, 제약, 도구 호출, 버린 대안             │  (Intent, Session)
├──────────────────────────────────────────────┤
│ Semantic Operation Layer                      │  의미 단위 변경 (MVP: 파일 단위)
│  - put/delete/rename/note (+ effects 선언)     │  (Operation)
├──────────────────────────────────────────────┤
│ Validation & Evidence Layer                   │  test/typecheck/lint/...
│  - 연산에 붙는 검증 결과                        │  (Evidence)
├──────────────────────────────────────────────┤
│ Deterministic Reducer + Policy                │  연산 그래프 → 상태 + 충돌
│                                                │  (src/reducer/*)
├──────────────────────────────────────────────┤
│ Object Store                                   │  append-only, content-addressed
│  - Merkle DAG                                  │  (src/store/objectStore.ts)
└──────────────────────────────────────────────┘
```

Git이 가졌던 것은 맨 아래 두 계층(스냅샷 저장 + 텍스트 머지)뿐이다. AVCS는 그 위에 **에이전트 맥락**과 **증거**와 **정책 기반 환원**을 올린다.

## 데이터 흐름 (에이전트 한 사이클)

```
intent.create ──▶ session.start ──▶ (코드 작업) ──▶ operation.propose ─┐
                                                                        │
        ┌── view.materialize ◀── evidence.attach ◀──────────────────────┘
        │        │
        │        ├─ 깨끗함 → accepted → checkpoint.create
        │        └─ 충돌 → conflict.list ──▶ (사람) decision.record ──▶ 재-materialize
        ▼
   working tree projection (writeWorkspace)
```

코드 트리는 항상 `materialize`의 결과다. 에이전트가 파일을 직접 고치더라도(현실적 fallback), accepted 히스토리에는 **operation**으로 들어간다.

## 결정론 경계

`reduce`는 순수 함수다. 입력은 정확히 다음 다섯 가지다.

```
reduce(base_state, operationDAG, decisions, policy, materializerVersion)
```

- 같은 입력 → 같은 `treeHash` (테스트 `materialization is deterministic`로 고정).
- `policy`와 `materializerVersion`이 입력에 **포함**되므로, 정책이 바뀌면 같은 연산 집합도 다른 checkpoint가 된다. checkpoint는 이 둘을 명시 기록한다.

## 물리 레이아웃

```
<repo>/
  .avcs/
    HEAD                       활성 view 이름
    refs/
      policy                   현재 정책 oid
      view:main                기본 view oid
      checkpoint:main:latest   최근 checkpoint oid
    objects/
      <aa>/<oid>.json          불변 객체 (oid 앞 2 hex로 샤딩)
```

- 객체는 **수정/삭제되지 않는다.** 세상을 바꾸는 유일한 방법은 새 객체를 append하는 것(새 연산, decision, superseding op).
- `oid = type_ + sha256(type + canonicalJSON(payload))[:32]`. content addressing은 고정점이어야 하므로 `oid` 필드는 자기 해시에 포함되지 않는다.
- 직렬화는 `src/core/canonical.ts` 한 곳에 격리 → 추후 canonical CBOR로 교체 가능.

## 동기화 (설계, 미구현)

Git push/pull이 아니라 **operation gossip**:

```
A.heads = [op_10, op_11]      B.heads = [op_10, op_12]
A → op_11,  B → op_12
양쪽: 서명 검증 → causal dep 확인 → 같은 policy로 reduce → 같은 view
```

동기화 단위는 branch가 아니라 객체(intents/sessions/ops/evidence/decisions/checkpoints/policies)다.

→ 다음: [02 — 객체 모델](02-object-model.md)
