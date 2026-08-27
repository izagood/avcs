# 22 — 영역별 정책 중재: 겹친 헝크의 승자를 정책이 고른다

> **상태: 설계 (구현 전).** [15 — 언어 중립 코어](15-language-neutral-core.md) §10.4가
> **H1 — "가장 실질적인 헛점"** 으로 기록한 항목의 명세다. 그 문서의 결론은 정직했다:
> 언어 중립 전환으로 머지 품질은 git과 동급이 되었고, avcs의 우위는 **원장·정책·evidence·lease
> 제어 평면**에서 온다(§7). 그런데 겹친 영역의 해소만은 그 제어 평면을 타지 않는다 —
> 정책이 아니라 **순서**가 이긴다. 이 문서가 그것을 고친다.

## 1. 문제

### 1.1 무엇이 결정을 내리고 있나

`src/reducer/reducer.ts`의 `applyOp`은 동시 `edit_file`을 합성할 때 이렇게 호출한다:

```ts
const m = merge3(opBase, [current, opNew], { onConflict: "first" });
```

`merge3`의 `onConflict` 의미(`src/merge/merge3.ts`):

```
"first" — the lowest-side-index option (e.g. the accumulated "ours" content …)
```

side 인덱스는 canonical 순서(`lamport, oid`)에서 파생되므로, **겹친 영역의 트리 내용은
"먼저 적용된 op"이 차지한다.** 사실상 first-write-wins다.

### 1.2 왜 이것이 원칙 위반인가

[00 — 개요](00-overview.md)의 여섯 번째 운영 원칙:

> **코드에 last-write-wins를 기본값으로 쓰지 않는다.** 마지막에 쓴 사람이 맞는 게 아니라, 정책이
> 정한 우선순위에서 이긴 변경이 맞다. recency는 최후의 tie-break일 뿐이다.

현재 구현은 방향만 뒤집힌 같은 죄다 — first-write-wins. 그리고 [15](15-language-neutral-core.md)
§10.4의 H1이 이를 정확히 기록했다:

> 겹친 영역의 트리 내용은 결정론적으로 "먼저 적용된 op"이 차지하고, 정책(trust/evidence/owner)이
> **영역 단위로 승자를 고르지 않는다**(needs_human 플래그만). 구설계는 op 단위로 정책이 승자를
> 골랐음 — 이 표현력의 회귀.

즉 이것은 언어 중립화가 의도한 결과가 아니라 **표현력 회귀**다. 심볼 머지 시절에는 정책이
op 단위로 승자를 골랐는데, 머지 단위가 헝크로 내려가면서 정책이 그 단위를 따라 내려가지 못했다.

### 1.3 실질적 귀결

- 검증된(evidence 붙은) 변경이 **미검증 변경에게 영역을 빼앗길 수 있다.** 트러스트 사다리
  (`actorTrustScore`)·신뢰도 학습(`reliability`)·code-owner(`requiredOwners`)가 그 영역에서
  아무 힘이 없다.
- `evaluateOp`이 계산하는 점수(trust + reliability×30 + evidence ±200 + owner 150 + effect
  weight …)는 op **차단/승격**에는 쓰이지만 **영역 승자 선택에는 쓰이지 않는다.**
- 완화책으로 남은 것은 release 게이트뿐이다: 충돌이 있으면 배포가 막힌다. 그러나 그것은
  "잘못된 내용이 트리에 들어가는 것"을 막지 못한다 — 배포만 막는다.

## 2. 이 설계가 밟고 서 있는 사실 (이미 존재하는 부품)

고칠 거리가 짧다. 필요한 재료가 **이미 다 있다**:

| 부품 | 위치 | 무엇을 주나 |
|---|---|---|
| `ConflictRegion.options[].sides` | `src/merge/merge3.ts` | 각 옵션을 만든 **변형 인덱스 목록**. 합의(같은 텍스트)는 하나로 접힌다 |
| 변형 순서 = canonical 순서 | `applyOp`/`detectFileConflicts` 호출부 | side 인덱스 → **op 복원 가능** |
| `evaluateOp(policy, op, …) → { score, … }` | `src/reducer/policy.ts` | op별 정책 점수 (trust·reliability·evidence·owner·effect) |
| `AutoDecision` 기록 경로 | reducer | 정책 자동 결정을 감사 가능하게 남기는 기존 자리 |

즉 **side → op → score** 사슬이 이미 연결 가능하다. 빠진 것은 `merge3`이 그 점수를 물어볼 방법뿐이다.

## 3. 설계

### 3.1 `merge3`에 중재자를 주입한다 (코어는 정책을 모른 채)

`merge3`는 텍스트 머저다. 정책을 알면 안 된다. 그래서 **점수를 계산하지 않고, 선택을 위임**한다:

```ts
export interface Merge3Options {
  onConflict?: "base" | "first";
  /**
   * 겹친 영역의 승자를 고른다. 반환값은 `region.options`의 인덱스, 또는 `null`(= 고르지 못함
   * → 기존 `onConflict` 동작으로 폴백하고 영역을 충돌로 남긴다).
   * merge3는 이 함수가 무엇을 근거로 고르는지 모른다 — 언어 무지처럼 정책 무지를 유지한다.
   */
  arbitrate?: (region: ConflictRegion) => number | null;
}
```

- `arbitrate`가 없으면 **동작이 지금과 완전히 동일**하다(하위 호환).
- 반환이 `null`이면 폴백 — "정책으로도 못 정한다"가 1급 결과다(L4로 남는다).

### 3.2 reducer가 중재자를 만든다

reducer는 op 집합과 정책을 안다. 그래서 side→op 매핑과 점수를 합쳐 중재자를 만든다:

```
arbitrate(region):
  candidates = for each option o in region.options:
      ops    = o.sides.map(side → opForSide[side])
      score  = max(evaluateOp(policy, op).score for op in ops)      # 합의는 최고점으로 대표
      blocked = any(op is blocked/needs_human by evaluateOp)
      → { optionIndex, score, blocked, repOp }
  live = candidates where not blocked
  if live is empty                  → null            # 전부 차단 → 사람
  best = max(live, by score)
  if 최고점이 유일하지 않다          → null            # 동점 → 사람 (recency로 깨지 않는다)
  return best.optionIndex
```

**설계 결정 세 가지, 근거와 함께:**

1. **합의 옵션은 최고점으로 대표한다.** 같은 텍스트를 낸 여러 op이 한 옵션으로 접히므로, 그 중
   가장 신뢰받는 op의 점수를 쓴다. 평균은 저신뢰 actor를 끼워 넣어 옵션을 깎는 데 악용될 수 있다.
2. **동점은 사람에게 간다 — recency로 깨지 않는다.** [00](00-overview.md) 원칙 6이 recency를
   "최후의 tie-break"로 허용하지만, 그것은 *op 승격* 문맥이다. 영역 내용은 의미가 갈리는
   지점이므로, 정책이 우열을 못 가리면 조용히 고르는 것보다 올리는 것이 맞다. (`onConflict`
   폴백이 트리에 결정론적 내용을 넣고, 영역은 충돌로 보고된다 — 데이터 손실 0.)
3. **차단된 op은 후보에서 빠진다.** evidence 없는 동작 변경(L3)이 영역을 차지하는 일은 없어야
   한다. 이것이 이 설계의 실질 효과다: **검증된 변경이 미검증 변경을 영역 단위로 이긴다.**

### 3.3 결정을 기록한다 (감사 없는 자동 결정 금지)

영역별 중재는 조용히 일어나면 안 된다. 각 중재를 `AutoDecision`으로 남긴다:

- `key`: `file:<path>` (기존 충돌 키)
- 영역 식별: `baseStart`/`baseEnd`
- 채택된 옵션의 대표 op oid, 탈락한 옵션들의 대표 op oid
- 점수 내역(어느 항목이 승부를 갈랐는지) — `evaluateOp`이 이미 계산하는 값이므로 추가 비용 0
- `reason`: `"region-arbitration"`

이로써 "왜 내 변경이 이 영역에서 졌는가"에 답할 수 있다. [00](00-overview.md) 원칙 4("Conflict는
깨진 파일이 아니라 1급 Decision 객체다")의 영역 단위 실현이다.

### 3.4 `detectFileConflicts`와의 관계

`detectFileConflicts`는 권위 있는 N-way 충돌 집합을 만든다. 중재로 **해소된** 영역은 충돌 목록에서
빠지고(정책이 결정했으므로), **`null`을 받은** 영역만 남는다. 즉 사람에게 올라가는 충돌이 줄고,
남은 것은 진짜로 정책이 못 정한 것들이다.

`Protection.requireBoundEvidence` 등 기존 게이트는 op 단위로 **선적용**되므로 이 설계가 건드리지
않는다(§3.2의 `blocked` 판정이 그 결과를 읽을 뿐이다).

## 4. 결정론과 마이그레이션 — 이 설계의 가장 무거운 부분

### 4.1 treeHash가 바뀐다

겹친 영역의 승자가 "순서"에서 "점수"로 바뀌므로, **겹침이 있는 히스토리의 treeHash가 바뀐다.**
이것은 회피할 수 없다 — 회피하면 이 설계가 아무것도 안 하는 것과 같다.

따라서 **`MATERIALIZER_VERSION` bump가 필수다.** 그 결과:

- 저장된 compaction snapshot이 헤더 스탬프 불일치로 자동 무효화된다(Phase 13.3이 이미 그렇게
  설계돼 있다 — [11](11-incremental-reduce.md) §13.3).
- 기존 checkpoint의 `treeHash`는 그 시점 materializer의 산물이므로 **그대로 유효**하다(불변 기록).
  새 환원이 다른 트리를 만드는 것은 정상이며, `docs/05`의 checkpoint 의미와 충돌하지 않는다.
- `verify-git`은 재투영과 git 트리를 비교하므로, bump 후 첫 재투영에서 차이가 날 수 있다 →
  릴리스 노트에 "겹침이 있던 파일은 재투영 시 내용이 바뀔 수 있다"를 명시해야 한다.

**겹침이 없는 히스토리는 treeHash가 불변이다** — 중재는 `ConflictRegion`이 생길 때만 호출되므로.
이것이 §5의 R1 회귀 테스트다.

### 4.2 결정론은 유지된다

중재의 입력은 (옵션 집합, side→op 매핑, 정책, `evaluateOp`) 전부이고 넷 다 결정론적이다.
동점은 `null`로 떨어져 결정론적 폴백을 타므로, **어느 replica에서도 같은 트리**가 나온다.
`evaluateOp`이 recency를 배제한다는 기존 성질이 여기서 결정적으로 중요하다.

### 4.3 정책 변경의 의미

정책이 바뀌면 같은 op 집합이 다른 트리를 만들 수 있다 — 이는 **이미 그렇다**(정책은 reduce의
입력이고 snapshot 헤더가 policy oid를 스탬프한다). 이 설계는 그 의존을 영역 단위로 확대한다.
정책 변경이 조용히 트리를 바꾸는 위험은 [07](07-roadmap.md) "알려진 한계 4"가 이미 기록한
것이며, 완화책(정책 버전·감사·`require_human`)도 그대로 적용된다.

## 5. 검증 매트릭스

| # | 케이스 | 기대 |
|---|---|---|
| **R1** | 겹침이 **없는** op 집합 | treeHash 불변 (bump 후에도) — 중재가 호출되지 않음 |
| **R2** | 겹친 영역, 한쪽만 evidence 있음 | **evidence 있는 쪽이 영역을 차지**. `AutoDecision` 기록됨 |
| **R3** | 겹친 영역, trust 등급이 다름 (human vs ai_agent) | 높은 trust 쪽 채택, 기록됨 |
| **R4** | 겹친 영역, code-owner가 한쪽 | owner 쪽 채택 |
| **R5** | 겹친 영역, **점수 동점** | `null` → 충돌로 남고 사람에게. 트리는 결정론적 폴백 내용 |
| **R6** | 겹친 영역, **양쪽 다 차단**(evidence 없는 동작 변경) | `null` → 충돌. 미검증 내용이 트리를 차지하지 않음 |
| **R7** | 합의 옵션(두 op이 같은 텍스트) | 최고점으로 대표되어 경쟁 |
| **R8** | `arbitrate` 미주입 | `merge3` 동작이 현재와 **완전히 동일** (하위호환) |
| **R9** | 결정론 — op 저작 순서를 뒤섞어 재환원 | 같은 treeHash |
| **R10** | 결정론 — replica 2개 | 같은 treeHash |
| **R11** | 증분 ≡ 전체 | `reduceIncremental` ≡ full reduce (겹침 포함). `AVCS_VERIFY_INCREMENTAL=1` |
| **R12** | 정책 변경 후 콜드 로드 | snapshot이 policy oid 불일치로 무효화되고 재환원 |
| **R13** | `AutoDecision` 내용 | 채택·탈락 op oid와 점수 내역이 조회 가능 (`recallDecisions`) |
| **R14** | 3-way 이상(N=3 겹침) | 최고점 유일하면 채택, 아니면 `null` |

determinism-property 하네스와 전체 계약 스위트가 green이어야 한다.

## 6. 리스크 / 미결정

| # | 항목 | 처리 |
|---|---|---|
| R-a | **`MATERIALIZER_VERSION` bump는 되돌릴 수 없는 결정론 경계 변경**이다 | 오너 결정 사항. 구현자가 단독으로 bump하지 않는다. 릴리스 노트에 재투영 영향 명시 |
| R-b | 정책이 영역 내용을 고르면 **"충돌은 없는데 버그"**(의미 깨짐)가 늘 수 있다 — 서로 다른 op의 조각이 한 파일에 섞인다 | [15](15-language-neutral-core.md) H2와 같은 종류의 위험이고 같은 방어선(evidence 게이트)을 쓴다. 이 설계는 그 위험을 **줄이는** 쪽이다(미검증 조각이 차단되므로). 다만 R2/R6 테스트로 경계를 고정한다 |
| R-c | 영역별 `evaluateOp` 호출이 핫패스 비용을 올린다 | 중재는 `ConflictRegion`이 있을 때만 호출되고, 충돌은 드물다. op별 점수는 그룹 결정에서 이미 계산되므로 **재사용**한다(재계산 금지) |
| R-d | `AutoDecision`이 겹침마다 쌓여 객체 수가 는다 | 충돌은 드물다. 다만 같은 영역이 재환원마다 새 결정을 만들지 않도록 **멱등 키**(key + baseStart/baseEnd + 채택 op)를 쓴다 |
| Q1 | 동점을 진짜로 사람에게 올릴지, `onConflict` 폴백 내용을 조용히 채택하고 경고만 할지 | §3.2-2대로 **사람에게 올린다**. 다만 폴백 내용이 트리에 들어가므로 "보류(hold)"가 아니라 "잠정 내용 + 열린 충돌"이다 — [15](15-language-neutral-core.md) §4.2의 현행 의미와 같다 |
| Q2 | H4(토큰/문자 단위 티어)와의 순서 | H4가 먼저 들어가면 겹침 자체가 줄어 이 설계의 호출 빈도가 낮아진다. 독립이므로 순서 제약은 없으나, **이 문서를 먼저** 한다 — H1이 "가장 실질적인 헛점"이고 H4는 옵트인 최적화다 |

## 7. 이 설계가 지우는 것 / 남기는 것

**지운다:** 겹친 영역의 first-write-wins · 검증된 변경이 미검증 변경에게 영역을 빼앗기는 일 ·
정책·trust·owner가 영역 단위에서 무력하다는 표현력 회귀([15](15-language-neutral-core.md) H1) ·
영역 결정이 감사에 남지 않는 것.

**남긴다(의도적으로):** 정책으로도 못 가리는 동점의 **사람 결정** · 텍스트가 깨끗한데 의미가
깨지는 위험([15](15-language-neutral-core.md) H2 — 본질적) · 라인 granularity(H4는 별건) ·
`merge3`의 정책 무지(중재는 주입될 뿐이다).

→ 관련: [00 — 개요](00-overview.md) 원칙 4·6 · [15 — 언어 중립 코어](15-language-neutral-core.md) §7·§10.4(H1) ·
[04 — 정책](04-policy.md) · [11 — 증분 reduce](11-incremental-reduce.md) §13.3
