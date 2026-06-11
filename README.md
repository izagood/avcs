# AVCS — Agentic Version Control System

> Git은 "이 코드가 **언제** 바뀌었나"를 기록한다.
> AVCS는 "**누가 / 무슨 의도로 / 어떤 근거로 / 어떤 충돌 결정을 거쳐** 지금 상태가 되었나"를 기록한다.

AVCS는 사람과 다수의 AI 에이전트가 **동시에** 코드를 바꾸는 환경을 1차 대상으로 하는, Git 비호환 신규 VCS입니다. commit/branch/merge/conflict-marker 모델을 버리고, **의도(intent)·세션(session)·연산(operation)·증거(evidence)·결정(decision)**을 1급 객체로 저장합니다. 코드 트리는 이 연산 그래프를 결정론적으로 환원(reduce)해 만든 **projection**일 뿐입니다.

```
state = reduce(base, operationDAG, decisions, policy, materializer)
```

## 핵심 원칙

1. **Commit이 아니라 Operation이 히스토리다.**
2. **파일 경로가 아니라 Entity ID가 정체성이다.**
3. **Merge는 텍스트 선택이 아니라 연산의 결정론적 환원이다.**
4. **Conflict는 깨진 파일이 아니라 1급 Decision 객체다.**
5. **AI 출력은 신뢰된 코드가 아니라 증거가 붙은 제안된 연산이다.**
6. **코드에 last-write-wins를 기본값으로 쓰지 않는다.** 우선순위는 정책이 정한다.

## 지금 동작하는 것 (MVP / Phase 1)

- append-only, content-addressed 객체 저장소 (`.avcs/objects`)
- 7+2 객체 모델: intent · session · operation · evidence · decision · checkpoint · view (+ blob · policy)
- 결정론적 reducer + 정책 엔진. 충돌을 4단계로 분류:
  - **L0/L1** 서로 다른 entity → 자동 병합
  - **L2** 같은 파일 동시 변경 → 정책 자동 결정 (human 우선 등)
  - **L3** 동작 변경인데 증거(테스트) 없음 → 차단
  - **L4** public API 파괴 → 사람 결정 필요 (needs_decision)
- branch 대신 **view**(연산 그래프에 대한 쿼리), commit 대신 **checkpoint**
- 에이전트 1급 인터페이스인 **MCP 서버** (tool 8종)
- 사람용 inspection **CLI**

## 빠른 시작

전제: Node ≥ 22.6 (TypeScript 타입 스트리핑 사용 — 빌드/설치 불필요).

```bash
# 4가지 병합 시나리오를 한 번에 보여주는 데모
node --experimental-strip-types src/demo.ts

# 동작 계약 테스트
node --experimental-strip-types --test test/reducer.test.ts

# 사람용 CLI
node --experimental-strip-types src/cli.ts init .
node --experimental-strip-types src/cli.ts status
node --experimental-strip-types src/cli.ts conflicts
node --experimental-strip-types src/cli.ts log

# 에이전트용 MCP 서버 (optionalDependency 설치 필요)
npm install
AVCS_REPO=$(pwd) node --experimental-strip-types src/mcp/server.ts
```

> 타입 체크(`tsc --noEmit`)는 `npm install` 후 사용. 런타임은 의존성 0으로 동작합니다.

## 코드 지도

| 경로 | 역할 |
|------|------|
| `src/objects/types.ts` | 객체 모델 정의 (단일 진실 공급원) |
| `src/store/objectStore.ts` | append-only content-addressed 저장소 |
| `src/core/canonical.ts` | 정규 직렬화 + content addressing(oid) |
| `src/reducer/reducer.ts` | 연산 그래프 → 코드 트리 환원 + 충돌 분류 |
| `src/reducer/policy.ts` | 정책 엔진(우선순위 사다리) |
| `src/api/repo.ts` | 고수준 파사드 (CLI·demo·MCP 공용) |
| `src/mcp/server.ts` | 에이전트용 MCP 인터페이스 |
| `src/cli.ts` | 사람용 inspection CLI |
| `src/demo.ts` | end-to-end 시나리오 |

## 설계 문서

- [00 — 개요와 원칙](docs/00-overview.md)
- [01 — 아키텍처](docs/01-architecture.md)
- [02 — 객체 모델](docs/02-object-model.md)
- [03 — Reducer와 충돌 등급](docs/03-reducer.md)
- [04 — 정책 엔진](docs/04-policy.md)
- [05 — View · Checkpoint · Release](docs/05-views-checkpoints.md)
- [06 — MCP / Skill 인터페이스](docs/06-mcp-interface.md)
- [07 — 로드맵](docs/07-roadmap.md)

## 상태

연구/프로토타입. MVP는 **파일 단위** 연산입니다. 의미(AST/symbol) 단위 병합은 Phase 2 — reducer의 `conflictKey` 유도와 트리 변형만 교체하면 되도록 설계돼 있습니다.
