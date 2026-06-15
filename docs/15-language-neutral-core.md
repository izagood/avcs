# 15 — 언어 중립 코어 (재설계)

> 이 문서는 Phase 2의 symbol-granular 머지를 **폐기**하고, avcs를 **프로그래밍 언어를
> 전혀 모르는 순수 텍스트 VCS**로 다시 설계한다. 코어는 무슨 언어인지, 코드이긴 한지조차
> 알지 못한다. 모든 차별화는 머지 granularity가 아니라 **원장/정책/조정 레이어**에 있다.

## 0. 동기 — 무엇이 잘못이었나

기존 설계(`docs/03`, `07` Phase 2)는 파일을 symbol/gap span으로 파싱해 "같은 파일 다른
함수 동시편집"을 자동 머지했다. 그 대가로 **언어 지식이 코어에 박혔다**:

- `src/semantic/symbols.ts` — TS/JS brace 스캐너(`DECL` 정규식, `BRACE_FORMS`). 다른 언어는
  심볼 0개 → 통짜 폴백. `tsIndexer`가 유일한 `EntityIndexer`이고, `reducer.applyOp`이 파일
  종류와 무관하게 **항상 그것을 호출**했다 — 언어 디스패치조차 없는, 사실상 TS 전용 코어.
- `src/semantic/contract.ts` — TS `function` 시그니처 정규식.

**VCS는 텍스트를 머지한다.** git은 Rust든 마크다운이든 JSON이든 모르고도 머지한다. 코드
구조(심볼/함수/AST) 인식은 VCS가 가질 이유가 없는 결합이었다. 파싱하는 지능은 이미
에이전트(LLM) 안에 있다 — 코어가 그걸 중복할 필요가 없다.

## 1. 원칙

1. **코어는 언어를 모른다.** 머지 단위는 순수 텍스트(라인/헝크). 어떤 파일이든 동일.
2. **지능은 에이전트, 결정론은 코어.** 에이전트가 파일 내용을 만들고, 코어는 결정론적으로
   3-way 텍스트 머지한다.
3. **차별화는 원장에 있다.** intent·operation·evidence·policy·decision·lease — 이것이
   git 대비 우위이며, 전부 언어 중립이다.
4. **정직한 포지셔닝.** 텍스트 머지 품질은 git과 동급(헝크 단위)이다. avcs가 git을 넘는
   지점은 "충돌을 어떻게 텍스트로 보여주나"가 아니라 "충돌을 구조화된 객체로 만들어 정책으로
   자동 결정하고, evidence로 게이팅하고, lease로 사전 예방하는가"다.

## 2. 삭제되는 것

| 삭제 | 사유 |
|---|---|
| `src/semantic/symbols.ts` | EntityIndexer·brace 스캐너·spliceSymbol·renameSymbol·extractSymbol — 언어 구조 인식 |
| `src/semantic/contract.ts` | 시그니처 추출·참조 탐지 — 언어별 의미 분석 |
| op `set_symbol`/`rename_symbol`/`move_symbol` | 심볼 개념 제거 |
| `keysOf`의 `symbol:…` 키 | 모든 파일 연산이 `file:<path>`로 키잉 |
| `detectCrossGranularity`, `SemanticConflict`, semantic 2-pass | symbol/file 혼합 문제가 애초에 소멸 |

`src/semantic/` 디렉터리가 통째로 사라진다. 코어 코드는 **줄어든다**.

## 3. 연산 모델 (전부 언어 중립)

```ts
type OperationKind =
  | "put_file"    // { path, blobOid }              생성 / 통짜 교체
  | "edit_file"   // { path, baseBlobOid, blobOid }  base에서 파생된 새 전체 내용 (★ 신규)
  | "delete_file" // { path }
  | "rename_file" // { fromPath, path }
  | "note";       // 트리 비변경
```

- 에이전트는 **자기가 쓴 파일 전체**(`blobOid`)와 **어떤 내용에서 시작했는지**(`baseBlobOid`)만
  제출한다. 심볼을 선언할 필요가 없다 — 파일만 쓰면 된다.
- `baseBlobOid`는 이 편집의 3-way 머지 base(공통 조상)다. 비어 있으면("") base가 빈 파일.
- 저장은 content-addressed라 통짜 내용도 dedup된다. 델타 저장은 후속 최적화.

### put_file vs edit_file
- `put_file`은 base 없는 통짜 쓰기(생성/덮어쓰기). 동시 put_file 두 개는 **base 공유가 없으니**
  3-way 머지가 불가능 → L2 충돌(정책 결정).
- `edit_file`은 base가 있으니 동시 편집이 3-way 머지 가능 → 안 겹치면 L1.

## 4. 머지 substrate — 연산 기반 텍스트 3-way 머지

git의 머지-베이스 모델과 동일하되, 단위가 순수 라인이다.

```
같은 파일에 동시(인과적으로 무관한) edit_file 여러 개
  → base = 그들의 공통 조상 내용
  → 각 op의 헝크(base→new diff)를 base 위에 합성
      ├ 겹치지 않는 헝크   → 자동 합성 (L1)
      └ 겹치는 헝크         → ConflictRegion (정책/사람 결정)
```

### 4.1 `merge3(base, sides[])` — 코어의 유일한 새 부품
- 입력: base 텍스트 + N개의 변형 텍스트(각 op의 결과), op 순서는 canonical(lamport, oid).
- 라인 단위 LCS diff로 각 side의 헝크(base 라인 구간 → 대체 라인들)를 추출.
- 서로 다른 side의 헝크가 **겹치지 않으면** 전부 적용. **겹치면** 그 base 구간을
  `ConflictRegion{ base, options: side별 대체 }`로 표시.
- 출력: `{ merged: string, conflicts: ConflictRegion[] }` — `conflicts`가 비면 완전 자동 머지.
- **결정론**: 같은 base + 같은 side 집합 + canonical 순서 → 항상 동일 결과. 알고리즘 버전을
  `MATERIALIZER_VERSION`에 핀해 리플리카 분기를 차단.
- **언어 무지**: 라인만 비교한다. py·java·md·json·ts·js·rust·c·cpp 전부 동일 경로.

### 4.2 충돌의 표현
git처럼 `<<<<<<<` 마커를 파일에 쓰지 **않는다.** 겹치는 헝크는 reducer가
`Conflict` 객체(옵션 = 각 side, 정책 추천, 책임자)로 올린다. 트리에는 충돌이 해소된
(정책 자동결정 또는 사람 decision) 단일 합성 blob만 들어간다. 미해소 시 그 파일은
해당 view에서 **보류**(이전 base 유지 + Conflict 노출).

## 5. reducer 변경 (구조 유지, 키·머지만 교체)

기존 아키텍처(키로 그룹핑 → 그룹 결정 → 합성 blob → 결정론 + 증분)는 **그대로**. 세 군데만:

1. **`keysOf`**: 모든 파일 연산이 `file:<path>`. (`rename_file`은 from/to 둘 다.) 심볼 키 제거.
2. **그룹 결정 (`decideGroup`)**: 파일 그룹의 동시 head들을 **"하나 고르기"가 아니라 3-way
   머지**. 핵심 전환 — 충돌 해소 단위가 *op 전체*에서 *겹치는 헝크*로 내려간다.
   - head가 1개: 그대로 적용.
   - head가 N개(동시 edit_file): base = head들의 공통 인과조상 파일 내용. `merge3` 실행.
     - `conflicts` 비면 → 합성 blob 채택, 전 op `accepted`.
     - `conflicts` 있으면 → 그 파일에 대한 `Conflict`(겹친 헝크별 옵션). 정책이 헝크별로
       자동결정 가능하면 결정(기록), 아니면 `needs_decision`.
   - put_file가 섞이면(공통 base 없음) → 종전처럼 op 단위 정책 결정(L2).
   - evidence 게이트·trust·human-wins·intent 제약은 **op 단위로 그대로** 선적용(차단/escalate),
     통과한 head들만 머지 대상.
3. **`applyOp`**: `edit_file`은 현재 트리 내용을 base로 `merge3` 결과를 합성 blob으로. 단일
   순차 적용 경로에서는 side가 1개이므로 단순 치환과 동치.

`synthBlobs` 결정론 기계(`reducer.ts`)는 그대로 재사용 — 합성 내용 출처만
`spliceSymbol` → `merge3`로 교체된다.

## 6. 충돌 사다리 (이제 순수 텍스트)

| 등급 | 조건 | 처리 | 언어 의존 |
|---|---|---|---|
| L0 | 다른 파일 | 독립 | 없음 |
| L1 | 같은 파일, 안 겹치는 헝크 | `merge3` 자동합성 | **없음** |
| L2 | 같은 파일, 겹치는 헝크 / 공통base 없는 put_file | 정책 자동결정(기록) 또는 사람 | 없음 |
| L3 | 동작 변경 + 신뢰 evidence 없음 | 차단 | 없음 (`effects.changesBehavior` **선언** 기반) |
| L4 | API 파괴 / 사람 필요 | escalate → owner | 없음 (`effects.breaksPublicApi` **선언** + `api_compat` evidence) |

L3/L4가 살아남는 이유: 파싱이 아니라 **에이전트의 선언 + CI evidence**에 기반한다. 이미
언어 중립이었다(`policy.ts`). `contract.ts`의 정규식은 이 경로의 중복이라 삭제해도 안전하다.

## 7. 정직한 재포지셔닝 — git 대비 우위는 어디서 오나

언어 인식을 빼면 avcs의 **텍스트 머지는 git과 동급**(헝크 단위)이다. "git보다 충돌이 적다"는
이제 다음에서 온다 (전부 언어 중립):

- **구조화된 Conflict 객체** — 인라인 마커가 아니라 정책이 자동 결정하거나 책임자에게 라우팅,
  근거 기록. 사람이 마커를 손으로 풀 필요가 없다.
- **evidence 게이팅** — 테스트 통과 없는 동작 변경은 트리에 들어오지 못한다 (git엔 없음).
- **lease** — 충돌을 사후 해결이 아니라 사전 예방.
- **intent·decision 메모리·reliability·lineage·release provenance** — git이 안 주는 원장.

### 선택적 정밀 티어 (여전히 언어 중립)
라인 diff3가 결정론적 기본값이다. 더 잘게 가고 싶으면 **토큰/문자 단위 텍스트 머지**로
"같은 라인의 다른 단어를 두 에이전트가 편집"까지 자동 합성할 수 있다 — 이는 **텍스트일 뿐
언어 구조가 아니므로** 원칙에 어긋나지 않는다. 단 충돌 품질 리스크가 있어 옵트인 티어로 둔다.

## 8. 마이그레이션 / 호환

- 객체 모델 변경은 파괴적이다. `set_symbol`/`rename_symbol`/`move_symbol` 객체를 가진 기존
  레포는 마이그레이션 필요(심볼 op → 해당 시점 파일 내용의 `edit_file`로 재투영). MVP 단계라
  하위호환 별칭은 두지 않고 깨끗이 교체한다.
- `MATERIALIZER_VERSION`을 bump(`avcs-text3-mvp/0.1.0`)해 구·신 트리를 구분한다.

## 9. 검증 계획 (이 재설계의 정밀 분석)

설계가 agentic VCS로서 헛점이 없는지, **다른 worktree에서 완전히 구현한 뒤 다언어 케이스로**
실측한다. 언어: python·java·md·json·ts·js·rust·c·cpp.

각 언어마다 동일한 시나리오 매트릭스:
- **C1 disjoint**: 두 에이전트가 같은 파일의 떨어진 영역 편집 → L1 자동머지, 양쪽 변경 보존.
- **C2 overlap**: 같은 라인 구간 동시 편집 → L2 Conflict, 정책 결정 기록.
- **C3 adjacent**: 인접 라인 편집 → 머지 동작 정의 확인(겹침 판정 경계).
- **C4 determinism**: op 순서를 뒤섞어도 동일 treeHash (canonical 정렬 검증).
- **C5 base-drift**: 한 op의 base가 이미 바뀐 내용 → 헝크 미적용/충돌로 안전 처리.
- **C6 create/replace**: 공통 base 없는 동시 put_file → L2.
- **C7 evidence gate**: 동작 변경 op이 evidence 없이는 차단(L3) — 언어 무관 동일.
- **C8 cross-language repo**: 한 레포에 여러 언어 파일 혼재 → 파일별 독립 처리.

**헛점 탐지 관점** (정밀 분석에서 반드시 점검):
1. 라인 머지가 만드는 "텍스트는 깨끗한데 의미가 깨진" 머지(예: import 누락, 괄호 불균형) —
   설계상 evidence(typecheck/test) 게이트로만 잡힌다. 그 게이트가 실제로 잡는가?
2. 겹침 판정의 경계(인접/포함/엇갈림)에서 결정론이 유지되는가?
3. base-drift 시 silent corruption이 없는가(반드시 충돌로 떨어지는가)?
4. put_file 동시성이 데이터 손실 없이 L2로 가는가?
5. 바이너리/거대/비-UTF8 파일에서 라인 머지가 안전 폴백(통짜 충돌)하는가?
6. CRLF/LF·말미 개행 차이가 거짓 충돌을 만들지 않는가?

분석 종료 조건: 위 매트릭스를 다언어로 실행해 설계 명세대로 동작함을 확인하고, 발견된
헛점을 본 문서 §10에 기록했을 때.

## 10. 정밀 분석 결과

재설계를 worktree(`worktree-lang-neutral-core`)에서 **완전히 구현**하고, 재설계된 코드 위에서
다언어 케이스를 실제 `Repo`/`reduce()` 파이프라인으로 돌려 검증했다.

### 10.1 구현 범위 (실제로 한 것)
- 코어의 유일한 새 부품 `src/merge/merge3.ts`(언어 무지 N-way 라인 3-way 머지) 신설.
- `src/semantic/`(symbols.ts·contract.ts) **디렉터리 통째로 삭제** — 언어 결합 제거.
- op 모델 교체: `set_symbol`/`rename_symbol`/`move_symbol` → `edit_file{path, baseBlobOid, blobOid}`.
- reducer: `keysOf`(전부 `file:`), `applyOp`(edit_file=merge3 patch), `decideGroup`(동시 edit_file
  전부 accept — winner-pick 폐기), `detectCrossGranularity`→`detectFileConflicts`(N-way merge3),
  `semanticConflicts`→`fileConflicts`.
- repo: `proposeEdit` 헬퍼, 2-pass를 `detectFileConflicts`로, release 게이트 갱신.
- 심볼 전용 테스트 5개 삭제, 부수 사용 13개 테스트를 `edit_file`로 이관.

### 10.2 측정 결과
- **`tsc --noEmit`: 0 errors.** 코어에 언어 의존 코드 0줄.
- **전체 테스트: 176/176 pass (51 파일).** 원장/거버넌스/sync/lineage/release/incremental 기계가
  머지 substrate 교체에도 그대로 동작 — 차별화 레이어 무손상.
- **다언어 매트릭스 21/21 pass** (`test/lang-neutral-matrix.test.ts`, 실제 파이프라인):
  - L1 disjoint 자동머지: **python·java·md·json·ts·js·rust·c·cpp 9/9** — 두 변경 모두 보존.
  - L2 overlap 충돌: **9/9** — 겹친 영역에 양쪽 옵션 포함한 `fileConflict` + release 게이트 차단.
  - 결정론(저작 순서 무관 동일 treeHash), 크로스언어 독립성(L0), 동시 put_file 충돌(데이터 손실 0).
- **merge3 단위 26/26 pass** (6언어 × 8시나리오: 결정론·agreement·바이너리 폴백·삽입·의미갭).

### 10.3 설계가 명세대로 동작함 (확인됨)
1. **언어 중립**: 9개 언어가 분기 없이 동일 경로로 머지 — VCS가 언어를 모른다는 원칙 실측 충족.
2. **결정론**: 같은 base+ops → 모든 리플리카/순서에서 동일 트리. `MERGE3_VERSION` 핀으로 보호.
3. **cross-granularity 홀 폐쇄**: 구설계의 `put_file ∥ set_symbol` 비결정성(서로 다른 키)이 사라짐 —
   이제 모든 파일 op이 `file:<path>`로 키잉돼 동일 충돌로 수렴(이관된 determinism 테스트가 입증).
4. **L3/L4 무손상**: 동작변경 evidence 게이트·API파괴 escalation이 **선언 effects+evidence**(언어 중립)로
   유지 — 파싱 없이.

### 10.4 발견된 설계 헛점 / 한계 (정직하게)

| # | 헛점 | 심각도 | 완화/후속 |
|---|---|---|---|
| **H1** | **영역별 충돌 해소가 정책 중재가 아니라 incumbent-wins(lamport-first)로 단순화됨.** 겹친 영역의 트리 내용은 결정론적으로 "먼저 적용된 op"이 차지하고, 정책(trust/evidence/owner)이 **영역 단위로 승자를 고르지 않는다**(needs_human 플래그만). 구설계는 op 단위로 정책이 승자를 골랐음 — 이 표현력의 회귀. | 중 | release가 충돌을 게이팅하므로 미검토 콘텐츠는 배포 불가. 후속: merge3가 이미 옵션을 side→op로 태깅하니, 영역별 op 정체성+정책 점수를 해소에 연결. |
| **H2** | **텍스트는 깨끗한데 의미가 깨진 머지(import 제거 ∥ 그 사용 추가)는 머지가 절대 못 잡고 evidence로만 잡힌다.** 언어 중립 VCS의 **본질적** 한계(git도 동일). 게다가 evidence 게이트는 op이 `changesBehavior`를 **선언**해야 발동 → 미선언 시 우회 가능. | 중(본질적) | agentic 사용에선 보호 view에서 edit_file에 evidence **필수화**(정책 require_evidence를 op-kind 기준 기본 규칙으로). C8 테스트로 갭을 명시 고정. |
| **H3** | **criss-cross(서로 다른 base) 동시편집**: detectFileConflicts가 base를 사전식 첫 oid로 보수적 선택 → 충돌 집합이 과/소보고될 수 있음. 트리 내용(applyOp pairwise)은 항상 안전(incumbent). | 하 | 공통 base 케이스는 정확. 재귀적 merge-base는 후속. 결정론은 유지. |
| **H4** | **라인 granularity는 같은 라인 동시편집을 합성 못 함**(예: 한 시그니처에 서로 다른 인자 추가 → 충돌). 구 symbol 머지보다 거칠지 않고 git과 동급. | 하(설계상) | §7의 토큰/문자 단위 티어(여전히 언어 중립)로 머지율 상향 — 옵트인. |
| **H5** | **CRLF/인코딩**: merge3가 raw 라인 비교 → CRLF∥LF는 전 라인 거짓 충돌. 말미 개행 차이는 split/join 무손실로 거짓충돌 없음(검증). | 하 | 정규화 정책 필요(미구현). §9.6에 명시. |
| **H6** | **증분 reduce는 file-conflict 패스를 직접 돌리지 않음**(repo 레이어 post-pass가 전체 op로 권위 수행). append-only 성장에선 새 동시 op이 항상 dirty라 안전. | 하 | full materialize는 항상 정확, incremental-equivalence 하니스가 트리 동치 강제(green). |

### 10.5 종합 판정
재설계는 **agentic VCS 코어로서 건전하다.** 언어 중립 머지 substrate가 9개 언어에서 명세대로
동작하고(실제 파이프라인 실측), git이 못 주는 차별화(원장·정책·evidence·lease·거버넌스)는 176 테스트
green으로 무손상이다. 텍스트 머지 품질은 정직하게 git과 동급(헝크 단위)이며, 우위는 "충돌을 구조화된
객체로 만들어 정책/evidence/lease로 다루는" 제어 평면에서 온다(§7).

가장 실질적인 헛점은 **H1(영역별 정책 중재 부재)**, 본질적 한계는 **H2(의미 깨짐은 evidence로만)**.
둘 다 완화책이 있고 결정론·데이터 무손실을 깨지 않는다. → **언어별 구조 인식을 코어에서 완전히
제거한다는 목표는 달성**했고, 남은 것은 제어 평면(H1)과 evidence 강제(H2)의 강화다.
