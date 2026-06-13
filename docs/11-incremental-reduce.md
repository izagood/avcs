# 11 — Incremental reduce & 저장 포맷 경화 (설계)

> 상태: **A0 착수.** 본 문서는 결정론-위험 production 항목(incremental reduce, CBOR/packing/compaction)을
> *감독 하에 안전하게* 진행하기 위한 단계별 계획이다. 핵심 원칙은 **"하니스가 먼저, 코드가 나중"** —
> 각 항목은 무작위 차등 테스트(differential property test)로 `incremental ≡ full` 동치를 **게이트**한
> 뒤에만 production 경로에 배선되며, 모든 전제 미충족은 항상 full 경로로 **fallback**한다(언제나 정답).

## 0. 왜 위험한가 — 전역 결합

`reduce`는 순수·결정론 함수다(같은 objects+policy+materializer ⇒ 같은 treeHash). 이 불변식이 프로젝트의
절대 보증이므로, "전체 재계산"을 "Δ만 재계산"으로 바꾸는 작업은 한 엣지케이스라도 놓치면 결정론을 *조용히*
깬다. 위험의 원천은 세 전역 결합이다:

1. **reliability** — 액터별 신뢰 nudge. (repo가 전체 op로 산출해 reducer에 입력.)
2. **ancestry** — op들의 전이적 인과 조상.
3. **2-pass cross/semantic** — granularity·파일을 가로지르는 accepted 집합 의존(repo 계층).

### 분석으로 좁혀진 두 사실 (코드 확인)

- **사실 1 — reliability는 `score`에만 영향.** `evaluateOp`에서 `ev.score += reliabilityBonus * 30`이며
  `blocked`/`requiresHuman`엔 무관(`src/reducer/policy.ts`). ⇒ 액터 reliability 변화는 **경합 그룹(멤버≥2)**
  에서 순위/동점에만 영향. 단일·비경합 op는 reliability와 무관하게 결정 ⇒ **dirty-set을 좁게 가둘 수 있다**.
- **사실 2 — oid = canonical JSON 바이트의 sha256(oid/sig 제외), `core/canonical.ts`의 `serialize`가 단일
  choke point.** ⇒ CBOR은 oid 정의를 JSON 바이트에 고정한 채 **저장/전송 인코딩만** 교체하면 oid-중립이며
  append-only 불변식을 건드리지 않는다.

또 하나의 미묘점: **"우리에게 새 op" ≠ "인과적으로 최신".** sync로 들어온 op은 인과적으로 *중간*일 수 있다.
단, causalDeps는 과거만 가리키므로 기존 op의 조상 집합은 append로 **자라지 않는다**(기존 op이 delta op에
의존할 수 없음). 하니스는 delta를 임의 위치에서 뽑아 이를 강제로 친다.

## Track A — Incremental reduce (O(Δ))

reduce 파이프라인(분석):
1. canonical 정렬(ops by lamport,oid).  2. `ancestry`.  3. `verdictMap(authority)`.  4. `evByOp`.
5. `keysOf`로 그룹화.  6. 그룹별 `decideGroup` → op별 `stricter` 집계.  7. note 승격.
8. 투영·`kahnOrder`·`applyOp` → tree/treeHash.  9. frontier headOps.
10. (repo) 2-pass: cross/semantic 보류 후 재reduce.

### dirty-set 규칙 (정확성의 핵심)

다음 키만 재계산(decideGroup), 나머지는 base의 per-key 결정을 재사용:

- delta op의 `keysOf`(note는 `op:<oid>` 싱글턴).
- **그룹 멤버십이 바뀐** 키(= delta op이 그 키를 가질 때만 발생) 및 base에 없던 새 키.
- delta **decision**이 가리키는 op들의 키 — *무조건*(verdict는 blocked/accept를 뒤집음).
- delta **evidence**의 `forOps` op들의 키 — *무조건*(evidence는 `blocked`/`requiresHuman`을 뒤집음).
- **reliability가 바뀐 액터**의 op 중 **경합 그룹(멤버≥2)**에 든 키 — 사실 1에 따라 contention 게이트.

클린 키 재사용이 안전한 이유: `decideGroup`은 (그룹 멤버 + 그룹내 ancestry + 해당 멤버의 verdict/evidence/
reliability + 불변 policy/intent)에만 의존. 위 dirty 규칙이 이 입력들이 바뀐 모든 키를 포착하므로, 클린 키의
입력은 base와 동일 ⇒ 결정 동일. conflicts/autoDecisions도 키별로 캐시해 **그룹 삽입 순서대로** 재방출하면
배열 순서까지 base와 일치(동치에 필수).

### 단계 (각 1 PR, main 머지)

- **A0 — 오라클 하니스 + 순수 `reduceIncremental` (production 미배선).** ✅ *본 PR.*
  `src/reducer/incremental.ts`의 `reduceIncremental(snapshot, next)`와 `test/incremental-equivalence.test.ts`
  (시드 PRNG 무작위 op-DAG: rename·concurrent·decision·evidence·cross-granularity·다중 액터, 임의 위치
  delta, reliability 섭동). `reduce`를 `reduceCore`로 무손실 추출(동작 불변, 기존 테스트로 게이트).
  전제 미충족 시 `NonIncrementalError`로 throw(호출자 fallback 신호). tree는 전체 재구성(A3에서 증분화).
- **A1 — dirty-set 정밀화 & 측정.** 위 규칙 구현 확정 + `reduce.ms` 벤치로 클린-키 스킵 이득 측정.
- **A2 — 클린 그룹 conflicts/autoDecisions 캐시 재방출.** (A0에 포함; 별도 강화 시 분리.)
- **A3 — 증분 tree.** accepted Δ가 작으면 tree 부분 갱신, 아니면 재구성.
- **A5 — Repo IO 계층: persistent op-log + tail read.** 모든 op-ingress(`proposeOperation`·pull/
  hubClient·importBundle)에 append-only op-log 유지, 마지막 `ReductionResult`를 (line,filter,op-log
  merkle)로 캐시해 append분만 읽음. ⚠️ ingress 누락 = 조용한 분기 → rebuild-동치 테스트로 완화.
- **A6 — 자가검증 가드.** `AVCS_VERIFY_INCREMENTAL=1`(CI/테스트 ON)일 때 fast 경로가 full도 돌려
  treeHash+statuses 동일성 assert·불일치 throw. prod OFF. 기존 테스트가 구체 해시를 단언하므로 분기 즉시 검출.

**Fallback(언제나 정답):** policy/authority/materializeStatuses 변경, line/filter 변경, next ⊉ prev,
캐시 부재, reliability 광역 무효화 임계 초과 → full `reduce`.

## Track B — 저장 포맷 (CBOR / packing / compaction)

- **B1 — CBOR (oid-중립).** `core/canonical.ts`만 격리. oid는 canonical-JSON 바이트 해시 유지(사실 2),
  CBOR은 디스크/전송 인코딩만. 동치: 무작위 객체 N개 JSON↔CBOR↔객체 라운드트립, **oid 불변**.
- **B2 — packing.** loose→packfile, 읽기는 pack→loose. 순수 저장. GC·읽기 동치 테스트.
- **B3 — compaction (최고위험).** checkpoint 뒤 superseded 저수준 op를 semantic op로 fold. 그래프를
  건드리므로 **모든 checkpoint에서 materialize(after)≡materialize(before)** + append-only 감사 보존을
  무작위 히스토리로 게이트. B 트랙 마지막.

## Track C — 인프라 의존 (sandbox 밖, 인터페이스만)

object-storage(S3/GCS)·governance DB(Postgres/etcd CAS)·mTLS/OIDC·native tree-sitter·HSM/threshold
키·OTel collector. 인터페이스는 이미 격리(예: `EntityIndexer`). 어댑터 자리·문서만, 실제 연동은 인프라
프로비저닝 시.

## 권장 순서

A0 → A1–A3(reducer 증분, 동치 게이트) → A5–A6(IO 이득 + 가드) → B1 → B2 → B3.
