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

## 지금 동작하는 것 (Phase 1–6 구현 완료)

- **저장 코어** — append-only, content-addressed 객체 저장소(`.avcs/objects`), 8+2 객체 모델: intent · session · operation · evidence · decision · checkpoint · view · lease · release (+ blob · policy)
- **결정론적 reducer + 정책 엔진** — 충돌 등급화:
  - **L0/L1** 서로 다른 entity / 같은 파일 다른 **symbol** → 자동 병합
  - **L2** 같은 슬롯 동시 변경 → 정책 자동 결정 (human 우선·신뢰도). 자동 결정도 `autoDecisions`로 기록
  - **L3** 동작 변경인데 신뢰된 증거 없음 → 차단 / **선언 안 한 계약 변경 + 호출부** → 의미 충돌 자동 escalate
  - **L4** public API 파괴 → 사람 결정 필요, **소유자에게 라우팅**
- **의미(symbol) 단위 병합** (Phase 2) — tree-sitter 교체 가능한 `EntityIndexer`
- **암호 신뢰** (Phase 3) — ed25519 서명된 evidence/decision, 위조 시 신뢰 게이트 탈락. 실제 검증 러너 · WorkLease · RepairContext
- **의미 충돌 탐지 + 결정 메모리** (Phase 4) — 시그니처 drift 탐지, `recallDecisions`/`learnedPolicies`
- **정책 심화** (Phase 5) — code-owner 라우팅 · 신뢰도 학습(bounded)
- **Release & provenance** (Phase 6) — 검증된 checkpoint + SBOM(CycloneDX) + 서명된 아티팩트
- branch 대신 **view**, commit 대신 **checkpoint**, tag 대신 **release**
- 에이전트 1급 인터페이스 **MCP 서버**(tool 14종) · 사람용 **CLI** · **30개 테스트**(회귀 포함) 통과 · `tsc` clean

> 깊이 표기: 각 phase는 **동작하는 MVP 깊이**다(파일/심볼 단위 머지, ed25519 서명, 휴리스틱 계약 분석). 실제 tree-sitter/타입체크 연동, 다중 서명, 분산 동기화는 [로드맵](docs/07-roadmap.md)의 후속 항목.

## 빠른 시작

전제: Node ≥ 22.6 (TypeScript 타입 스트리핑 사용 — 빌드/설치 불필요).

```bash
# 4가지 병합 시나리오를 한 번에 보여주는 데모
node --experimental-strip-types src/demo.ts

# 동작 계약 테스트 (회귀 포함 30개)
node --experimental-strip-types --test test/*.test.ts   # 또는: npm test

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
| `src/core/identity.ts` | ed25519 서명/검증 + Keyring (Phase 3) |
| `src/reducer/reducer.ts` | 연산 그래프 → 코드 트리 환원 + 충돌 분류 |
| `src/reducer/policy.ts` | 정책 엔진(우선순위 사다리, 신뢰도 nudge) |
| `src/semantic/symbols.ts` | symbol 파서(EntityIndexer) — symbol 단위 머지 (Phase 2) |
| `src/semantic/contract.ts` | 시그니처 분석 + 의미 충돌 탐지 (Phase 4) |
| `src/policy/owners.ts` · `reliability.ts` | code-owner 라우팅 · 신뢰도 학습 (Phase 5) |
| `src/validation/runner.ts` · `repair.ts` | 검증 러너 · RepairContext (Phase 3) |
| `src/concurrency/lease.ts` | WorkLease (Phase 3) |
| `src/release/sbom.ts` | SBOM 생성 (Phase 6) |
| `src/api/repo.ts` | 고수준 파사드 (CLI·demo·MCP 공용) |
| `src/mcp/server.ts` | 에이전트용 MCP 인터페이스 (tool 14종) |
| `src/cli.ts` | 사람용 inspection/release CLI |
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
