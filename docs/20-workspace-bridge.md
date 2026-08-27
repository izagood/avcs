# 20 — Workspace-first git 브리지: 토픽 브랜치를 발산이 아니라 수렴으로

> **상태: 구현됨** (#75·#78). §5의 W1~W15가 `test/workspace-bridge.test.ts` ·
> `test/workspace-landed-visibility.test.ts`에서 회귀 테스트로 고정돼 있고, 구현이 이 문서와
> 다른 곳은 §3.2·§3.3·§4 각 절에 표시했다. 이 문서는 git 브리지가 토픽 브랜치를 **line**(영구 발산)으로
> 매핑하는 오류를 교정한다. [16 — Workspace 스코프](16-workspace-scope.md) §4.1이 정의한
> 대로 단명 수렴 작업은 **workspace**가 맡아야 한다. 이 교정이 없으면
> [17 — 수렴](17-sync-convergence.md)의 통합 큐가 실사용 경로에서 **작동할 대상 자체가
> 없다** — 아무것도 avcs 안에서 수렴하지 않기 때문이다.

## 1. 배경 — 무엇이 잘못 배선돼 있나

### 1.1 브랜치 → line 매핑

`src/cli.ts`:

```ts
function lineFor(dir: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const branch = gitCmd(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD" || branch === "main" || branch === "master") return undefined;
  return branch;   // ← 모든 토픽 브랜치가 line이 된다
}
```

그런데 [16](16-workspace-scope.md) §4.1은 두 스코프를 정반대 용도로 정의한다:

| | **line** | **workspace** |
|---|---|---|
| 목적 | **발산** — `v1.x`를 영구히 따로 유지 | **수렴** — 작업 → 검증 → base에 land |
| 수명 | 장기/영구 | 단명 (land 또는 폐기) |
| 같은 파일 다른 내용 | 영구 공존이 정상 | land 시 merge로 해소 |
| 누가 만드나 | 사람이 명시적으로(릴리스 분기) | 작업 시작 시 경량 생성 |

토픽 브랜치는 **수렴할 작업**이다. 그것을 영구 발산 스코프에 넣은 결과:

- `materialize`는 line에 대해 "자기 line의 op ∪ fork checkpoint 인과폐포"만 환원한다
  (`#inheritedOps`). 즉 **N개 토픽 브랜치 = 서로를 영원히 못 보는 N개 히스토리.**
- `landWorkspace()`는 구현돼 있으나 git 경로에 **호출자가 없다.**
- 실측: 병렬 에이전트 프로젝트에서 line 12개가 쌓이고 integration 객체는 **0개**. 모든 수렴이
  avcs 밖(git 머지)에서 일어났다.

### 1.2 곁딸린 결함 두 개

- **trunk 개념 부재.** `lineFor`는 `main`/`master`만 특수 처리한다. trunk 이름이 다른 저장소
  (예 `dev`)는 trunk 자체가 line이 되어 버린다.
- **`avcs workspace project`가 view를 `"main"`으로 하드코딩** (`src/cli.ts`). trunk 이름이
  다르면 이 명령을 쓸 수 없다.

### 1.3 발견된 잠재 버그 — landed workspace가 workspace view에서 안 보인다

`Repo.materialize` (src/api/repo.ts):

```ts
const landed = wsName ? null : await this.#landedWorkspaces();   // workspace view면 조회조차 안 함
...
if (wsName ? (!!opWs && opWs !== wsName) : (!!opWs && !landed!.has(opWs))) continue;
```

workspace view(`wsName = W`)는 **다른 workspace의 op을 landed 여부와 무관하게 배제**한다.
그런데 [16](16-workspace-scope.md) §4.2는 workspace view를 `base accepted + 내 op`으로,
§4.3은 land를 "base line이 그 op들을 **accept**하는 것"으로 정의한다. land된 op은 base
accepted이므로 **보여야 한다.**

결과: workspace A가 land한 뒤에도 workspace B는 그 변경을 보지 못한다 — B는 이미 trunk에
들어간 작업을 모른 채 계속 작업하고, land 시점에야 충돌을 만난다. **이것이 바로 이 트랙이
없애려는 "뒤늦은 충돌 발견"의 workspace판 재연이다.**

현재 workspace 사용률이 0이라 드러나지 않은 잠재 버그였다. 수정(적용됨, W5가 고정한다):

```ts
const landed = await this.#landedWorkspaces();                  // 항상 조회
...
if (opWs && opWs !== wsName && !landed.has(opWs)) continue;      // landed는 언제나 통과
```

`wsName`이 undefined일 때 의미는 종전과 동일(자기 workspace가 없으므로 `opWs !== undefined`인
미land op만 배제)이므로 **base view의 동작은 불변**이다.

## 2. 원칙 (제약)

1. **reducer 불변.** 이 트랙은 배선만 바꾼다. workspace 격리·land·3-way 머지 기계는 이미
   있다(§1.3의 필터 한 줄 수정 제외).
2. **하위 호환.** 기존 line 12개는 append-only이므로 **그대로 둔다.** 마이그레이션 없음.
   신규 브랜치부터 workspace 매핑을 적용한다. 기존 store의 treeHash 불변.
3. **git은 브리지일 뿐.** trunk 판정에 git을 쓰되, 코어는 git 없이도 완전해야 한다
   (trunk는 `.avcs/config.json`에 저장되고 git은 현재 브랜치만 알려준다).
4. **line은 본래 의미로 복귀.** 릴리스 분기(`v1.x`)는 계속 line이다. 사람이 `--line`으로
   명시하거나 `avcs lines`로 만들 때만 생긴다.

## 3. 설계

### 3.1 trunk 설정

`.avcs/config.json`에 필드 추가(옵셔널 → 하위호환):

```jsonc
{ "gitMode": "sidecar", "trunk": "dev" }
```

- 기본값: `main`, 없으면 `master`. 즉 미설정 저장소의 동작은 종전과 같다.
- `avcs trunk [<branch>]` — 표시/설정. `avcs init`이 git 저장소 안이면 현재 기본 브랜치를
  감지해 기록한다.

### 3.2 `workspaceFor()` — 브랜치 → 스코프 판정

`lineFor`를 대체하는 것이 아니라 **옆에 둔다** (명시적 line 사용은 계속 유효):

```ts
/** git 브랜치를 avcs 스코프로 매핑한다.
 *  trunk 브랜치      → { }                        (base view, 태그 없음)
 *  그 외 토픽 브랜치  → { workspace: <branch> }     (수렴 스코프)
 *  --line 명시       → { line: <name> }            (발산 스코프, 사람이 의도한 경우만)
 */
function scopeFor(dir: string, explicitLine?: string): { line?: string; workspace?: string }
```

- trunk 판정: `config.trunk` ?? (`main` 있으면 `main`) ?? `master`.
- detached HEAD: 스코프 없음(base view) — 종전 `lineFor`의 `"HEAD"` 처리와 동형.
- **기존 line과의 충돌 회피:** 브랜치 이름과 같은 `line:<name>` ref가 **이미 존재하면**
  그 브랜치는 계속 line으로 취급한다. 이렇게 하면 진행 중인 기존 브랜치들이 매핑 변경으로
  히스토리를 잃지 않는다(원칙 2). 신규 브랜치만 workspace가 된다.

> **구현 노트:** 이 검사는 trunk 판정보다 **앞**에 있다. `trunk`가 없던 시절 main/master가
> 아닌 trunk는 그 자체가 line이 되어 있었고 축적된 작업이 그 line의 view에 있으므로, 새
> 캡처를 기본 view로 보내면 같은 브랜치의 히스토리가 둘로 쪼개진다. 그리고 판정은 순수 함수
> `src/git/scope.ts`(`scopeForBranch`)에 있다 — `src/cli.ts`는 import 시 `main()`이 실행돼
> 테스트에서 import할 수 없고, 되돌릴 수 없는 연산의 판정은 git 상태를 조작하지 않고 검증할
> 수 있어야 한다. `lineFor`는 호출자가 남지 않아 제거했다.

### 3.3 캡처 경로에 workspace 배선

현재 시그니처(workspace 인자 없음):

```ts
async commitWorkingTree(workDir, opts: { message; actor; line?; ignorePredicate? })
async gitSync(opts: { message; actor; line?; workDir?; ignorePredicate? })
```

`workspace?: string`을 추가하고 `proposeFileWrite`/`proposeEdit`/`proposeOperation`의 기존
`workspace` 인자로 흘린다(그 인자는 **이미 있다**). `commitWorkingTree` 내부의
`materialize(view)` 호출도 `materialize(view, { workspace })`가 되어야 한다 — 아니면 base
투영과 diff해서 자기 workspace의 이전 변경을 매번 "새 변경"으로 재캡처한다.

`checkoutInto(workDir, view, { workspace })`는 이미 workspace를 받는다. `gitSync`의 재투영
단계가 그것을 넘기도록만 고친다.

> **구현이 이 절에 더한 것:** `gitSync`가 찍는 checkpoint도 workspace 스코프여야 한다. 종전
> 매핑에서는 토픽 브랜치의 view가 곧 line이라 checkpoint와 트레일러 treeHash가 일치했는데,
> workspace로 옮기면서 checkpoint를 base view로 두면 트레일러가 git이 들고 있지 않은 트리를
> 가리켜 `avcs verify-git`이 토픽 브랜치 커밋 전부를 불일치로 보고한다 — 회귀다. 그래서
> `Checkpoint.workspace`(옵셔널이므로 base view checkpoint의 바이트는 불변)에 스코프를 싣고,
> `finalize`는 그런 checkpoint를 거부한다: land되지 않은 op을 담은 트리로 보호된 head를
> 전진시키는 것은 미완성 작업을 verified head 아래로 공개하는 일이다.

### 3.4 land 접합 — "git 머지"가 "avcs land"가 되는 지점

이것이 이 트랙의 목적이다. 현재 `post-merge` 훅은 `reindex` + 재투영만 한다 —
avcs가 git 머지를 **사후 기록**한다. 뒤집는다:

| 시점 | 지금 | 변경 후 |
|---|---|---|
| 토픽 브랜치에서 `git commit` | op 캡처 (line 태그) | op 캡처 (**workspace 태그**) |
| trunk에서 `git merge` / `git pull` | `reindex` + 재투영 | **`landWorkspace(<병합된 브랜치>)`** + 재투영 |
| trunk head 전진 | git이 진실 | (최종형) 통합 게이트가 진실 — [17](17-sync-convergence.md) |

**병합된 브랜치 이름을 어떻게 아는가:** `post-merge` 훅은 인자로 받지 못한다. 브리지 레이어에서
`git reflog -1`(`merge <branch>` 형태) 또는 `MERGE_HEAD`가 남긴 커밋의 소속 브랜치로 판정한다.
판정 실패 시 **아무것도 land하지 않고** 경고만 남긴다 — 틀린 workspace를 land하는 것이
land하지 않는 것보다 나쁘다(land는 되돌릴 수 없다; `landWorkspace`는 멱등 추가 전용).

`avcs land <workspace>` 수동 명령도 제공해, 판정 실패나 훅 미설치 환경에서 사람이 확정할 수 있게 한다.

### 3.5 통합 게이트와의 관계 (경계 명시)

이 문서는 **workspace를 base view에 합류시키는 것**까지만 다룬다. 그 합류가 보호된 head를
전진시킬 자격이 있는지(승인·required checks·evidence)는 [17](17-sync-convergence.md)의
`submitIntegration`이 판정한다. 두 단계는 [16](16-workspace-scope.md) §5.2의 두 게이트와 대응한다:

- **workspace land 게이트** — 내 op이 정합하고 base와 conflict-free (이 문서)
- **release/통합 게이트** — 통합 treeHash가 독립 evidence로 검증됨 ([17](17-sync-convergence.md))

## 4. 변경 지점

| 파일 | 변경 |
|---|---|
| `src/api/repo.ts` — `materialize` | §1.3 필터 수정 (landed를 항상 조회) |
| `src/api/repo.ts` — `commitWorkingTree` | `workspace?` 인자 + 내부 `materialize(view, {workspace})` + propose에 전달 |
| `src/api/repo.ts` — `gitSync` | `workspace?` 인자 + 재투영 `checkoutInto(..., {workspace})` |
| `src/api/repo.ts` — config 접근자 | `getTrunk()` / `setTrunk()` |
| `src/cli.ts` — `scopeFor` 신설 | §3.2 판정. `lineFor`는 `--line` 명시 경로용으로 유지 |
| `src/cli.ts` — `git-sync` / 훅 케이스 | `scopeFor` 사용, workspace 전달 |
| `src/cli.ts` — `post-merge` 훅 | §3.4 land 접합 + 병합 브랜치 판정 |
| `src/cli.ts` — `workspace project` | view 하드코딩 제거 → **trunk 브랜치를 `scopeForBranch`로 해소한 view**(구현 정정: 새 매핑에서 trunk의 작업은 태그 없는 base view로 가므로 trunk *이름*을 view 이름으로 쓰는 것은 레거시(trunk가 line인) 저장소에서만 옳다). `--view`로 재정의 가능 |
| `src/cli.ts` — `conflicts` | 현재 스코프를 본다(구현 추가). base view를 보면 토픽 브랜치에서 "no open conflicts"라 답하면서 `git-sync`는 그 트리를 스테이징하지 않겠다고 한다 |
| `src/cli.ts` — `workspace list` | landed 만이 아니라 전부를 `landed`/`in flight` 로 표시(구현 추가). 미land 가 살아있는 작업의 정상 상태가 됐다 |
| `src/cli.ts` — `trunk` 명령 | 신설 |
| `src/cli.ts` — `land` 명령 | `<workspace>` 인자 형태 추가 (기존 통합 `land`와 이름 충돌 검토 — Q1) |
| `docs/14-git-bridge.md` | workspace 매핑·trunk·land 접합 문서화. "하나의 스토어, working tree마다 다른 line" 절을 workspace 기준으로 개정 |
| `docs/16-workspace-scope.md` | §1.3 버그 수정 반영, §10 미해결 질문 갱신 |

## 5. 검증 매트릭스

| # | 케이스 | 기대 |
|---|---|---|
| W1 | trunk 브랜치에서 캡처 | op에 `workspace` 태그 없음, base view에 즉시 보임 |
| W2 | 토픽 브랜치에서 캡처 | op에 `workspace = <브랜치>` 태그, **base view에서 안 보임** |
| W3 | 같은 파일을 두 토픽 workspace가 편집 | 각 workspace view에는 자기 것만. 서로 오염 없음 |
| W4 | workspace A land 후 base view | A의 op이 base에 합류, trunk op과 3-way 머지 |
| W5 | **workspace A land 후 workspace B의 view** | **A의 op이 보인다** (§1.3 버그 회귀 테스트) |
| W6 | 미land workspace 폐기 | base view 불변. op은 store에 남음(감사) |
| W7 | trunk 미설정 저장소 | `main` 기준으로 종전과 동일하게 동작 (하위호환) |
| W8 | `trunk = "dev"` 설정 | `dev`가 base, `main` 브랜치는 그냥 토픽 workspace 취급 |
| W9 | 이미 `line:<브랜치>` ref가 있는 브랜치에서 캡처 | 계속 line으로 취급 (§3.2 충돌 회피, 기존 작업 보호) |
| W10 | `post-merge`가 병합 브랜치를 판정 | 그 workspace가 land됨 |
| W11 | `post-merge`가 병합 브랜치 판정 **실패** | **아무것도 land되지 않음** + 경고. `avcs land <ws>`로 수동 확정 가능 |
| W12 | `landWorkspace` 두 번 호출 | 멱등, ref 불변 |
| W13 | `workspace project`가 trunk view를 씀 | `trunk = "dev"`에서 dev 내용이 투영됨 |
| W14 | 캡처 시 자기 workspace의 이전 변경 | 재캡처되지 않음 (§3.3의 `materialize(view, {workspace})`) |
| W15 | 기존 line 히스토리 | treeHash 불변 (하위호환 회귀) |

## 6. 리스크 / 미결정

| # | 항목 | 처리 |
|---|---|---|
| R1 | **land는 되돌릴 수 없다** (`landWorkspace`는 추가 전용). 잘못 land하면 남의 미완성 op이 base에 들어간다 | §3.4의 "판정 실패 시 land 안 함" 규칙. `unlandWorkspace`는 이 트랙 범위 밖 — 필요성이 실측되면 별도 설계 |
| R2 | `post-merge`의 병합 브랜치 판정이 squash merge에서 어려울 수 있다 (GitHub squash는 머지 커밋을 남기지 않음) | squash 워크플로에서는 훅 자동 판정이 불가능할 수 있음을 문서화하고 `avcs land <ws>` 수동 경로를 1급으로 안내. CI가 land를 수행하는 것이 최종형([17](17-sync-convergence.md)) |
| R3 | `workspaces.landed`가 **line별이 아니라 전역** 집합이다. 여러 line이 같은 workspace 이름을 쓰면 의미가 뒤섞인다 | 현재 실사용에 다중 line + workspace 조합이 없다. 스펙에 제약으로 명시하고, 필요해지면 ref를 line별로 분리 |
| R4 | 기존 12개 line이 영구 잔존 → `avcs lines` 출력이 지저분해진다 | 정보 손실 없음(원칙 2). line에 `status: archived` 표시는 후속 |
| Q1 | `avcs land`가 이미 통합 제출(`integrateHub`) 명령이다. workspace land와 이름이 충돌 | `avcs workspace land <ws>`(이미 존재)를 정본으로 쓰고 통합 쪽 `land`는 그대로 둔다. §4의 신규 `land` 항목은 이 결정으로 취소 |
| Q2 | trunk 자동 감지를 `git symbolic-ref refs/remotes/origin/HEAD`로 할지, `main`/`master` 존재 확인으로 할지 | 후자(네트워크·remote 의존 없음)를 기본으로, 전자는 실패 시 폴백 |

## 7. 이 설계가 지우는 것 / 남기는 것

**지운다:** 토픽 브랜치가 서로를 못 보는 구조 · `landWorkspace`의 호출자 부재 ·
land된 작업이 다른 workspace에 안 보이는 버그 · trunk 이름이 `main`이 아닌 저장소의
`workspace project` 사용 불가.

**남긴다(의도적으로):** 릴리스 분기의 line 의미 · 기존 12개 line(감사 보존) ·
통합 게이트 판정([17](17-sync-convergence.md) 소관) · 물리 격리의 `node_modules` 문제
([16](16-workspace-scope.md) §7 shared-paths, 별도 트랙).

→ 관련: [16 — Workspace 스코프](16-workspace-scope.md) · [17 — 수렴](17-sync-convergence.md) ·
[14 — Git 브릿지](14-git-bridge.md) · [19 — 파일 정체성](19-entity-identity.md) (Stage 0이 같은 캡처 경로를 만진다)
