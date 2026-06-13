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
- **A1 — 측정 & 병목 식별.** ✅ `bench/incremental-bench.ts`(+`npm run bench:incremental`) + `reduceIncremental`
  재사용 통계(`IncrementalStats`). **측정 결과(중요):** +1op delta에서 clean-group **재사용률 99.9%**(2000/2001
  그룹 스킵)인데도 **speedup ≈ 1.0x**. 즉 `decideGroup`은 병목이 아니다. O(N) 바닥은 **(a) `ancestry` 전체
  재계산 + (b) tree materialization(`kahnOrder`+`applyOp`) + (c) treeHash 전체 재해시** — A0가 무조건 수행하는
  세 가지다. ⇒ A3 범위를 "tree 증분"에서 **"ancestry·tree·treeHash 3종 증분"**으로 재정의(아래).
- **A2 — 클린 그룹 conflicts/autoDecisions 캐시 재방출.** (A0에 포함.)
- **A3 — 증분 tree + 공유 hot-path 수정.** ✅ 증분 tree를 구현하던 중 instrumentation으로 **진짜 지배 비용**을
  발견: `decideGroup`·splice가 아니라 **`headOps` frontier 계산의 O(accepted²) all-pairs 스캔**이었다.
  - *frontier 수정(헤드라인)*: "covered = 어떤 accepted op의 조상에 든 op" 집합을 O(Σancestors)로 모아
    `accepted \ covered`. **출력 동일**, full `reduce`가 N=3000에서 **172ms→25ms (6.7x)** — 모든 materialize에
    공통 이득(repo cold도 ~859→680ms). 이게 A1이 가리킨 "O(N) 바닥"의 실체였다.
  - *증분 tree*: 변경 없는 경로는 base tree 재사용, dirty 경로만 global kahn 순서로 replay → set_symbol splice
    스킵. dirty 경로 = projected-멤버십 변경 op의 경로 ∪ projected cross-path(rename/move) 양 경로 ∪
    ancestry-extension 경로. `synthBlobs`는 최종 tree 참조분만 유지(`pruneSynth`)해 base 재사용을 정확히.
  - *잔여*: frontier 수정 후 full reduce가 이미 빨라 증분 추가 이득은 1.2–1.6x. ancestry/treeHash 증분(Merkle)은
    절대 시간이 작아 후순위. 진짜 end-to-end 이득은 A5(disk re-read 제거)+A6(배선)에서. 동치는 A0 하니스가 강제.
- **A5 — persistent op-log (foundation).** ✅ `ObjectStore.put`의 **단일 write choke point**에서 새 operation
  oid를 append-only `oplog`에 기록 — 저작·pull·importBundle·hub push 등 ingress 경로와 무관하게 자동 일관
  (ingress 누락으로 인한 조용한 분기 원천 차단). `readOpLog()`(first-write 순서·dedup)·`rebuildOpLog()`(구
  스토어/손상 backfill). 불변식 `oplog ⊇ 현재 operations`를 테스트로 강제(저작·pull·import·rebuild). GC로
  지워진 op oid는 로그에 남을 수 있어 reader가 missing object를 tolerate(스토어가 진실의 원천).
- **A6 — repo.materialize IO tail-read (인메모리 op·blob 캐시).** ✅ `materialize`가 `collect("operation")`
  전체 샤드 스캔 대신 `oplog`를 tail-read해 캐시에 없는 oid만 디스크에서 읽음(+1op = 새 객체 1개만 읽기).
  블롭은 content-addressed·불변(redaction 예외)이라 oid로 캐시. 둘 다 디스크에 대한 순수 최적화 — 정확성은
  의존하지 않고, 무효화 트리거(gc 삭제·redaction/pull의 바이트 덮어쓰기)에서만 비움. **측정(N=3000): +1op
  708→220ms(3.2x), warm 333→92ms(3.6x), cold 변화 없음.** 잔여 220ms는 디스크 IO가 아닌 **여러 O(N) 컴퓨트
  패스**(sig 빌드·reliability·2-pass ancestry·reduce). warm==cold 동치를 저작·gc·redaction에 대해 테스트.
- **A6b — reduceIncremental opt-in 배선 + 자가검증 가드.** ✅ 메인 `materialize`가 `AVCS_INCREMENTAL=1`일 때
  마지막 스냅샷에서 delta만 `reduceIncremental`(전제 미충족 시 full `snapshotReduce` fallback). 키 불필요 —
  reduceIncremental은 **임의 append-superset에 정확**(하니스 증명)하고 아니면 throw→fallback. 서브셋 reducer
  (materializeAt/history/bisect)는 스냅샷을 읽지도 오염시키지도 않음. **기본 OFF = 기존 full reduce(안전).**
  `AVCS_VERIFY_INCREMENTAL=1`이면 매 incremental 결과를 full과 교차검증해 불일치 시 throw — `npm test`를 두
  플래그 ON으로 돌려 **114개 전 시나리오에서 wired 경로 == full** 입증(가드 미발화). 한계이득(reduce 패스만
  절감)이라 prod 기본 OFF가 합리적이며, 큰 N에서 reduce가 다시 지배하면 켜서 이득. **Track A 완료.**

**Fallback(언제나 정답):** policy/authority/materializeStatuses 변경, line/filter 변경, next ⊉ prev,
캐시 부재, reliability 광역 무효화 임계 초과 → full `reduce`.

## Track B — 저장 포맷 (CBOR / packing / compaction)

- **B1 — CBOR (oid-중립 disk 인코딩).** ✅ 무의존 canonical CBOR codec(`core/cbor.ts`)으로 디스크 객체를
  CBOR 저장. **oid는 canonical-JSON 해시 유지**(`computeOid` 불변) → content-addressing·서명·treeHash 무영향.
  `ObjectStore`가 첫 바이트로 CBOR(major 5)/legacy JSON(`{`)을 sniff해 **dual-read** → 기존 저장소 무중단
  호환. **와이어·번들은 JSON 유지**(hub은 deserialized 객체를 `JSON.stringify`) → blast radius 최소. 검증:
  2000-seed 코덱 라운드트립 + oid-중립 + dual-read + full-repo warm==cold. **측정: operation 객체 16.9% 작음.**
- **B2 — packing.** ✅ `ObjectStore.pack()`가 loose **non-blob** 객체를 packfile(+`oid offset length` 인덱스)로
  접고 loose를 삭제. 읽기는 **loose→pack** fallback(loose가 pack을 shadow) → 투명한 읽기 최적화. **blob은 pack
  제외** — redaction이 blob 바이트만 overwriteAt로 덮으므로 blob을 loose로 둬야 평문 scrub이 항상 가능(pack
  평문 잔존 위험 차단). crash-safe(packfile 먼저 쓰고 loose 삭제). `repo.pack()`·CLI `pack` 노출. 검증:
  pack 후 materialize 동일(cold reopen)·non-blob loose 0·blob loose 유지·pack 후 redaction scrub. *GC는 loose만
  회수(packed 객체는 materialize 정확성엔 무영향, 공간은 향후 repack에서) — 문서화된 한계.*
- **B3 — compaction (persisted-snapshot base).** ✅ `compact(view)`가 현재 reduction을 직렬화(`serializeSnapshot`,
  CBOR)해 `.avcs/snapshot/<view>.cbor`에 **durable base**로 저장. cold materialize는 `AVCS_COMPACT=1`일 때 이
  base를 로드해 **그 이후 추가된 op만 `reduceIncremental`** — 정착된 히스토리를 base로 fold하고 재replay 회피.
  원본 op는 디스크에 그대로(append-only 감사 보존). 정직한 한계: reduceIncremental은 `prev.ops`의 `.oid`만
  읽으므로 base에 op 본문을 중복 저장하지 않고, cold IO(전체 op 스캔)는 여전 — 진짜 이득은 reduce **컴퓨트**
  fold(큰 N에서 의미). **정확성 = Track A 불변식**: `reduceIncremental(base,current) ≡ full`. CBOR 역직렬화
  객체는 키 정렬되므로 자가검증 가드를 `canonicalize`(키 순서 무관) 비교로 강화. 검증: compact→cold reopen
  materialize==full(충돌/결정 히스토리 포함), base+delta==full, 그리고 **INCREMENTAL+COMPACT+VERIFY 3플래그
  ON으로 전체 122 테스트 통과**(가드 미발화). opt-in(prod 기본 OFF). **Track B 완료.**

## Track C — 인프라 의존 (sandbox 밖, 인터페이스만)

object-storage(S3/GCS)·governance DB(Postgres/etcd CAS)·mTLS/OIDC·native tree-sitter·HSM/threshold
키·OTel collector. 인터페이스는 이미 격리(예: `EntityIndexer`). 어댑터 자리·문서만, 실제 연동은 인프라
프로비저닝 시.

## 권장 순서

A0 → A1–A3(reducer 증분, 동치 게이트) → A5–A6(IO 이득 + 가드) → B1 → B2 → B3.
