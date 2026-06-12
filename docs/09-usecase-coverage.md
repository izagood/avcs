# 09 — Git/GitHub 사용 사례 커버리지 & 설계 진화

GitHub의 실사용 패턴 36종을 7개 클러스터로 나눠 **병렬로** AVCS 설계와 대조했다. 목표: 각 워크플로우가 AVCS에서 *문제없이* 되는지, 안 되면 어떤 1급 개념을 추가해야 하는지.

## 커버리지 매트릭스

✅ 동작 · 🟡 부분/메커니즘 미구현 · 🔴 구멍

| 클러스터 | 사용 사례 | 판정 |
|---|---|---|
| **History rewrite** | rebase(=re-reduce on new base) | ✅ |
| | squash(=checkpoint as unit) | ✅ |
| | amend/fixup(=superseding op) | ✅ |
| | require linear history(=CAS finalize) | ✅ |
| | force-push(파괴적 의미) | 🔴 의도적 금지 + break-glass 부재 |
| | 비밀 제거(retroactive expunge) | 🔴 content-addressed+gossip라 불가 |
| **Change portability** | cherry-pick | 🟡 includeOps/replay 없음 |
| | backport(구버전 라인) | 🔴 line 개념 부재 |
| | revert | 🟡 inverse op 부재 |
| | rollback release | 🟡 forward-only revert 필요 |
| | N개 라인에 동일 fix | 🔴 fan-out/graft 부재 |
| **Multi-line maintenance** | 장기 분기 라인(v1.x∥v2.x) | 🔴 **keystone** |
| | 긴급 hotfix(체크 우회) | 🟡 break-glass override 부재 |
| | semver 다중 지원 버전 | 🟡 version 객체 부재 |
| | EOL/freeze 라인 | 🔴 line+frozen 부재 |
| | 동시 다중 라인 landing | 🔴 graft 부재 |
| **Untrusted contribution** | 외부 fork PR | 🔴 sub-proposer 티어 부재 |
| | 비신뢰 코드 CI 격리 | 🔴 isolated runner 부재 |
| | drive-by 1회 기여 | 🔴 (위와 동일) |
| | 외부 변경 수용+저자귀속 | 🟡 promotion 시 저자 보존 규칙 필요 |
| | 위조/권한상승 방지 | ✅ 서명+역할 모델의 강점 |
| | 스팸/남용 | 🔴 admission control 부재 |
| **Investigation** | bisect | 🟡 materializeAt 부재(결정론은 이미 있음) |
| | blame(symbol) | 🔴 entity index 부재 (file blame은 git보다 약함) |
| | log -p(엔티티 히스토리) | 🔴 history 쿼리 부재 |
| | audit(누가/왜) | ✅ **git보다 강함** |
| | 두 지점 diff | 🔴 diff 원시연산 부재 |
| | 사후 메타데이터(notes) | ✅ **git보다 강함**(불변·서명) |
| **Scale & content** | monorepo+팀 owner | 🟡 전역 policy/전체 materialize |
| | 대용량 바이너리/LFS | 🔴 통짜 base64(OOM) |
| | submodule/cross-repo | 🔴 다중 repo 개념 전무 |
| | sparse checkout | 🔴 path scope 부재 |
| | 장기 히스토리 성능 | 🔴 O(전체 ops) reduce |
| | 수백 동시 작업 | 🟡 쓰기 정확성 ✅ / 읽기 throughput 🔴 |
| **In-flight collab** | draft/WIP | ✅ |
| | stash | 🟡 private(미-gossip) 부재 |
| | co-authoring | 🔴 actor 단일 필드 |
| | stacked PR | 🟡 causalDeps로 가능하나 미명시 |
| | long-running PR 최신화 | ✅ **구조적으로 공짜** |
| | merge queue/동시 머지 | ✅ CAS finalize로 설계됨 |

## AVCS가 Git보다 *강한* 지점 (먼저 인정)

- **audit/provenance** — current = `reduce(ops, evidence, decisions, policy)`. 모든 accepted op이 actor(서명)·intent(목적·제약)·session·evidence로 환원되고, **자동 머지조차** `autoDecisions`로 근거가 남는다. "이 트리가 왜 신뢰되나"가 끝까지 재구성됨.
- **사후 메타데이터** — append-only라 주석이 native: Evidence/Decision/note가 oid로 기존 객체에 불변·서명 부착. git-notes(가변 side-ref)보다 견고.
- **long-running PR 최신화 & merge queue** — 브랜치가 없으니 rebase가 곧 re-reduce. CAS finalize가 곧 merge queue (docs/08 §6/§9).
- **bisect/symbol-blame은 *구조적으로* 더 강함** — 결정론적 reduce 덕에 checkout/rebuild 없이 op-set의 순수 함수. (단 쿼리 메커니즘 미구현)

## 6개 keystone 구멍과 1급 해법

### G1. Lineage / 장기 분기 라인 (🔴 최우선)
**문제:** view는 "하나의 수렴 그래프에 대한 쿼리"라, 같은 `conflictKey`에 v1.x와 v2.x가 *의도적으로 다른 내용*을 수개월 유지하는 걸 **영구 미해결 동시-쓰기 충돌**로 본다. `baseViewOid`는 타입에 있으나 `materialize`가 무시(항상 전역 재생). backport/cherry-pick/EOL/다중라인이 전부 여기 종속.
**해법:** **line(lineage) 1급화** — (a) op에 `line` 차원(또는 descended-from `baseCheckpoint`로 유도), (b) `conflictKey`를 line-scoped(`line:v1::symbol:...`)로 → 라인 간 편집이 서로 contend하지 않음, (c) view를 **checkpoint frontier에 root** 하여 그 라인의 인과 op만 reduce.

### G2. Incremental reduce (checkpoint를 base로) (🔴 scale 핵심)
**문제:** 매 `materialize`가 O(전체 ops) — 모든 op/evidence/decision/blob를 디스크에서 읽고 정규정렬, 의미충돌 시 2-pass. 수년 히스토리 = cold-start 비용·디스크 무한 증가, CLI/MCP 호출마다 재지불.
**해법:** checkpoint를 **진짜 reduce base**로: `reduce(checkpoint.tree + headOps, opsSince)` → 정상상태 비용 O(마지막 체크포인트 이후 ops). + 로드맵의 compaction(superseded 저수준 op를 semantic op로 접기) + view별 op 인덱스로 `list()` 전체스캔 제거.

### G3. Entity index + materializeAt (🔴 observability 핵심)
**문제:** store는 `get`/전체스캔 `list`만. entity/path/symbol 인덱스 없음, prefix/at-frontier reduce 없음 → blame·history·log-p·bisect·diff가 전부 불가(데이터는 다 있는데 쿼리가 없음).
**해법:** (a) `keysOf(op)→ops` 쓰기-시 인덱스, (b) `materializeAt(headOps)`(주어진 frontier의 인과폐포만 reduce). 이 둘 위에 blame/history/bisect가 떨어진다. `blame(symbolId)`=그 key의 accepted head op(actor/intent/purpose/evidence) → "AVCS가 git보다 강함"의 헤드라인 기능.

### G4. Diff 원시연산 (🔴 리뷰 UX 토대)
**문제:** 어떤 수준의 diff도 없음(tree/op-set/policy). "체크포인트 X→Y에서 뭐가 바뀌었나", "view A엔 있고 B엔 없는 op", "policy만 바꿨을 때의 차이"(AVCS 고유 축) 불가.
**해법:** `diffTrees(resA,resB)`(path 추가/삭제/수정), `diffOps(cpA,cpB)`(accepted op 대칭차+상태 flip), policy-diff 모드(같은 ops를 두 policy로 reduce). 기존 `tree: Map<path,blobOid>`라 cheap.

### G5. 외부 비신뢰 기여 — quarantine 티어 (🔴)
**문제:** hub가 서명·멤버 op만 수락하는데 외부 기여자는 *정의상 비멤버* → 아예 제안 불가. `quarantined` 상태값은 존재하나 **어디서도 할당 안 되는 죽은 코드**. 비신뢰 CI 격리·admission control 없음.
**해법:** `proposer` 아래 **outsider 티어**: 자가서명 키로 quarantine 네임스페이스에만 push, op은 `quarantined`(이 enum을 실제 배선)로 main에서 제외, reviewer가 promote할 때까지 점수/게이트 미반영. 비신뢰 op의 evidence는 **secret-less·network-isolated runner**에서만 생성(+`fromUntrustedRunner` 플래그). hub push 경계에 rate-limit/PoW + 미-promote quarantine op TTL·GC(append-only가 양보하는 유일 지점). promote 시 **원저자 서명 op oid 보존**(actor 재서명 금지).

### G6. Redaction / Tombstone — 비밀 제거 (🔴 보안)
**문제:** 유출된 비밀이 불변·content-addressed blob에 들어가 모든 replica로 gossip됨. `excludeOps`는 projection에서 숨길 뿐 바이트는 영구 fetch 가능 = 실제 보안 실패.
**해법:** admin 서명·hub 권위의 `Redaction`(tombstone): (1) `blobOid`를 purged 표시, (2) 모든 replica가 바이트 삭제 후 **해시보존 stub**(`{purgedOid, sha256, length, reason, by}`)로 치환 → oid/treeHash/causalDeps 참조는 유효(Merkle 무결성 유지)하되 평문은 소거. sync에 `requireRedactionAck`로 stale 바이트 잔존 방지. = GitHub secret-purge/BFG의 AVCS판.

## 작은 구멍 (1급 op/필드 추가로 해결)

- **revert op** (`body.kind:"revert"`, target=op oid) — `excludeOps`/`Decision` 오버로드 대신 히스토리에 남는 서명된 inverse. (Change portability)
- **co-authors** — `Operation.coAuthors?: Actor[]` (서명자는 단일 유지 = C-1 게이트 보존, co-author는 비권위 메타 = git `Co-authored-by`). "논리적 변경 = Intent"임을 명문화. (In-flight)
- **stash privacy** — `Session.visibility:"private"|"shared"`로 promote 전 gossle 제외. (In-flight)
- **stacked PR 명시화** — proposal-level `dependsOn`(causalDep 폐포에서 유도) + finalize 시 부모 proposal head를 `parentHead`로 강제. (In-flight)
- **break-glass override** — 서명·만료되는 `Override`(누가/어떤 체크 면제/사유/TTL)를 finalize 게이트가 소비, checkpoint에 provenance로 기록. (긴급 hotfix)
- **Release.version + supportStatus** — semver + `supported|maintenance|eol`, `release:<line>:<version>` 인덱스. (semver)
- **forward-only Rollback finalize** — 이전 상태를 *새* checkpoint로 re-materialize해 head를 *앞으로* 전진(CAS·append-only 유지). (rollback/force-push 대체)
- **path-scoped view + chunked/LFS blob + cross-repo `dependency` 객체** — sparse checkout·대용량·submodule. (Scale)

## 로드맵 반영 (우선순위)

1. **Phase 8 — Lineage & 다중 라인** (G1) + change portability(cherry-pick/backport/graft, revert op). *keystone, 나머지 다수 잠금해제.*
2. **Phase 9 — Scale**: incremental reduce(G2) + entity index(G3) + chunked/LFS blob + path-scoped/sparse materialize.
3. **Phase 10 — Observability**: blame/history/log-p/bisect/diff(G3+G4) — 대부분 G2/G3 위에서 떨어짐.
4. **Phase 11 — 외부 기여**: quarantine 티어 + isolated CI + admission control (G5).
5. **Phase 12 — Redaction/보안**: tombstone byte-eviction (G6), break-glass override, rollback finalize.
6. 소소: co-authors, stash privacy, stacked-PR 명시, semver — 해당 phase에 끼워넣음.

→ 상세 거버넌스: [08](08-governance.md). 본 문서는 **설계 합의용**이며 코드는 아직 미변경.
