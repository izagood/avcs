# 16 — Workspace 스코프: 격리 빌드/검증과 Evidence 모델

> **상태: 설계 합의 (구현 전).** 이 문서는 검증(validation)·격리 작업공간·외부 의존성에 대한 설계 결론을 기록한다. 도그푸딩 중 드러난 한계(#11, 격리 빌드의 외부 의존)에서 출발해, avcs의 단독성·병렬 전제와 정합하는 모델로 정리했다.

## 1. 배경 — 무엇이 문제였나

avcs는 **한 디렉토리에서 여러 에이전트가 병렬로 op를 작성**하는 것을 전제로 한다. 이 전제는 **op 그래프(논리)** 레이어에선 옳다. 하지만 컴파일/빌드가 필요한 프로젝트에서는 문제가 생긴다:

- **빌드는 일관된 파일 트리 하나를 요구한다.** 반쯤 머지된 여러 에이전트의 코드가 한 디렉토리에 섞이면 컴파일이 깨진다.
- 현실에선 이를 **git worktree**로 우회해 각자 격리된 working tree에서 빌드한다. 그러나 이는 **avcs 단독 버전관리 전제에 어긋난다** — 물리 격리를 git에 의존하게 된다.
- `validate_run`은 candidate를 임시 디렉토리에 materialize한 뒤 거기서 빌드/테스트를 **재현**하려 했다. 그러나 격리 복사본에는 `node_modules` 등 빌드 환경이 없어, `install` 같은 단계가 필요해진다 → **avcs 코어가 생태계별 빌드 방법·네트워크·툴체인에 의존**하게 된다(#11).

핵심 통찰: **avcs의 "한 디렉토리 병렬"은 op 레이어의 명제였고, 빌드/검증(물리 레이어)에는 격리된 작업 트리가 필요하다.** 이 격리를 git worktree에 맡기지 말고 avcs의 일급 개념으로 흡수해야 한다.

## 2. 원칙 (제약)

1. **단독성** — avcs는 git 없이 완전해야 한다. 물리 격리도 avcs가 제공한다. git은 브리지일 뿐.
2. **코어는 빌드를 모른다** — git이 빌드를 모르듯, avcs도 빌드 방법/환경을 떠안지 않는다. 경로 규칙만 다룬다.
3. **신뢰 = 서명** — evidence/decision의 신뢰는 서명에서 온다. **작성자는 자기 변경을 보증할 수 없다**(작성자 ≠ 신뢰 서명자).
4. **병렬이 기본** — op 그래프는 부분순서(causal DAG). reduce가 상시 전체를 합친다.

## 3. 두 레이어 모델

| 레이어 | 단위 | 병렬성 | 물리 형태 |
|---|---|---|---|
| **논리 (op 그래프)** | op propose / reduce | 진짜 병렬 (op는 논리적, 디스크에 안 섞임) | 단일 store `.avcs/` |
| **물리 (빌드/검증)** | 컴파일·테스트되는 파일 트리 | **격리 필요** | **workspace 단위 디렉토리 (복수)** |

git과 동형이다: **하나의 object store + 여러 worktree**. avcs는 **하나의 op-graph store + 여러 native workspace**.

## 4. Workspace 스코프 (새 일급 개념)

`workspace`는 git worktree의 avcs식 번역으로, **네 가지를 묶은 격리 단위**다.

| 요소 | 내용 |
|---|---|
| **base line** | 어디서 분기했나 (보통 `main`) |
| **격리 op-set** | 이 workspace에서 author된, 아직 base line에 land 안 된 op들 (쓰기 앵커) |
| **읽기 투영** | `base line의 accepted` + `이 workspace의 op` 를 합친 view |
| **물리 디렉토리** | 위 투영을 펼친 곳 + shared-paths |

### 4.1 line과의 차이 — 발산 vs 수렴

workspace는 별도 스코프여야 한다. line과 생명주기가 정반대이기 때문이다.

| | **line** (Phase 8) | **workspace** |
|---|---|---|
| 목적 | **발산** (`v1.x`를 영구히 따로 유지) | **수렴** (작업→검증→base에 land) |
| 수명 | 장기/영구 | 단명 (land 또는 폐기) |
| 같은 파일 다른 내용 | 영구 공존이 정상 | land 시 merge로 해소 |
| 누가 만드나 | 사람이 명시적으로 (릴리스 분기) | 작업 시작 시 경량 생성 |

→ **line은 "릴리스 분기"라는 본래 의미로 순수하게 남는다.** 단명 작업 격리는 workspace가 맡는다. (git 비유: line = 릴리스 브랜치, workspace = topic branch + 전용 worktree + 머지 게이트.)

### 4.2 op 모델 — 새 필드 `op.workspace`

op는 불변(content-addressed)이다. 격리는 **op에 새 필드 `workspace`**로 표현한다.

- op는 `base line` 소속 + `op.workspace` 태그를 단다.
- **materialize 필터:**
  - **base line view**: `op.workspace`가 달린 op는 **제외** → base(main)는 깨끗하게 유지된다.
  - **workspace view**: `base accepted` + `op.workspace == 나` → 에이전트가 보는 작업 트리.
- **land** = op를 바꾸는 게 아니라(불변), base line이 그 op들을 **accept**하는 것(게이트 통과 후 base view에 합류). 미land면 폐기(op는 남되 어디서도 투영되지 않음).

`session`/`intent`와는 직교한다: workspace=공간적 격리(어디서 빌드되나), session=시간적 추적, intent=의도.

### 4.3 생명주기

```
1. workspace create --from main     # 물리 디렉토리에 (main frontier + shared-paths) 투영
2. 에이전트가 그 디렉토리에서 작업      # op는 op.workspace 태그로 격리 author
3. 격리 디렉토리에서 빌드·테스트         # 다른 workspace와 안 섞임 (← 컴파일 격리 문제 해결)
   → treeHash 바인딩 + 서명 evidence
4. land: 게이트 통과 시 base line에 accept # 충돌하면 op 3-way merge
5. workspace 폐기                     # 물리 정리, shared-paths는 캐시로 남김
```

## 5. 검증 & Evidence 모델

검증은 **실행 / 바인딩 / 신뢰** 세 레이어로 분리된다. avcs는 검증을 **실행하지 않는다.**

| 레이어 | 무엇 | 누가 소유 |
|---|---|---|
| **실행** | 실제 빌드/테스트 | **workspace 디렉토리** (빌드 환경 보유). avcs 아님 |
| **바인딩** | "무엇을 검증했나"를 못 속이게 묶음 | avcs: evidence를 **treeHash + command + result**에 결박 |
| **신뢰** | 이 증거를 믿나 | avcs: **서명자 키 + 작성자≠서명자** |

### 5.1 Evidence 등급 — 자가 vs 독립

git을 벤치마킹한다: `git commit`은 작성자가 자기 코드를 테스트하고 올리는 **낙관적 기록**이고, 신뢰는 main 머지 시점(CI/리뷰/서명)에 따진다.

- **자가 evidence** (작성자 = 서명자): "내가 돌렸고 통과했다"는 서명된 **주장**. workspace **내부** 진행에는 충분(=`git commit`). **release 게이트는 못 넘김.**
- **독립 evidence** (작성자 ≠ 서명자: 다른 에이전트 / 로컬 검증자 키 / 사람 / CI): base 합류·release 게이트 **통과**(=CI status / 서명 / approval).

avcs엔 이미 actor kind(human/ai_agent/ci_bot) + authority weight + keyring이 있으므로, "evidence 신뢰 weight = 서명자 기반, 작성자 자가 = 0"으로 게이트하면 등급제가 기존 정책 위에 그대로 얹힌다(`docs/04-policy.md`의 "작성자 아닌 신뢰 actor만 센다"와 일치).

### 5.2 두 게이트

- **workspace land 게이트**: 내 op가 자체로 정합(격리 트리 검증) + base와 conflict-free.
- **release 게이트**: 통합 treeHash가 검증됨(독립 evidence).

## 6. "base 갱신/rebase"는 avcs에 없다

선형 VCS(git)는 머지 전 rebase로 "내 변경을 새 base 위로 옮겨 재검증"한다. **avcs엔 이 개념이 불필요하다** — 병렬이 기본이기 때문이다.

- reduce(materialize)는 **항상 그 시점의 전체 op 집합을 3-way merge**한다. "base가 전진했다"는 별도 이벤트가 없다 — op가 늘면 reduce가 다시 돌 뿐이다.
- **정합성은 treeHash 바인딩이 자동으로 강제한다**: 다른 workspace가 먼저 land해서 통합 treeHash가 바뀌면, 기존 evidence는 그 새 treeHash에 **자동으로 적용되지 않는다**(바인딩 불일치) → release 게이트가 "검증 안 된 통합 트리"를 막는다. rebase를 강제하지 않아도 treeHash가 정합성을 처리한다.

따라서 "검증한 트리 = land될 트리"를 rebase로 보장하는 대신, **검증을 두 층으로 분리**한다(§5.2). git이 rebase로 억지로 합치는 것을, avcs는 병렬 전제 덕에 분리할 수 있다.

## 7. shared-paths — 빌드 환경 공유 (코어 무지 유지)

git worktree의 약점이 #11의 고통이다: worktree마다 `node_modules`가 따로라 매번 install. native workspace는 **shared-paths**로 해결한다 — 투영에서 제외하고 중앙 캐시를 심링크/오버레이하는 경로 집합.

- avcs는 그게 `node_modules`인지 **모른다.** `.avcsignore`(#10)와 같은 "내용 모르고 경로 규칙만" 패턴이라 코어의 빌드 무지(원칙 2)가 유지된다.
- 효과: 의존성 install이 workspace 생성당 1회(같은 lock-해시끼리 캐시 공유), 매 검증마다 아님. #11의 "매번 빌드 환경 재현"이 외부 의존이 아니라 **workspace 구조**로 풀린다.

## 8. `validate_run` 재정의

격리 `mkdtemp` + install 모델을 폐기하고:

> **"op 집합을 workspace 디렉토리(빌드 환경 보유)에 펼쳐 그 자리에서 명령 실행 → 결과를 treeHash에 묶고 호출 actor 키로 서명한 evidence로 attach."**

avcs는 환경을 만들지 않고 빌려 쓴다. 자가검증(작성자=서명자)이면 weight 0으로 release 게이트에서 무시된다.

## 9. 관련 이슈

- **#11** (validate_run 외부 의존) — 이 설계로 구조적 해소: 검증 실행이 workspace로, install이 shared-paths로.
- **#10** (`.avcsignore`) — shared-paths가 같은 "경로 규칙" 패턴을 재사용.
- **#12 / #13** (object read / pending materialize) — workspace 읽기 투영이 `includeStatuses` candidate materialize를 활용.
- **#15** (decision 서명) — evidence 등급의 신뢰(서명) 기반.

## 10. 미해결 / 오픈 질문

1. **shared-path 무결성** — `node_modules`를 공유하는데 두 workspace의 `package.json`/lock이 다르면 깨진다. 공유 키(lock 경로/해시)를 사용자·에이전트가 지정하는 형태가 유력(코어 무지 유지). lock-해시 기반 자동 분리까지 코어가 책임질지는 미정.
2. **투영 비용** — 큰 저장소 물리 복제. hardlink/CoW 투영 필요.
3. **op 캡처 경계** — workspace에서의 수정을 op로 캡처할 때 shared-path가 op로 새지 않게(#10 ignore 재사용).
4. **land merge 시맥틱** — workspace op를 base에 accept할 때 reduce의 3-way merge로 자동 합류(§6). conflict는 `conflict_list`로 표면화 → 사람/정책 결정.
