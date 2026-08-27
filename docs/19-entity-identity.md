# 19 — 파일 정체성: rename × edit 가환성 복원

> **상태: 설계 (구현 전).** 이 문서는 창립 문서 [00 — 개요](00-overview.md) **원칙 2**
> — "파일 경로가 아니라 Entity ID가 정체성이다 → rename + edit가 자동 병합 가능" —
> 을 코어에 복원하는 설계다. [15 — 언어 중립 코어](15-language-neutral-core.md) 재설계가
> 언어 인식을 걷어낼 때 이 원칙까지 함께 탈락시켰고(같은 문서 §11), 그 탈락은
> 트레이드오프로 기록되지 않았다. 언어 중립성은 유지한다 — **정체성은 언어 레이어가 아니라
> 경로 레이어의 문제**이므로 둘은 충돌하지 않는다.

## 1. 배경 — 정확히 무엇이 깨져 있나

### 1.1 증상

한 actor가 파일을 옮기고(`rename_file`), 다른 actor가 **인과적으로 무관하게** 그 파일을
편집(`edit_file`)하면, 두 변경이 자동 병합되지 않는다. 실측 사례: 병렬 에이전트 프로젝트에서
한쪽이 29개 파일의 경로를 재배치하고 다른 쪽이 그 파일들을 편집한 결과, 32개 파일이 겹치는
대형 충돌이 발생해 두 차례의 수동 재병합이 필요했다.

### 1.2 기계적 원인 — `applyOp`의 순서 의존

`src/reducer/reducer.ts`의 `applyOp`는 canonical 순서(`lamport, oid`)로 op을 트리에 적용한다.
두 op의 상대 순서에 따라 결과가 갈린다:

| canonical 순서 | 결과 |
|---|---|
| `edit_file(P)` → `rename_file(P→Q)` | **정답.** 편집이 P에 적용된 뒤 Q로 이동 |
| `rename_file(P→Q)` → `edit_file(P)` | **오답.** 파일은 Q로 갔는데, `edit_file`이 `tree.get(P)`를 못 찾아 `current = opBase`로 **P를 되살린다** → 같은 내용의 파일이 P·Q 두 곳에 존재하고, 편집은 죽은 경로 P에 남는다 |

관련 코드 사실:
- `rename_file`은 "그 순간 `tree`에 `fromPath`가 있을 때만" 이동한다(없으면 **무음 무동작**).
- `edit_file`은 `tree.get(b.path)`가 비어 있으면 `current = opBase`로 삼아 **파일을 생성**한다.
- `keysOf(rename_file)`은 `[file:<fromPath>, file:<toPath>]`를 돌려주므로, 편집 op(`[file:P]`)과
  같은 그룹에 들어가 `detectFileConflicts`가 이를 **충돌로 보고**한다.

즉 결정론(같은 op 집합 → 같은 트리)은 지켜지지만, **정합성이 lamport 순서라는 우연에 맡겨져
있다.** 절반은 틀린 트리를 만들고, 나머지 절반도 충돌로 보고된다.

### 1.3 더 앞단의 결함 — rename op이 애초에 만들어지지 않는다

git 브리지 캡처(`Repo.commitWorkingTree`)는 경로 집합의 차집합으로 `added`/`modified`/`removed`를
계산한다. 파일 이동은 `removed(P)` + `added(Q)`로 보이므로 **`rename_file` op이 발행되지 않는다.**
그 결과 §1.2의 가환성 문제 이전에, 이동이 "삭제 + 무관한 새 파일"로 기록된다:

- `delete_file(P)` ∥ `edit_file(P)` → 삭제 대 편집 충돌
- `put_file(Q)` — base 없음 → 3-way 머지 불가([15](15-language-neutral-core.md) §3)

**그래서 이 설계는 캡처(Stage 0)부터 시작해야 한다.** reducer만 고치면 실사용 경로에서는
아무 일도 일어나지 않는다.

### 1.4 정체성이 경로라는 사실 (원칙 2 위반의 소재)

- `src/objects/types.ts`: `OperationTarget.entityId` 주석이 *"Stable entity id — for files, the path"*.
  즉 **정체성 = 경로**로 명시돼 있다.
- `keysOf`는 모든 파일 op을 `file:<path>`로 키잉하고, `rename_file`만 경로 두 개를 돌려준다.
  이동을 넘어 유지되는 식별자가 **없다.**

## 2. 원칙 (제약)

1. **언어 무지 유지.** `merge3`는 지금처럼 순수 라인 텍스트만 다룬다. 정체성 해소는 경로
   레이어에서만 일어난다. `src/semantic/`은 부활하지 않는다.
2. **결정론은 신성하다.** 같은 op 집합 + 같은 정책 → 어느 replica에서도 같은 트리. 별칭(alias)
   해소는 canonical 순서와 인과 관계만 입력으로 받는 순수 함수여야 한다.
3. **하위 호환.** 기존 `.avcs` store는 무변경으로 열린다. 스키마 변경 없음(Stage 1) 또는
   옵셔널 필드만(Stage 2). rename이 없던 히스토리의 treeHash는 **바뀌지 않는다.**
4. **zero-dep.** node 표준 라이브러리만.
5. **정직한 단계화.** 한 번에 정체성 저장까지 가지 않는다. 관측된 고통을 죽이는 최소 변경을
   먼저 하고(Stage 0–1), 저장된 정체성이 필요한 능력(rename을 넘는 blame)은 Stage 2로 분리한다.

## 3. 설계 — 3단계

| 단계 | 내용 | 스키마 | 마이그레이션 | 얻는 것 |
|---|---|---|---|---|
| **Stage 0** | 캡처가 rename을 인식해 `rename_file`을 발행 | 없음 | 없음 | 이동이 삭제+생성이 아니라 이동으로 기록됨 |
| **Stage 1** | reducer가 rename 별칭을 해소해 content op을 최종 경로로 라우팅 | 없음 | 없음 | **rename × edit 자동 병합** (원칙 2의 머지 약속) |
| **Stage 2** | 정체성을 op에 저장(birth-op 앵커) | 옵셔널 필드 | 없음(레거시는 경로 앵커로 해석) | rename을 넘는 blame·history, 다중 홉 견고성 |

### 3.1 Stage 0 — 캡처의 rename 인식

`Repo.commitWorkingTree`가 `removed` × `added`를 짝지어 rename을 복원한다.

**판정 규칙 (결정론적, 언어 무지):**

1. **정확 일치** — `removed`의 P와 `added`의 Q가 **같은 blob 내용**이면 `rename_file(P→Q)` 하나만
   발행한다(내용 변경 없는 순수 이동). blob은 content-addressed이므로 oid 비교로 끝난다.
2. **이동 + 수정** — 내용이 다르면 라인 유사도로 판정한다. 임계값 **50%**(git `-M`의 기본값과
   동일)를 넘으면 `rename_file(P→Q)` + `edit_file(Q, baseBlobOid = P의 이전 내용)` 두 op을
   발행한다. `edit_file`의 `path`는 **새 경로 Q**이고 base는 **이동 전 내용**이다 — 이것이
   "옮기면서 고쳤다"의 정확한 표현이다.
3. **다대다 모호성** — 한 P가 여러 Q 후보와, 또는 한 Q가 여러 P 후보와 임계값을 넘으면
   **rename으로 판정하지 않는다**(delete + put으로 남긴다). 짝짓기는 `(경로 문자열 정렬 순,
   유사도 내림차순)`의 greedy 1:1 매칭으로 하고, 동률은 경로 사전식으로 깬다 — 같은 워킹트리
   상태에서 항상 같은 op 집합이 나오도록.
4. **바이너리** — 내용에 NUL이 있으면 유사도를 계산하지 않는다. 정확 일치(규칙 1)만 허용하고,
   아니면 delete + put.

**git 힌트 (브리지 레이어 한정, 선택적):** git 저장소 안이라면 `git diff --find-renames`의 결과를
**힌트**로 받아 후보 짝을 줄일 수 있다. 코어는 git을 모른 채 유지된다 — 이는
`gitIgnorePredicate`가 `git check-ignore`를 브리지에서만 쓰는 것과 같은 패턴([14](14-git-bridge.md)).
힌트가 없으면 위 규칙만으로 동작해야 한다(힌트는 성능 최적화이지 정확성 의존이 아니다).

**유사도 함수:** `merge3.ts`가 이미 갖고 있는 라인 LCS를 재사용한다
(`유사도 = 2 × LCS길이 / (라인수_P + 라인수_Q)`). 새 알고리즘을 추가하지 않는다.

### 3.2 Stage 1 — reducer의 별칭 해소 (핵심)

**아이디어:** content op을 `b.path`에 적용하지 않고, **rename 폐포로 해소한 최종 경로**에 적용한다.
그러면 rename과 edit의 상대 순서가 결과에 영향을 주지 않는다 — 두 op이 **가환**해진다.

**Pass A — 별칭 맵 구성.** accepted된 `rename_file` op들을 canonical 순서로 훑어
`aliases: Map<경로, 최종경로>`를 만든다. 체인은 폐포까지 따라간다(P→Q, Q→R ⇒ P↦R, Q↦R).

**Pass B — content op 라우팅.** `applyOp`의 `put_file`/`edit_file`/`delete_file`이 사용하는 경로를
`b.path` 대신 `resolve(aliases, b.path, op)`로 바꾼다.

**`resolve`의 인과 조건 (중요).** 별칭을 무조건 적용하면 새 파일을 오라우팅한다. P→Q rename
이후에 *새로* P를 만드는 op은, 그 저자가 이미 새 세계를 보고 P를 말한 것이므로 별칭을 타면 안 된다.

> **규칙:** op이 rename op의 **인과적 후손**이면 별칭을 적용하지 **않는다.** 후손이 아니면
> (= 동시이거나 선행) 적용한다.

인과 폐포는 이미 `ancestry(ops)`가 계산한다 — 새 기계가 필요 없다.

**충돌 판정 변경 (`detectFileConflicts`):**

| 조합 | 현재 | 변경 후 |
|---|---|---|
| `rename_file(P→Q)` ∥ `edit_file(P)` | 충돌 | **충돌 아님** — 합성(편집이 Q에 실림) |
| `rename_file(P→Q)` ∥ `rename_file(P→R)` (동시, 다른 목적지) | 충돌 | 충돌 유지 — 별칭 맵은 P를 이동시키지 않고 그대로 두고 보고 |
| `rename_file(A→C)` ∥ `rename_file(B→C)` (경로 점유) | 충돌 (키 `file:C` 공유) | 충돌 유지 |
| `rename_file(P→Q)` ∥ `delete_file(P)` | 현행 의미 | **현행 의미 유지** (변경하지 않는다) — 테스트로 고정 |
| `rename_file(P→Q)` ∥ `put_file(P)` (동시, base 없음) | 충돌 | 충돌 유지 — 동시 put은 base가 없어 합성 불가([15](15-language-neutral-core.md) §3) |

**결정론 논거:** 별칭 맵은 (accepted rename 집합, canonical 순서, 인과 관계)의 순수 함수다.
세 입력 모두 이미 결정론적이므로 맵도 결정론적이고, Pass B는 맵을 읽기만 한다. 동시 다목적지
rename은 맵에 진입하지 못하므로(충돌로 격리) 순서 의존이 생기지 않는다.

**증분 reduce (`src/reducer/incremental.ts`):** 별칭 맵은 **op 집합 전체**의 함수이므로,
새 rename op이 도착하면 그 rename이 닿는 경로의 content op들도 dirty로 취급해야 한다. append-only
성장에서 새 op은 항상 dirty이므로 안전하지만, **rename이 도착했을 때 dirty 집합이 옛 경로·새 경로
양쪽의 content op을 포함하는지** 반드시 검증한다(`incremental-equivalence` 하네스가 전체 reduce와
트리 동치를 강제 — 이 하네스가 이 단계의 1차 안전망이다).

### 3.3 Stage 2 — 저장된 정체성 (후속)

Stage 1은 정체성을 **rename 그래프에서 유도**한다. 머지 가환성에는 충분하지만, 다음은 안 된다:

- rename을 넘는 `blame`/`historyOf` — 엔티티 인덱스가 여전히 경로 키라서 이동 전 이력이 끊긴다.
- 이동을 여러 번 거친 파일의 이력 조회가 경로 체인 재구성에 의존한다.

**설계 방향:** `OperationTarget.entityId`의 **의미를 복원**한다 — "현재 경로"가 아니라
"이 파일의 정체성". 앵커는 **birth op의 oid**로 한다(content-addressed, 카운터 불필요, 결정론).

순환 문제(생성 op의 oid가 payload에 들어갈 수 없음)는 **생성 시 entityId를 비워 두고 reducer가
`fid = op.oid`로 해석**하는 규약으로 푼다. 이후 op은 `entityId = <birth oid>`를 실어 보낸다.

**하위 호환:** entityId가 경로 문자열인 레거시 op은 "경로 앵커 정체성"으로 해석한다 —
`keysOf`가 돌려주는 키 문자열이 레거시에서 **문자 그대로 동일**(`file:src/x.ts`)하므로
기존 엔티티 인덱스와 treeHash가 그대로 유효하고 **reindex도 필요 없다.**

Stage 2는 별도 스펙/계획으로 분리한다. Stage 1이 관측된 고통을 죽이므로 급하지 않다.

## 4. 변경 지점 (구현 지도)

| 파일 | 변경 |
|---|---|
| `src/api/repo.ts` — `commitWorkingTree` | Stage 0: removed×added 짝짓기 → `rename_file` (+ 필요시 `edit_file`) 발행. 유사도 판정 헬퍼 추가 |
| `src/api/repo.ts` — `gitSync` / 훅 경로 | Stage 0: git 힌트(선택) 주입 지점 |
| `src/reducer/reducer.ts` — 신규 `resolveAliases` | Stage 1 Pass A: accepted rename → 별칭 맵 (순수 함수, 단위 테스트 대상) |
| `src/reducer/reducer.ts` — `applyOp` | Stage 1 Pass B: content op의 경로를 별칭으로 해소. `rename_file` 분기는 별칭 맵이 이동을 담당하므로 **트리 이동 로직을 맵 기반으로 재작성** |
| `src/reducer/reducer.ts` — `detectFileConflicts` | §3.2 표대로 rename∥edit를 충돌에서 제외, 나머지 조합은 유지 |
| `src/reducer/incremental.ts` | rename 도착 시 dirty 경로 확장 |
| `src/merge/merge3.ts` | 유사도 계산용 LCS 재사용을 위한 export (알고리즘 추가 없음) |
| `docs/15` §11 | 이 문서로의 링크 (별도 작업에서 이미 추가) |
| `docs/07` | Phase 번호 배정 |

## 5. 검증 매트릭스

기존 `test/lang-neutral-matrix.test.ts`의 C1~C8을 잇는 신규 케이스. **전부 실제
`Repo`/`reduce()` 파이프라인으로** 돌린다(단위 테스트만으로 통과 주장 금지).

| # | 케이스 | 기대 |
|---|---|---|
| **C9** | rename(P→Q) ∥ edit(P) — **헤드라인** | 충돌 0. 트리에 Q만 존재(P 없음), Q의 내용에 편집이 반영 |
| **C10** | C9의 lamport 순서를 뒤집어 재실행 | **C9와 동일한 treeHash** (가환성 = 순서 무관) |
| **C11** | rename 체인 P→Q(op1), Q→R(op2, 인과 후행) ∥ edit(P) | 트리에 R만, 편집 반영 |
| **C12** | rename(P→Q) 이후(인과 후행) put_file(P) — 새 파일 | P와 Q **둘 다** 존재. 새 P가 Q로 오라우팅되지 **않음** (인과 조건 검증) |
| **C13** | rename(P→Q) ∥ rename(P→R) 동시 | 충돌 보고. 트리는 결정론적 안전 상태(무음 데이터 손실 0) |
| **C14** | rename(A→C) ∥ rename(B→C) 경로 점유 | 충돌 보고 |
| **C15** | Stage 0 캡처: 워킹트리에서 파일 이동만 | `rename_file` 1개 발행(`put_file` 아님), 내용 동일 |
| **C16** | Stage 0 캡처: 이동 + 수정 | `rename_file` + `edit_file(Q, base=이동전내용)` 발행 |
| **C17** | Stage 0 캡처: 유사도 임계 미달 | rename 아님 — delete + put |
| **C18** | Stage 0 캡처: 바이너리 이동(정확 일치) | `rename_file`. 바이너리 유사도 계산 없음 |
| **C19** | Stage 0 캡처: 다대다 모호(P가 Q1·Q2와 유사) | rename 판정 안 함 |
| **C20** | 실측 사건 축소판: N=5 파일을 한쪽이 재배치, 다른 쪽이 같은 5개를 편집 | 충돌 0, 편집 5개 모두 새 경로에 반영 |
| **C21** | rename 없는 기존 히스토리 | treeHash 불변 (하위호환 회귀) |
| **C22** | 증분 reduce 동치 | 같은 op 집합에서 `reduceIncremental` ≡ 전체 reduce (rename 포함) |

추가로 **determinism-property 하네스**와 **전체 계약 스위트**가 green이어야 한다.

## 6. 리스크 / 미결정

| # | 리스크 | 완화 |
|---|---|---|
| R1 | **`applyOp`의 rename 분기 재작성이 머지 의미를 건드릴 수 있다.** 별칭 기반으로 바꾸면 트리 구성 순서가 달라진다 | C21(rename 없는 히스토리 treeHash 불변)과 determinism 하네스가 게이트. 의미가 바뀐다면 `MATERIALIZER_VERSION` bump가 필요하고, 그 판단은 **구현자가 단독으로 하지 않는다** |
| R2 | 증분 reduce의 dirty 확장 누락 → 웜 경로와 콜드 경로가 다른 트리 | C22 + `AVCS_VERIFY_INCREMENTAL=1` CI 잡 |
| R3 | 유사도 임계값 50%가 실사용에서 과·소검출 | 임계값을 상수 한 곳에 격리하고 C17/C19로 경계를 고정. 실측 후 조정 |
| R4 | Stage 0의 다대다 greedy 매칭이 큰 재배치(수십 파일 동시 이동)에서 O(n²) | 후보를 크기·확장자로 사전 필터. git 힌트가 있으면 후보가 1:1로 좁혀짐 |
| R5 | `rename_file` ∥ `delete_file`의 현행 의미가 무엇인지 문서화되어 있지 않다 | 구현 전에 현행 동작을 테스트로 **먼저 고정**하고, 이 설계는 그것을 바꾸지 않는다 |
| Q1 | Stage 1에서 `keysOf(rename_file)`이 계속 경로 두 개를 돌려줄지 | 경로 점유 충돌 탐지(C14)가 그 키에 의존하므로 **유지**한다. Stage 2에서 `file:<fid>` + `path:<경로>` 2종으로 분리 검토 |
| Q2 | Stage 0을 코어 `commitWorkingTree`에 둘지, 브리지 전용으로 둘지 | 코어에 둔다 — `import`/MCP 캡처 경로도 같은 이득을 받아야 한다. git 힌트만 브리지 한정 |

## 7. 이 설계가 지우는 것 / 남기는 것

**지운다:** rename × edit의 순서 우연 의존(절반이 틀린 트리) · 이동을 삭제+생성으로 기록해
생기는 거짓 충돌 · 경로 재배치가 병렬 작업을 막는 구조적 이유.

**남긴다(의도적으로):** 같은 라인 구간을 진짜로 동시에 고친 L2 충돌 · 동시 다목적지 rename의
사람 결정 · 동시 `put_file`(base 없음)의 정책 결정 · rename을 넘는 blame(Stage 2까지 보류).

→ 관련: [00 — 개요](00-overview.md) 원칙 2 · [15 — 언어 중립 코어](15-language-neutral-core.md) §11 ·
[14 — Git 브릿지](14-git-bridge.md) (캡처 경로)
