# 14 — Git 브릿지 (현실 호환)

AVCS는 의도적으로 Git-비호환이지만, **현실의 개발자는 결국 `git add` → `git commit` → `git push`** 한다. 이 문서는 AVCS로 개발하고 그 **최종 투영(projection)** 을 git에 올리는 다리(bridge)를 설명한다.

핵심 통찰: AVCS에서 코드 트리는 저장되는 것이 아니라 operation DAG를 `reduce()`해서 만든 **파생물**이다. 따라서 git이 추적할 "실제 코드"는 AVCS가 언제든 결정론적으로 재생성할 수 있다. git은 깨끗한 projection을, AVCS(`.avcs/`)는 풍부한 의도·결정 히스토리를 담당한다.

## 두 가지 모드

도입 장벽이 전혀 다른 두 현실을 모두 지원한다. 모드는 `.avcs/config.json`의 `gitMode`에 저장되고, `.avcs/.gitignore` 내용으로 강제된다.

| | **sidecar** (기본) | **committed** |
|---|---|---|
| 도입 결정 | 개발자 1명, 결재 불필요 | 팀 합의 필요 |
| git이 보는 것 | 깨끗한 projection **만** | projection + `.avcs/objects`·`refs` |
| `.avcs/` | 전부 git-ignore (`*`) | objects·refs·HEAD·config 추적, 캐시만 ignore |
| 히스토리 공유 | 로컬 / hub(Phase 7) | `git push`로 동행 |

```bash
avcs init .                    # sidecar (기본)
avcs init . --mode committed   # committed
avcs git-mode                  # 현재 모드 표시
avcs git-mode committed        # 전환 (.gitignore/.gitattributes 재작성)
```

- **sidecar**: `.avcs/.gitignore`가 `*` 한 줄이라 `.avcs/`는 git에 아무것도 기여하지 않는다. 팀의 git 히스토리는 완전히 그대로다.
- **committed**: 캐시(`indexes/`, `snapshot/`, `oplog`, `objlog`, locks, packs)와 로컬 상태(`.git-pending`)만 무시하고 객체/refs는 추적한다. `objects/`는 불변·content-addressed라 파일명이 겹치지 않아 git이 union으로 안전하게 머지한다(`.avcs/.gitattributes`가 diff/merge 경로에서 제외).

## 워크플로우

### 자동 (권장) — git 훅

`avcs init`은 git 레포 안이면 훅 5종을 자동 설치한다(`--no-hooks`로 생략, 나중에 `avcs install-hooks`). 그러면 **평소처럼 git만 써도** AVCS가 따라온다:

```bash
# 파일 편집 (사람이든 에이전트든)
git add -A
git commit -m "feat: ..."   # 훅이 알아서:
                            #  pre-commit       : 편집을 op으로 캡처 → 충돌 게이트 → checkpoint → 재투영 → re-stage
                            #  prepare-commit-msg: AVCS-Checkpoint/TreeHash/Intent 트레일러 주입
                            #  post-commit      : git SHA ↔ checkpoint back-link 기록
git push

git pull                    # post-merge: reindex(op-log 재구축) + 재투영 → 결정론적 수렴

git worktree add ../feat -b feat   # post-checkout: 새 working tree를 메인 스토어에 attach
```

- 열린(needs-human) 충돌이 있으면 pre-commit이 커밋을 **중단**한다. `avcs conflicts`로 해결 후 다시 커밋.
- `git commit --no-verify`는 훅을 건너뛴다(그 경우 AVCS 캡처가 누락됨 — 피할 것).

### 수동 — 포slin 명령

훅 없이 명시적으로:

```bash
avcs git-sync -m "feat: ..."            # 캡처 → 게이트 → checkpoint → 재투영 → git add (커밋 직전까지)
avcs git-sync -m "feat: ..." --commit   # 위 + 트레일러 달아 git commit + back-link 기록
git push
```

## Provenance (왜 이 git 커밋을 믿는가)

양방향 링크로 "이 git 커밋의 코드가 정말 그 AVCS 상태의 투영인가"를 검증한다.

- **git → avcs**: 커밋 메시지 트레일러
  ```
  AVCS-Checkpoint: checkpoint_…
  AVCS-TreeHash:   …
  AVCS-Intent:     intent_…
  ```
  (`config.json`의 `trailer: false`로 끌 수 있음. AVCS 모르는 팀원에겐 무해한 주석.)
- **avcs → git**: `git:<sha>` ref가 checkpoint를 가리킴 (post-commit / `--commit`이 기록).

```bash
avcs verify-git              # HEAD가 링크된 checkpoint의 충실한 투영인지 검사
avcs verify-git <commit>     # 특정 커밋 검사
```

`verify-git`은 checkpoint를 재투영한 내용과 git 트리의 내용을 **파일 단위로 비교**한다(committed 모드에선 `.avcs/` 경로 제외). 한 글자라도 다르면 실패한다.

## 협업 (committed 모드)

협업자는 `.avcs/objects`를 git으로 주고받는다. git merge는 op 그래프의 **union**(거의 무충돌)이고, 진짜 merge는 AVCS `reduce()`다.

- `git pull` 후 객체 파일은 디스크에 도착하지만, **git-ignore된 op-log는 갱신되지 않는다**. `materialize`는 op 집합을 op-log에서 읽으므로, 그대로 두면 새 op을 놓친다. 그래서 `post-merge` 훅이 `avcs reindex`로 op-log를 재구축한 뒤 재투영한다. clone 직후엔 `avcs reindex && avcs checkout`.
- 두 replica가 같은 객체 집합을 가지면 같은 `treeHash`로 수렴한다(결정론).
- **refs 충돌**: 가변 ref(view/checkpoint head)는 git에서 텍스트 충돌할 수 있다. 현재는 수동 해결(union/latest 선택) 후 `avcs reindex`. 전용 merge driver는 후속 과제.

## Linked working tree (git worktree)

git worktree로 만든 **linked working tree**는 `.git`이 디렉터리가 아니라 `gitdir: <경로>` 한 줄을 담은 **파일**이다. AVCS도 같은 방식을 쓴다: linked tree의 `.avcs`는 `avcsdir: <경로>` 한 줄을 담은 **포인터 파일**이고, 실제 스토어는 메인 체크아웃에 하나만 있다.

왜 필요한가: sidecar 모드에서 `.avcs/`는 git이 추적하지 않으므로 **git이 새 working tree로 스토어를 배달해 주지 않는다**. 그리고 AVCS의 루트 탐색은 git처럼 위로 올라가는데, linked tree는 보통 메인 체크아웃의 하위 경로가 아니라 위로 올라가도 스토어를 못 만난다. 포인터가 그 간극을 메운다.

```bash
cd <linked-working-tree>
avcs worktree attach            # 메인 체크아웃을 git으로 찾아 포인터를 쓴다
avcs worktree attach --to <dir> # git이 없거나 다른 스토어를 가리키고 싶을 때
avcs worktree status            # attached → <store> / own store: <path>
avcs worktree detach            # 포인터 제거 (실제 스토어는 절대 지우지 않는다)
```

훅이 설치돼 있으면 **수동 단계는 필요 없다**. `git worktree add`가 새 tree 안에서 `post-checkout`을 실행하고, 그 자리에서 포인터가 생긴다. 평범한 브랜치 전환은 아무것도 바꾸지 않는다.

### 하나의 스토어, working tree마다 다른 line

`lineFor`는 현재 git 브랜치를 AVCS line으로 매핑한다(`main`/`master`는 기본 line). working tree마다 브랜치가 다르므로 **스토어는 공유하되 line은 분리**된다 — git의 "하나의 object store + 여러 worktree"와 동형이다.

투영 위치는 헷갈리지 않는다: 포인터를 따라가도 **repo root는 그 working tree 자신**이고 스토어만 메인에 있다. `materialize`/`checkout`은 해당 tree에 쓰고, 워킹트리 캡처도 그 tree를 읽는다.

### 안전장치

- `avcs init`은 메인 체크아웃에 이미 스토어가 있는 linked tree에서 **멈추고** `avcs worktree attach`를 안내한다. 분기된 스토어는 서로를 영원히 모르는 두 히스토리가 되므로, 기본 경로에서는 만들 수 없게 했다. 의도적 분리는 `avcs init --force`.
- `avcs worktree attach`는 이미 진짜 스토어가 있는 디렉터리를 덮지 않고, `detach`는 진짜 스토어를 지우지 않는다.
- 포인터는 레포 공용 `info/exclude`에 등록되므로 git status가 더럽혀지지 않는다(`.avcs/.gitignore`는 스토어 *안*에 있어서 포인터에는 적용되지 않는다).
- **committed 모드에서는 attach를 거부한다.** 그 모드에서는 git이 이미 `.avcs`를 모든 working tree로 배달하므로 포인터가 git과 자리를 다툰다.

## 한계 (MVP)

- 훅은 **전체 워킹트리 커밋**을 가정한다(`git commit <부분파일>`은 미지원). `--no-verify`는 캡처를 건너뛴다.
- committed 모드의 refs 텍스트 충돌은 수동 해결.
- sidecar 모드의 히스토리는 git으로 이동하지 않는다(로컬/hub 전용) — 팀 도입 시 `avcs git-mode committed`.
- **committed 모드 + linked working tree는 아직 지원하지 않는다.** git이 working tree마다 `.avcs` 사본을 배달하므로 스토어가 tree 수만큼 갈라진다. 그래서 그 조합에서는 attach가 거부된다.

## 관련 명령 요약

| 명령 | 역할 |
|---|---|
| `avcs init [--mode m] [--no-hooks]` | 레포 생성 + 모드 + 훅 설치 |
| `avcs git-mode [sidecar\|committed]` | 모드 표시/전환 |
| `avcs git-sync -m <msg> [--commit]` | 수동 동기화 (커밋 직전까지 / 커밋까지) |
| `avcs verify-git [<commit>]` | git 커밋 ↔ checkpoint provenance 검증 |
| `avcs install-hooks [--force]` | 훅 5종 설치 |
| `avcs reindex` | entity index + op-log 재구축 (git pull 후 복구) |
| `avcs worktree attach [--to <dir>]` | linked working tree를 메인 체크아웃의 스토어에 연결 |
| `avcs worktree detach \| status` | 포인터 제거 / 스토어 위치 확인 |
