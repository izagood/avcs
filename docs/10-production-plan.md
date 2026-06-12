# 10 — Production 설계 계획

MVP(Phase 1–12)는 **모델이 옳다는 것**을 증명했다: 결정론적 reduce, 충돌-as-데이터, 의미(symbol) 머지, 거버넌스, 멀티머신 수렴. 단, 전부 **단일 프로세스 / 로컬 파일 / 휴리스틱** 깊이다. Production은 다른 축의 문제 — **성능·호스팅·내구 저장·의미 정확도·신뢰 강화·운영성** — 을 풀어야 한다. 본 문서는 그 격차를 6개 워크스트림과 4개 마일스톤으로 구조화한다.

## 구현 현황 (M1–M4 MVP 슬라이스 + 통합 검증)

PR #24–31로 각 마일스톤의 핵심 슬라이스를 구현했다(나머지 대형 인프라는 아래 워크스트림에 후속으로 명시):

- **M1 성능** ✅ reduce 결과 캐시(입력 시그니처, clone-on-hit). + **결정론 property 하니스**가 실제 비결정론 버그(교차-granularity put_file∥set_symbol)를 발견→수정, 5/5 property로 결정론 강제. *후속: dirty-key incremental reduce(checkpoint base).*
- **M2 호스팅** ✅ **네트워크 hub**(HTTP `/have`·`/objects`·`/refs`) + **거버넌스 배포**(hub가 policy/member/protection/head 게시, 클라이언트 pull) + **gated push**(멤버 서명 검증) + **권한가중 결정** + **키 revocation**. *후속: object-storage 백엔드·set reconciliation·mTLS.*
- **M3 의미** ✅ `rename_symbol`·`move_symbol` AST op. *후속: 실제 tree-sitter 백엔드·cross-file 참조·typecheck-in-merge.*
- **M4 운영** ✅ in-process metrics(cache hit/miss·reduce.ms) + MCP/CLI 노출 + MCP 서버 Repo 재사용(캐시·metrics 유지). *후속: OTel/Prometheus forward·sync lag/queue gauge.*

**통합 검증** (`test/integration-multiuser-hub.test.ts`, 매 `npm test` 실행): 권한이 다른 다중 유저가 각자 repo에서 다중 에이전트로 작업하며 **실제 로컬 hub**로 push/pull — C1 분리작업 수렴 · C2 같은 symbol 충돌이 모든 replica에 동일 id · C3 권한(admin>reviewer) 결정 수렴 · C4 gated hub가 외부자 거부 · C5 quarantine→promote · C6 finalize CAS+head 배포. 전체 **89/89** 통과, tsc clean.

대형 인프라(CBOR 전환·packing/compaction·object-storage·native tree-sitter·HSM/threshold 키)는 환경/범위상 후속으로 둔다.

## 0. MVP → Production 격차 요약

| 축 | MVP 현재 | Production 목표 |
|---|---|---|
| 성능 | 매 materialize가 **O(전체 ops)** | incremental O(Δ), 캐시·인덱스 |
| 호스팅 | `pull` = 로컬 디렉터리 복사 | 실제 네트워크 hub(avcshub) 서비스 |
| 저장 | 로컬 sharded JSON 파일 | object storage + 강일관 ref store, packing/GC |
| 직렬화 | canonical JSON | canonical **CBOR** |
| 의미 | brace 스캐너 휴리스틱 | tree-sitter 다언어 + AST op |
| 신뢰 | 서명 모델(키관리 없음) | 키 rotation/revocation, HSM/threshold root, 격리 CI |
| 운영 | 없음 | 관측·백업·SDK·통합·마이그레이션 |

불변식(절대 깨지 않음): **결정론**(같은 objects+policy+materializer ⇒ 같은 treeHash), **append-only**(예외는 governed redaction뿐), **두 plane 분리**(content 분산 / governance 권위), **하위호환·마이그레이션 우선**.

---

## 워크스트림 A — 성능: incremental reduce

**문제.** `repo.materialize`가 매번 전체 op/evidence/decision/blob을 읽고 정규정렬+reduce(+의미 2-pass). 수년 히스토리 = cold-start 무한 증가.

**설계.**
- **checkpoint를 reduce base로.** `reduce(base = checkpoint.tree + accepted frontier, opsSince)`. 정상상태 비용 O(마지막 checkpoint 이후).
- **정확성 난점**: 새 op가 base의 accepted op와 *concurrent*(인과 후손이 아님)면 같은 conflictKey 그룹을 다시 봐야 함. → **dirty-key 부분 재reduce**: 새 op의 `keysOf`로 영향받은 키 집합만 base 위에서 재계산, 무관한 키는 base tree 재사용. base frontier의 인과 후손만인 경우는 순수 append.
- **검증 불변식**: `incrementalReduce ≡ fullReduce` (동치 property test로 강제).
- **캐시**: materialization 캐시 키 = `(opset merkle root, policyOid, materializerVersion)`. MCP 서버(장수명)·반복 CLI에 즉효.
- **인덱스 확장**: entity 인덱스(있음) + intent/session/line 보조 인덱스 persistent → `list()` 전체스캔 제거.
- **sparse**: `ViewQuery.pathScopes` → 후보 op·트리 prefix 가지치기(의미 의존성은 유지).

**마일스톤 A**: incremental(+동치 harness) → 캐시 → sparse.

## 워크스트림 B — 호스팅: 실제 avcshub 서비스

**문제.** `pull`이 로컬 디렉터리 간 복사. 진짜 협업엔 네트워크 hub 필요.

**설계.**
- **전송**: HTTP/gRPC `push`/`pull`. `have`/`want` oid 집합 협상 — 큰 집합은 set reconciliation(IBLT/minhash)로 라운드트립 최소화.
- **인증**: 멤버 서명 게이트(모델 있음) + transport는 mTLS/OIDC. 비멤버 push는 quarantine 네임스페이스(Phase 11)로만.
- **저장 백엔드 분리**:
  - *content plane*(blob/op/evidence): **object storage**(S3/GCS/R2), key = oid. 불변·내용주소라 캐싱·CDN·dedup 자연.
  - *governance plane*(refs/policy/protection/membership/head): **강일관 저장소**(Postgres/etcd/Spanner)로 `finalize` CAS 선형화(merge queue).
- **권위**: canonical policy/protection/membership를 hub가 서명·게시 → 클라이언트 pull → 모두 같은 policy로 reduce(결정론 복구). 권위 = root 키이므로 **멀티 hub 복제/페일오버** 가능(호스트 비종속).
- **causal-complete 게이트**: finalize 전 모든 causalDep 객체 존재 검증(부분 sync silent 오류 차단).

**마일스톤 B**: 단일 hub(파일→object storage) → governance DB + CAS → 멀티 hub.

## 워크스트림 C — 저장소 포맷 & 스케일

- **CBOR 전환**: `core/canonical.ts` 한 곳에 격리돼 있음 → canonical CBOR로 교체(크기·속도). oid 안정성 위해 **format version** 부여 + 변환기.
- **packing**: loose object → 주기적 packfile(읽기/전송 효율).
- **compaction**: checkpoint 뒤의 superseded 저수준 op를 semantic op로 fold(append-only 감사성 유지하며 활성 집합 축소).
- **blob**: 고정크기 청크(MVP) → **FastCDC** content-defined 경계, raw bytes를 JSON 밖 `objects/blob/<oid>.bin`에, 스트리밍 read, 외부 **LFS 포인터** blob kind.
- **GC**: quarantine TTL·미참조 loose object 수집(비-protected만, 권위 head 도달 가능 객체는 보존).

**마일스톤 C**: CBOR+version → blob 청크/스트리밍 → packing/compaction/GC.

## 워크스트림 D — 의미 계층 정확도

- **tree-sitter 실연동**: `EntityIndexer` 인터페이스 교체(이미 존재). 우선 언어 TS/JS → Python → Go → Rust.
- **AST 단위 op**: `rename_symbol`/`move_symbol`/`change_signature`, raw patch → AST diff **승격**(실패 시 `draft_text_patch` 격리), 혼합 granularity(put_file vs set_symbol) 충돌 탐지.
- **line-level blame**: stable span id(Peritext류) 또는 AST node identity → 현재 symbol 단위를 줄 단위로.
- **의미 충돌**: 실제 타입체크/정적분석을 머지 파이프라인에 편입(현재 시그니처 휴리스틱 → 컴파일러 신호).

**마일스톤 D**: tree-sitter 1언어 → AST op → 다언어 → 타입체크 통합.

## 워크스트림 E — 신뢰 & 보안 강화

- **키 관리**: 발급/rotation/**revocation 목록**, 단기 서명 키, root는 **HSM/threshold(M-of-N)**.
- **거버넌스 완성**(docs/08 미구현분): **권한가중 결정 우선순위**(wall-clock 추방은 됐고 가중치 미구현), **Approval 객체**(required approvals), required-up-to-date 강제.
- **격리 CI**: secret-less·network-isolated runner(컨테이너/Firecracker)에서 비신뢰 코드 실행, `fromUntrustedRunner` 강제(모델 있음). poisoned-pipeline 차단.
- **redaction 전파**: `requireRedactionAck` — replica의 바이트 삭제 확인, 다중 서명, 감사 로그.
- **공급망**: 릴리스 SLSA provenance·서명 검증 체인.

**마일스톤 E**: 키 rotation/revocation → Approval+권한가중 → 격리 CI → redaction 전파.

## 워크스트림 F — 운영성 & 생태계

- **관측**: 메트릭(reduce latency, sync lag, conflict-queue depth, finalize throughput), 구조적 로깅, 분산 추적.
- **백업/복구**: object storage 스냅샷 + governance DB 백업/복구 훈련.
- **API/SDK**: MCP tool 버전 안정화, REST/gRPC, 언어 SDK.
- **통합**: IDE(LSP류) blame/결정 큐, CI/CD 플러그인(evidence 자동 첨부), **git import/export** 어댑터(점진 채택).
- **멀티테넌시**: org/repo 스코프 권한.

**마일스톤 F**: 관측/백업 → SDK → IDE/CI 통합 → git interop.

---

## 시퀀스 (4 마일스톤, 횡단 포함)

```
M1 성능 토대   : WS-A incremental(+동치 harness) + WS-C CBOR/version   → 로컬 fleet-ready
M2 호스팅      : WS-B 단일 hub(object storage) + WS-E 키관리/Approval   → 진짜 멀티머신
M3 정확도      : WS-D tree-sitter + AST op                              → 의미 머지 production
M4 강건/운영   : WS-E 보안강화 + WS-F 관측/통합 + WS-B 멀티 hub          → 운영 가능
횡단(상시)     : determinism/property/fuzz harness, 마이그레이션, 문서, 위협모델
```

의존: M1(성능)이 다른 모든 것의 토대(특히 hub는 incremental 없으면 안 굴러감). M2 호스팅이 M4 운영의 전제. M3 정확도는 M1/M2와 병렬 가능.

## 검증 전략 (production 게이트)

- **결정론 harness**: 임의 op DAG 생성 → 모든 입력 순서·분할(sync 시뮬)에서 같은 treeHash(property test). cross-materializerVersion 회귀.
- **incremental 동치**: `incrementalReduce ≡ fullReduce` 무작위 입력 차등 테스트.
- **성능 벤치**: N=10^6 ops cold/steady-state, 회귀 게이트.
- **보안**: 위협 모델 문서 + 키탈취/replay/forge/poisoned-CI 시나리오 테스트.
- **데이터 안전**: 마이그레이션 dry-run, 백업 복구 훈련, redaction 전파 검증.
- **fuzzing**: 객체 파서·sync 협상·reduce.

## 비기능 목표 (SLO 후보)

| 지표 | 목표(초안) |
|---|---|
| materialize p50 (incremental, 10^6 ops) | < 50ms |
| sync 수렴 지연 | < 2s (LAN) |
| finalize 선형화 처리량 | > 50/s per view |
| 내구성 (content) | object storage 11 9s |
| 가용성 (hub) | 99.9%, 멀티 hub 페일오버 |

## 열린 결정 (먼저 합의 필요)

1. **hub 권위 vs 완전 분산** — governance를 CRDT로 분산할지 vs hub 권위(현 설계). 가용성/단순성 trade-off.
2. **git interop 수준** — 어댑터(import/export)로 점진 채택 vs AVCS 네이티브 only.
3. **언어 우선순위** — tree-sitter 대상 순서.
4. **저장 백엔드** — self-host(MinIO+Postgres) 우선 vs 매니지드(S3+RDS).
5. **오픈소스/라이선스 전략**.

→ 본 문서는 **계획 합의용**이며 코드는 미변경. 구현 착수 시 각 워크스트림이 자체 phase/PR 묶음이 된다. 관련: [07 로드맵](07-roadmap.md) · [08 거버넌스](08-governance.md) · [09 사용사례 커버리지](09-usecase-coverage.md).
