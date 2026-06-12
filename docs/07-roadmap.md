# 07 — 로드맵

MVP에서 가장 중요한 건 semantic merge를 완벽히 만드는 게 **아니다.** 먼저 만들 5가지:

1. 에이전트가 작업을 **intent/session**으로 시작하게 만들기
2. 모든 변경을 **operation**으로 제출하게 만들기
3. 모든 검증을 **evidence**로 저장하기
4. **accepted/pending/rejected** 상태를 명확히 나누기
5. 사람의 결정을 **decision**으로 남기기

이 5개만으로도 Git보다 agentic coding에 잘 맞는다. ✅ **Phase 1에서 전부 구현됨.**

## Phase 1 — 코어 원장 ✅ (현재)
- append-only content-addressed 객체 저장소 (`src/store`)
- intent/session/operation/evidence/decision/checkpoint/view 객체 (`src/objects`)
- 파일 단위 연산 + 결정론적 reducer + 정책 엔진 (`src/reducer`)
- MCP 서버 8 tool (`src/mcp`), 사람용 CLI (`src/cli`)
- 4단계 충돌(L0–L4) end-to-end 데모 + 동작 계약 테스트

## Phase 2 — 의미(symbol) 인지 머지 ✅
- 파일을 symbol/gap span으로 파싱하는 `EntityIndexer` (`src/semantic/symbols.ts`) — MVP는 TS/JS용 brace 스캐너, Tree-sitter 백엔드를 끼울 수 있는 인터페이스
- `set_symbol` 연산 + `conflictKey`를 `symbol:<file>#<name>`로 좁힘 → **같은 파일 다른 함수 동시 편집이 자동 병합(L1)**
- reducer는 예고대로 `keysOf`와 `applyOp`만 확장 (환원 로직 불변). symbol 병합 결과는 합성 blob으로 결정론 유지
- 회귀 테스트: 다른 symbol 자동병합 / 같은 symbol 충돌

> 남은 Phase 2 작업(후속): Tree-sitter 실연동(Python/Go), rename_symbol/move_symbol, raw patch → AST diff 승격, 혼합 granularity(put_file vs set_symbol) 충돌 탐지.

## Phase 3 — 검증 루프 & 에이전트 통합
- evidence를 실제 도구 실행으로 생성(test/typecheck/lint 러너)
- 실패 op repair loop + `RepairContext`(최소 맥락만 에이전트에 전달)
- MCP `resources`로 ContextPack, `prompts`로 skill 템플릿 제공
- WorkLease(soft lease)로 작업 시작 단계 충돌 예방

## Phase 4 — 의미 충돌 & 결정 메모리
- 타입체크/정적분석을 머지 파이프라인에 편입 → 선언 없이도 L3 자동 탐지
- 사람 결정 큐 UI(선택지 + 영향도 + 검증 결과)
- `decision.futurePolicy` 기반 자동 추천(과거 결정 학습)

## Phase 5 — 정책 엔진 심화
- code-owner 매핑, API contract 규칙, security 규칙
- 에이전트 신뢰도 학습 → `actorTrust` 동적 조정
- 정책 버전 관리 + 정책 변경 시 영향 분석

## Phase 6 — Release & provenance
- Release 객체(서명·증거·아티팩트)
- SBOM/container/build 메타데이터 연결, MLOps/온프렘 타깃

## 알려진 한계 (정직하게)

1. 모든 언어의 AST/semantic model 지원은 어렵다 → text CRDT fallback 필수.
2. 자동 병합이 공격적이면 "충돌은 없는데 버그"인 의미 충돌이 는다 → test/typecheck를 머지 파이프라인에 넣어야 함.
3. operation log가 커진다 → 주기적 snapshot/checkpoint + 오래된 low-level op를 semantic op로 compaction.
4. 정책이 강력해진다 → 잘못된 정책은 잘못된 변경을 조용히 들인다. 정책 버전·감사·`require_human` 안전판으로 방어.

## 기술 부채 / MVP 단순화

- content addressing은 canonical JSON(추후 CBOR). 직렬화는 `src/core/canonical.ts` 한 곳에 격리.
- blob은 base64 통짜 저장(추후 청크/delta).
- `view.query.includeStatuses`는 후보 선택보다 표시 의미에 가깝게 단순화됨.
- 동기화 프로토콜(operation gossip)은 설계만, 미구현.
- Lamport clock은 단일 프로세스 가정. 분산 시 actor별 clock + 교환 필요.
