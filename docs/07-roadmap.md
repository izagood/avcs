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

## Phase 2 — 의미(symbol) 인지 머지 ⛔ **폐기됨 — [15 — 언어 중립 코어](15-language-neutral-core.md)가 대체**

**원래 만든 것**(당시 ✅였고, 아래 코드는 지금 존재하지 않는다):
- 파일을 symbol/gap span으로 파싱하는 `EntityIndexer` (`src/semantic/symbols.ts`) — TS/JS용 brace 스캐너, Tree-sitter 백엔드를 끼울 수 있는 인터페이스
- `set_symbol` 연산 + `conflictKey`를 `symbol:<file>#<name>`로 좁힘 → 같은 파일 다른 함수 동시 편집이 자동 병합(L1)
- reducer는 `keysOf`와 `applyOp`만 확장(환원 로직 불변), symbol 병합 결과는 합성 blob으로 결정론 유지
- 회귀 테스트: 다른 symbol 자동병합 / 같은 symbol 충돌

**왜 폐기됐나**: 유일한 `EntityIndexer`가 TS/JS 전용인데 `reducer.applyOp`이 파일 종류와 무관하게
항상 그것을 호출했다 — 언어 디스패치조차 없는, 사실상 TS 전용 코어. 다른 언어는 심볼 0개 → 통짜
폴백. 코드 구조 인식은 VCS가 가질 이유가 없는 결합이었다(docs/15 §0).

**무엇이 삭제됐고 무엇이 대체했나**:
- `src/semantic/`(`symbols.ts`·`contract.ts`) 디렉터리 통째로 삭제. 현재 코드베이스에
  `set_symbol`/`rename_symbol`/`move_symbol` 연산도, `symbol:<file>#<name>` 충돌 키도, `EntityIndexer`도 없다.
- 대체물: `edit_file{path, baseBlobOid, blobOid}` + 언어 무지 라인 3-way 머지 `src/merge/merge3.ts`.
  **모든 파일 연산이 `file:<path>` 하나로 키잉된다.**
- 같은 파일 동시 편집은 이제 심볼 경계가 아니라 **라인 헝크** 단위로 갈린다: 서로 떨어진 영역이면
  자동 병합(L1), 겹치면 Conflict(L2). 머지 품질은 정직하게 git과 동급이고, 우위는 원장·정책·evidence·
  lease 제어 평면에서 온다(docs/15 §7).
- 잔존물 하나: `symbol:<file>#<name>` **scope 문자열**은 lease/owner 패턴에서 여전히 해석된다
  (`src/concurrency/lease.ts`·`src/policy/owners.ts`의 "file scope가 그 안의 symbol scope를 덮는다"
  규칙 — 아래 Phase 3·5 항목은 그래서 여전히 사실이다). 연산·충돌 키에는 쓰이지 않는다.

> 당시 적어둔 "남은 Phase 2 작업(후속)"(Tree-sitter 실연동, rename_symbol/move_symbol,
> raw patch → AST diff 승격, 혼합 granularity 충돌 탐지)은 **전부 취소**됐다. 혼합 granularity
> 문제는 키가 하나로 통일되며 소멸했다(docs/15 §10.3).

## Phase 3 — 신뢰 & 검증 루프 ✅
- **암호 identity** (`src/core/identity.ts`): ed25519 keypair/sign/verify + Keyring. evidence/decision을 actor가 서명, 위조/변조 시 신뢰 게이트에서 탈락 → H2를 자기신고가 아니라 서명으로 강제 (keyring 미설정 시 Phase-1 휴리스틱 폴백)
- **검증 러너** (`src/validation/runner.ts`): 실제 셸 명령을 materialize된 workspace에서 실행해 Evidence 생성 (test/lint/typecheck)
- **RepairContext** (`src/validation/repair.ts`): 실패 시 전체 repo 재독 대신 최소 수리 패킷(실패 출력 + 관련 decision + 지시)
- **WorkLease** (`src/concurrency/lease.ts`): 작업 시작 단계의 soft 충돌 예방. file scope가 그 안의 symbol scope를 덮음
- MCP: `lease.request` · `validate.run` · `repair.context` 추가
- 후속: MCP `resources`(ContextPack)/`prompts`(skill 템플릿), 개인키 보관소

## Phase 4 — 의미 충돌 & 결정 메모리 ✅
- ~~**계약 분석** (`src/semantic/contract.ts`): exported 함수 시그니처 추출 + 참조 탐지. **선언 안 한** 계약 변경(시그니처 drift)을 호출부와 함께 잡아 L3로 자동 escalate — text 충돌이 없어도. `api_compat=pass` 증거가 있으면 면제~~ → **docs/15에서 삭제됨**(언어별 시그니처 정규식 = 언어 결합). **미선언 계약 변경 탐지는 현재 코어에 없다.** 남은 방어선은 선언 effects(`breaksPublicApi`)와 evidence 게이트(`api_compat` EvidenceKind는 유지)뿐이며, 이 갭은 docs/15 §10.4 **H2**로 기록돼 있다
- repo.materialize 2-pass는 **유지되나 내용이 교체됐다**: 의미(계약) 충돌 패스 → `detectFileConflicts`(동시 `edit_file` N-way merge3) 패스. 위험한 변경을 빼고 재환원하는 구조 자체는 그대로
- **결정 메모리**: `recallDecisions(key)`(같은 key 과거 판정/근거 회상) + `learnedPolicies()`(`futurePolicy` 누적 = 학습된 제약)
- 후속: 실제 타입체크/정적분석 연동, 결정 큐 UI, 추천 자동 적용

## Phase 5 — 정책 엔진 심화 ✅
- **code-owner** (`src/policy/owners.ts`): scope 패턴 → 소유자 매핑. needs_human 충돌에 `requiredOwners` 주입 → 일반 프롬프트가 아니라 책임자에게 라우팅. file 소유자가 그 아래 symbol까지 커버
- **신뢰도 학습** (`src/policy/reliability.ts`): 검증된 pass(+1)/사람 reject(−1)로 actor별 reliability를 history에서 계산(±3 cap). evaluateOp에 bounded nudge로 주입 — 동률 contest를 더 신뢰받는 agent 쪽으로 (C1 교훈대로 사다리를 압도하지 않음)
- `repo.setOwners` / `setPolicy`(버전 bump → 구분되는 checkpoint) / `reliability()`
- ~~API contract 규칙은 Phase 4 의미 충돌 패스 + owner 라우팅으로 실현~~ → 의미 충돌 패스가 docs/15에서 삭제되어, 남은 것은 **owner 라우팅 + 선언 effects/evidence 게이트**다
- 후속: security 규칙, 정책 변경 영향 분석

## Phase 6 — Release & provenance ✅
- **Release 객체**: 검증된(충돌 0) checkpoint + 집계 증거 + SBOM + 서명된 아티팩트. 충돌/의미충돌이 있으면 release 거부 — 미검증 트리는 배포 불가
- **SBOM** (`src/release/sbom.ts`): materialize된 트리에서 CycloneDX 형태 BOM 생성(파일+해시, package.json 의존성). 결정론적(같은 트리 → 같은 SBOM)
- **provenance**: ArtifactRef(container_image/digest 등) + ed25519 서명(Phase 3 identity로 검증 가능)
- `repo.cutRelease` / MCP `release.cut` / CLI `avcs release`
- 후속: 실제 container/build 연동, 다중 서명자, in-toto/SLSA 형식

## Phase 7 — 멀티 머신 sync & 거버넌스 ✅ *(MVP 구현)*
멀티 머신 스트레스 테스트에서 드러난 구멍은 전부 "가변·합의 층"에 있었다. 상세 설계: **[08 — 거버넌스](08-governance.md)**. 구현: Membership/역할(root 서명, 키 연합)·서명된 op·`repo.pull`(객체 gossip, 충돌 단계 없음, 인덱스 유지)·Protection·`finalize` CAS(non-fast-forward 거부 = causal-currency, 권한·체크 게이트, merge queue). 회귀 테스트: 두 replica gossip 수렴(같은 treeHash)·같은 파일 충돌이 양쪽 동일(docs/15 이후 키는 `file:<path>`)·finalize CAS가 stale 거부. *후속: 권한가중 결정 우선순위, Approval 객체, MCP 거버넌스 도구.*
- **content plane**(operation/evidence): 분산 gossip, append-only, 충돌 없음 — `have`/`want` oid diff로 누락 객체만 교환
- **governance plane**(membership/role · policy · protection · 보호 head): avcshub 권위, 서명·선형화
- GitHub 모델 매핑: roles · CODEOWNERS(=OwnerRule) · branch protection · approve/merge 권한
- 닫는 구멍: op 서명 필수(C-1) · 정책 합의(C-2) · 권한 우선 결정(H-4, wall-clock 추방) · 키 연합(H-7) · causal-complete 게이트(C-3)
- 로컬 동시성: 원자적 객체쓰기(temp+rename+fsync) · lease 원자획득(H-5, H-6) ✅ — `src/store/lock.ts`(mkdir 기반 cross-process 락 + stale 회수), `ObjectStore.#writeAtomic`, `requestLease`를 `withLock`로 감쌈. 회귀 테스트로 레이스 입증(락 없으면 8/8 grant → 락 적용 1/8)

## Phase 8–12 — 사용 사례 커버리지에서 도출 (설계됨)
GitHub 실사용 36종 병렬 검토 결과는 **[09 — 사용 사례 커버리지](09-usecase-coverage.md)**. 도출된 우선 phase:
- **Phase 8 — Lineage & 다중 라인** (keystone) ✅ *(라인 분기·상속·backport 구현)*: 라인별 op 선택으로 구현 — `Operation.line` + `Line`(fork checkpoint) + `materialize`가 라인의 op 부분집합만 reduce(자기 라인 ops ∪ fork checkpoint 인과폐포). reducer는 불변. 같은 파일에 v1∥v2가 다른 내용을 유지해도 충돌 0. `repo.createLine`/`portOp`(backport=cherry-pick=graft 단일 primitive, `derivedFrom` provenance)/`lineFrontier`/`listLines`, MCP `line.create`/`line.list`/`operation.backport`, CLI `lines`. *후속: `revert` op, line-scoped Protection/policy, EOL freeze, semver, N-라인 fan-out*
- **Phase 9 — Scale** ✅ *(MVP)*: entity index(`historyOf`, O(ops-on-entity)) + `materializeAt`(frontier 인과폐포) + chunked large blob(>256KB→64KB 청크, content-address dedup). *후속: incremental reduce(checkpoint base), path-scoped/sparse materialize, FastCDC/외부 LFS.*
- **Phase 10 — Observability** ✅: `blame`(누가/왜)·`historyOf`·`logP`(before/after)·`bisect`(결정론적, checkout 없음)·`diffTrees`/`diff`. MCP blame/history/diff, CLI blame/diff. audit·사후 메타데이터는 이미 git보다 강함
- **Phase 11 — 외부 기여** ✅: 거버넌스 repo에서 비멤버 op은 quarantine(트리 제외, 죽은 `quarantined` 배선)→reviewer `promote`. `proposeOutsider`(admission cap)·`Evidence.fromUntrustedRunner`(비신뢰 CI 신뢰 안 함). *후속: 실제 isolated runner.*
- **Phase 12 — Redaction/보안** ✅: admin 서명 `redact`로 유출 blob byte-eviction(oid 보존→treeHash 유효, BFG analog) + break-glass `grantOverride`(만료 waiver) + forward-only `rollbackTo`(CAS). *공유 전 로컬 사례는 `avcs undo [--purge]`가 맡는다 — push된 op은 거부하고 `redact`로 넘긴다([23](23-local-undo.md)).*
- **소소** ✅: `revert` op(forward inverse+provenance) · `coAuthors` · `private` op(stash, gossip 제외) · Release semver+supportStatus · line-scoped Protection(per-view)

## Phase 13–16 — 수렴 & MCP 일급화 ✅ *(완료)*

남은 git식 고통(stale finalize → 수동 pull → 재작업 퍼널, 수동 폴링 동기화, 뒤늦은 충돌 발견, opt-in incremental)과 MCP 공백(sync 도구 부재, ContextPack 미구현, 알림 없음)을 제거한다. 상세 설계: **[17 — 수렴](17-sync-convergence.md)** · **[18 — MCP 일급 커넥션](18-mcp-first-class.md)**.

- **Phase 13 — 수렴 기반** ✅: 영속 remote(`.avcs/remotes.json` + `repo.sync`/`avcs remote·sync`, clone이 origin 기록) ✅ · Lamport observe-on-import + multi-process reseed(HLC 아님, 순서 품질만) ✅ · **incremental reduce 기본 ON**(`AVCS_INCREMENTAL=0` opt-out, base 헤더 스탬프 무효화 + 256-op 자동 compaction, VERIFY는 CI 잡 — [11](11-incremental-reduce.md) §13.3) ✅ · **evidence treeHash 바인딩 실체화**(`Checkpoint.evidenceBinding` + `Protection.requireBoundEvidence`) ✅ — 13.4는 Phase 14 게이트의 전제조건
- **Phase 14 — 통합 큐** ✅ (헤드라인): stale 제출을 거부하는 대신 **허브/finalize 경로가 합집합 재환원을 대신** 수행. 신규 `Integration` 객체(멱등 티켓 — advanced만 영구 재생, 비종결 verdict는 재평가 — append-only 감사, push 거부) · `repo.submitIntegration`(frontier-합집합을 `materializeAt` 경로로 reduce, `finalize:<view>` 락이 직렬화기) · hub `POST /integrate`(200/409/428/202/422) + `GET /integrations/:ticketId`(기존 `/finalize` 불변, `/version`이 `integrate:true` 광고) · `hubClient.integrateWithHub`(delta push → 판정 → `missingLocally`만 pull, 재시도 루프 0) · `repo.integrateHub`(capability 탐지, 구 허브는 legacy 폴백) · CLI `avcs submit` · MCP `avcs.integration.submit`/`status`(24→26종) · evidence 모드(기본 **carry-disjoint**: 서로소 델타면 승계+양쪽 기록, 겹치면 `needs_evidence` 2단계 — 검증 1회, 재작업 0회; `requireBoundEvidence`는 fresh 강제; 예약 TTL 만료는 `expired` 감사 후 큐 전진). **계약: 제출 결과는 advanced | conflict 패킷(결정 메모리 동봉) | needs_evidence | queued 넷뿐 — "pull 하고 다시"는 없다**
- **Phase 15 — 라이브 수렴** ✅: hub `GET /events` 롱폴(objlog 커서를 `/sync`와 공유, 모든 응답에 거버넌스 refs 동봉 — ref만 움직이는 finalize도 파킹된 waiter에 보임, waiter 상한 253→503, 타임아웃 하트비트, `/version`이 `events:true` 광고 — 프로토콜 v4 가산) · `avcs sync --watch` 데몬(`runSyncWatch`: 롱폴→incremental sync→head 이벤트→도착 시점 contention 경보, 하트비트 갱신되는 `syncd` 락으로 repo당 단일 인스턴스, 구 허브는 주기 폴링 폴백) + materialize freshness 창(autoSync remote가 stale이면 **백그라운드** sync 발화 — 읽기 경로 비차단, blocking은 `repo.syncIfStale()`) · **충돌 조기 경보** `repo.contention`(entity index 기반 O(ops-on-key), 인과폐포 밖 + 미거부 + 미승계 타 actor op + 겹치는 active lease holder; `proposeOperation({warnContention})` 로그+메트릭 가산, MCP `avcs.contention.check` + propose `contentionWarnings`(26→27종), CLI `avcs status` 표시)
- **Phase 16 — MCP 일급화 (M1–M5)** ✅: **M1 ✅** 토큰 기반 — 컴팩트 직렬화 기본 + 범용 `verbose`, 실패는 `{error,hint,nextActions}` 봉투(`RECOVERY` 표, 참조 도구는 테스트가 실재성 강제), 유계 읽기(`history` limit/cursor · `intent.list` limit · `materialize` filesLimit/pathsOnlyUnder + filesTotal/filesTruncated · `object.show` lines/maxBytes + bytes/truncated · `diff format:patch` = merge3 LCS 코어 위의 `unifiedDiff`), 신규 `avcs.guide`(정본 루프·규칙·도구 색인·에러맵을 **live 테이블에서 생성** → 드리프트 불가) + description 25단어 상한 — **27→28개 도구인데 description 873→489단어(-44%)** · **M2 ✅** sync 일급화 — `avcs.sync.pull`(dryRun + local/hub head 비교)·`avcs.sync.push`·**`avcs.sync.land`**(push→merge-check→checkpoint→통합을 한 번에; 충돌은 **재시도하지 않고** 첫 시도에 결정 패킷 반환, `queued`는 백오프 흡수, `needs_evidence`는 validate→attach→land로 안내)·`avcs.workspace.project`, 루프는 `src/mcp/land.ts`로 분리해 CLI `avcs land`가 동일 함수 사용(28→32종) · **M3 ✅** ContextPack — **`avcs.context.build`**(intentOid/entityKeys/paths 스코프 필수, 스코프 없으면 거부; 내용 대신 provenance+blobOid만 담고 텍스트는 `object.show` 슬라이스에 위임; **결정적 절단** — 고정 섹션 우선순위 + recency→oid 정렬 + 컴팩트 바이트 greedy fill ⇒ 같은 입력 = 바이트 동일 출력, 탈락 섹션은 `budget.truncated`) + `avcs.decision.recall`(32→34종) · **M4 ✅** resources/prompts/알림 — resources 4종(`avcs://view/{v}/head·conflicts·context`, `avcs://guide`; subscribe:true, 도구 핸들러와 동일 경로라 불일치 불가) + prompts 4종(`onboard`·`propose-change`·`resolve-repair`·`review-change`, 사실을 인라인해 왕복 제거) + 로컬 워처(**폴링이 정확성 경로** — fs.watch는 플랫폼별로 이벤트를 흘리고 head 전진을 놓치는 게 막으려는 실패다; `head-advanced`·`foreign-op-hot-key`·`conflict-opened`, `AVCS_MCP_WATCH_MS=0`이면 off) + `governance.status`/`approval.record` + `repo.approvalsFor()` 공개(34→36종) · **M5 ✅** 프로필 + 문서 — `avcs mcp --profile core` / `AVCS_MCP_PROFILE=core`가 정본 루프 13종만 광고(기본은 전체 = 호환, 알 수 없는 이름은 전체로 degrade, **메뉴만 줄고 능력은 그대로**). **실측: 27종/873단어 → full 36종/620단어 → core 13종/230단어** — 도구를 9종 늘리고도 full이 시작점보다 29% 가볍다. [06](06-mcp-interface.md)을 권위 레퍼런스로 재작성(정본 루프·프로필·응답 관례·resources/prompts/알림)

의존: 13.4→14, 13.3→14.2(허브가 제출마다 reduce 1회), 15.1→15.2, 16-M2는 14와 요청/응답 shape만 협상(폴백 경로는 독립).

## 알려진 한계 (정직하게)

1. ~~모든 언어의 AST/semantic model 지원은 어렵다 → text CRDT fallback 필수.~~ → docs/15가 이 한계를 우회하는 대신 **전제를 뒤집었다**: 코어는 AST를 아예 갖지 않고 언어 무지 라인 3-way 머지(`merge3`)만 쓴다. CRDT도 도입하지 않았다(결정론적 환원으로 충분).
2. 자동 병합이 공격적이면 "충돌은 없는데 버그"인 의미 충돌이 는다 → test/typecheck를 머지 파이프라인에 넣어야 함.
3. operation log가 커진다 → 주기적 snapshot/checkpoint + 오래된 low-level op를 semantic op로 compaction.
4. 정책이 강력해진다 → 잘못된 정책은 잘못된 변경을 조용히 들인다. 정책 버전·감사·`require_human` 안전판으로 방어.

## 기술 부채 / MVP 단순화

- content addressing은 canonical JSON(추후 CBOR). 직렬화는 `src/core/canonical.ts` 한 곳에 격리.
- blob은 base64 저장. ~~통짜~~ → Phase 9에서 청크 도입(>256KB → 64KB 청크, content-address dedup); delta 저장은 여전히 미도입.
- `view.query.includeStatuses`는 후보 선택보다 표시 의미에 가깝게 단순화됨.
- ~~동기화는 수동 폴링(pull 실행 시에만 수렴, 이벤트/데몬 없음)~~ → Phase 15에서 해소: `GET /events` 롱폴 + `avcs sync --watch` 데몬 + materialize freshness 창(stale-while-revalidate)이 라이브 수렴을 제공([17](17-sync-convergence.md)).
- ~~Lamport clock의 단일 프로세스 가정~~ → Phase 13.2에서 해소: pull/pullHub가 수입 op의 max lamport를 observe하고, propose 직전 op-log tail로 reseed(같은 `.avcs`의 CLI+MCP 겹침 발급 제거). 결정론은 애초에 lamport 품질에 비의존(oid tie-break) — 개선된 것은 순서 품질.
- ~~evidence `treeHash` 바인딩은 장식~~ → Phase 13.4에서 실체화: checkpoint 집계가 bound(일치) 우선/불일치 제외/legacy 기록, `Protection.requireBoundEvidence`가 finalize에서 legacy를 거부.
