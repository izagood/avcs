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

## Phase 3 — 신뢰 & 검증 루프 ✅
- **암호 identity** (`src/core/identity.ts`): ed25519 keypair/sign/verify + Keyring. evidence/decision을 actor가 서명, 위조/변조 시 신뢰 게이트에서 탈락 → H2를 자기신고가 아니라 서명으로 강제 (keyring 미설정 시 Phase-1 휴리스틱 폴백)
- **검증 러너** (`src/validation/runner.ts`): 실제 셸 명령을 materialize된 workspace에서 실행해 Evidence 생성 (test/lint/typecheck)
- **RepairContext** (`src/validation/repair.ts`): 실패 시 전체 repo 재독 대신 최소 수리 패킷(실패 출력 + 관련 decision + 지시)
- **WorkLease** (`src/concurrency/lease.ts`): 작업 시작 단계의 soft 충돌 예방. file scope가 그 안의 symbol scope를 덮음
- MCP: `lease.request` · `validate.run` · `repair.context` 추가
- 후속: MCP `resources`(ContextPack)/`prompts`(skill 템플릿), 개인키 보관소

## Phase 4 — 의미 충돌 & 결정 메모리 ✅
- **계약 분석** (`src/semantic/contract.ts`): exported 함수 시그니처 추출 + 참조 탐지. **선언 안 한** 계약 변경(시그니처 drift)을 호출부와 함께 잡아 L3로 자동 escalate — text 충돌이 없어도. `api_compat=pass` 증거가 있으면 면제
- repo.materialize 2-pass: 의미 충돌 발견 시 breaking op를 빼고 재환원 → 위험한 변경이 트리에 들어가지 않음
- **결정 메모리**: `recallDecisions(key)`(같은 key 과거 판정/근거 회상) + `learnedPolicies()`(`futurePolicy` 누적 = 학습된 제약)
- 후속: 실제 타입체크/정적분석 연동, 결정 큐 UI, 추천 자동 적용

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
