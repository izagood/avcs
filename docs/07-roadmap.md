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

## Phase 5 — 정책 엔진 심화 ✅
- **code-owner** (`src/policy/owners.ts`): scope 패턴 → 소유자 매핑. needs_human 충돌에 `requiredOwners` 주입 → 일반 프롬프트가 아니라 책임자에게 라우팅. file 소유자가 그 아래 symbol까지 커버
- **신뢰도 학습** (`src/policy/reliability.ts`): 검증된 pass(+1)/사람 reject(−1)로 actor별 reliability를 history에서 계산(±3 cap). evaluateOp에 bounded nudge로 주입 — 동률 contest를 더 신뢰받는 agent 쪽으로 (C1 교훈대로 사다리를 압도하지 않음)
- `repo.setOwners` / `setPolicy`(버전 bump → 구분되는 checkpoint) / `reliability()`
- API contract 규칙은 Phase 4 의미 충돌 패스 + owner 라우팅으로 실현
- 후속: security 규칙, 정책 변경 영향 분석

## Phase 6 — Release & provenance ✅
- **Release 객체**: 검증된(충돌 0) checkpoint + 집계 증거 + SBOM + 서명된 아티팩트. 충돌/의미충돌이 있으면 release 거부 — 미검증 트리는 배포 불가
- **SBOM** (`src/release/sbom.ts`): materialize된 트리에서 CycloneDX 형태 BOM 생성(파일+해시, package.json 의존성). 결정론적(같은 트리 → 같은 SBOM)
- **provenance**: ArtifactRef(container_image/digest 등) + ed25519 서명(Phase 3 identity로 검증 가능)
- `repo.cutRelease` / MCP `release.cut` / CLI `avcs release`
- 후속: 실제 container/build 연동, 다중 서명자, in-toto/SLSA 형식

## Phase 7 — 멀티 머신 sync & 거버넌스 (설계됨, 미구현)
멀티 머신 스트레스 테스트에서 드러난 구멍은 전부 "가변·합의 층"에 있었다. 상세 설계: **[08 — 거버넌스](08-governance.md)**.
- **content plane**(operation/evidence): 분산 gossip, append-only, 충돌 없음 — `have`/`want` oid diff로 누락 객체만 교환
- **governance plane**(membership/role · policy · protection · 보호 head): avcshub 권위, 서명·선형화
- GitHub 모델 매핑: roles · CODEOWNERS(=OwnerRule) · branch protection · approve/merge 권한
- 닫는 구멍: op 서명 필수(C-1) · 정책 합의(C-2) · 권한 우선 결정(H-4, wall-clock 추방) · 키 연합(H-7) · causal-complete 게이트(C-3)
- 로컬 동시성: 원자적 객체쓰기(temp+rename+fsync) · lease 원자획득(H-5, H-6) ✅ — `src/store/lock.ts`(mkdir 기반 cross-process 락 + stale 회수), `ObjectStore.#writeAtomic`, `requestLease`를 `withLock`로 감쌈. 회귀 테스트로 레이스 입증(락 없으면 8/8 grant → 락 적용 1/8)

## Phase 8–12 — 사용 사례 커버리지에서 도출 (설계됨)
GitHub 실사용 36종 병렬 검토 결과는 **[09 — 사용 사례 커버리지](09-usecase-coverage.md)**. 도출된 우선 phase:
- **Phase 8 — Lineage & 다중 라인** (keystone) ✅ *(라인 분기·상속·backport 구현)*: 라인별 op 선택으로 구현 — `Operation.line` + `Line`(fork checkpoint) + `materialize`가 라인의 op 부분집합만 reduce(자기 라인 ops ∪ fork checkpoint 인과폐포). reducer는 불변. 같은 symbol에 v1∥v2가 다른 내용을 유지해도 충돌 0. `repo.createLine`/`portOp`(backport=cherry-pick=graft 단일 primitive, `derivedFrom` provenance)/`lineFrontier`/`listLines`, MCP `line.create`/`line.list`/`operation.backport`, CLI `lines`. *후속: `revert` op, line-scoped Protection/policy, EOL freeze, semver, N-라인 fan-out*
- **Phase 9 — Scale**: incremental reduce(checkpoint를 base로, O(전체 ops) 제거) + entity index + chunked/LFS blob + path-scoped/sparse materialize
- **Phase 10 — Observability**: blame(symbol)·history·log-p·bisect·diff — 대부분 Phase 9의 인덱스/`materializeAt` 위에서 떨어짐. (audit·사후 메타데이터는 이미 git보다 강함)
- **Phase 11 — 외부 기여**: `proposer` 아래 quarantine 티어(죽은 `quarantined` 배선) + secret-less isolated CI + admission control(rate-limit/TTL·GC)
- **Phase 12 — Redaction/보안**: admin 서명 tombstone로 유출 비밀 byte-eviction(해시보존 stub) + break-glass override + forward-only rollback finalize

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
