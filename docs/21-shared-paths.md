# 21 — shared-paths: 빌드 환경 공유로 물리 격리를 자립시키기

> **상태: 설계 (구현 전).** [16 — Workspace 스코프](16-workspace-scope.md) §7이 개념만 제시하고
> 코드는 한 줄도 없는 부품(`grep -r sharedPath src/` → 무결과)의 명세다. 이것이 없으면 native
> workspace가 실제 프로젝트에서 git worktree를 **대체할 수 없고**, 따라서 avcs의 단독성 원칙
> ([16](16-workspace-scope.md) §2-1)이 실사용에서 성립하지 않는다.

## 1. 문제

[16](16-workspace-scope.md) §4.3대로 workspace를 만들면 물리 디렉터리에 view가 투영된다. 그런데
컴파일이 필요한 프로젝트에서 **투영만으로는 빌드가 되지 않는다** — 의존성 트리(`node_modules`,
`vendor`, `target`, `.venv`, `__pycache__` …)가 없다.

현재 코어의 상태:

- 그런 디렉터리는 `.avcsignore`(`#loadAvcsIgnore`)로 **캡처에서 제외**된다. 이 절반은 이미 동작한다.
- 그러나 **투영 쪽에는 아무것도 없다.** `checkoutInto`는 `res.tree`에 있는 파일만 쓰므로, 무시된
  경로는 새 workspace 디렉터리에 애초에 존재하지 않는다.
- 결과: workspace를 만들 때마다 의존성을 새로 설치해야 한다. 이것이 [16](16-workspace-scope.md) §1이
  기록한 고통(#11)이고, 사람들이 결국 git worktree로 돌아가는 이유다.

**핵심 구분:** 무시(ignore)는 "op으로 기록하지 않는다"이고, shared-path는 "op으로 기록하지 않되
**디렉터리에는 있게 한다**"다. 지금 코어는 앞의 절반만 갖고 있다.

## 2. 원칙 (제약)

1. **코어는 빌드를 모른다** ([16](16-workspace-scope.md) §2-2). `node_modules`가 무엇인지, `pnpm`이
   무엇인지 모른다. **경로 규칙과 내용 해시만** 다룬다 — `.avcsignore`(#10)와 같은 패턴.
2. **코어는 설치를 실행하지 않는다.** 의존성을 채우는 명령을 코어가 알거나 실행하는 순간 원칙 1이
   깨진다. 코어는 **자리를 만들고 연결**하고, 채우는 일은 호출자(사람/에이전트/CI)가 한다.
3. **zero-dep.** node 표준 라이브러리만(`symlink`, `mkdir`, `stat`, `sha256`).
4. **하위 호환.** 설정 파일이 없으면 동작이 지금과 **완전히 동일**하다. 신규 aux 파일 하나만 추가.
5. **캡처 오염 0.** 공유된 경로가 op으로 새어 들어가는 일은 **구조적으로 불가능**해야 한다 — 설정을
   빠뜨려서 5만 개 파일이 캡처되는 사고가 나면 안 된다.

## 3. 설계

### 3.1 설정 — `.avcs/shared-paths.json` (aux, 객체 아님)

```jsonc
{
  "version": 1,
  "shared": [
    {
      "path": "node_modules",          // 투영 루트 기준 상대 경로
      "keyFrom": ["pnpm-lock.yaml"],   // 이 파일들의 투영 내용이 캐시 키를 만든다
      "mode": "symlink"                // "symlink"(기본) | "copy"
    },
    { "path": "packages/web/node_modules", "keyFrom": ["pnpm-lock.yaml"] }
  ]
}
```

- `path`는 **경로 규칙일 뿐**이다. 코어는 그 이름의 의미를 모른다.
- `keyFrom`이 §3.2의 답이다 — [16](16-workspace-scope.md) §10 미해결 질문 1("공유 키를 누가
  지정하나")을 **선언적으로** 해소한다: 사용자가 *어떤 파일이 환경을 결정하는지* 선언하고, 코어는
  그 파일들의 내용을 해시할 뿐 파일의 의미는 모른다.
- `.avcs/` 안에 두므로 sidecar 모드에서 git에 노출되지 않는다. `remotes.json`과 같은 aux 취급
  (gossip 제외, 원자적 쓰기 경로 재사용).

### 3.2 캐시 키 — 선언된 파일의 투영 내용에서 유도

```
key = sha256( canonical( [ [path, blobOidOfProjectedContent] for path in sorted(keyFrom) ] ) )[:32]
```

- **투영된 내용**을 쓴다(디스크가 아니라). 그래야 같은 view를 투영한 두 workspace가 **반드시** 같은
  키를 얻는다 — 결정론이 캐시 정확성을 공짜로 준다.
- `keyFrom`의 파일이 view에 없으면(아직 만들지 않은 lockfile 등) 그 파일은 빈 내용으로 해시에
  참여하고, 그 사실을 경고로 남긴다. 조용히 다른 키를 만들지 않는다.
- `keyFrom`이 빈 배열이면 키는 상수 `"unkeyed"`다 — "모든 workspace가 한 캐시를 공유한다"는
  명시적 선택. 위험하지만 사용자가 선언한 것이므로 허용하고 경고한다.

### 3.3 캐시 위치 — store-local

```
<store>/shared/<key>/<slug(path)>/
```

- 스토어 안에 둔다: 정리가 `.avcs` 하나로 끝나고, 홈 디렉터리를 오염시키지 않으며, 서로 다른
  프로젝트의 lock 해시가 우연히 충돌할 여지가 없다.
- linked worktree는 포인터를 따라 **메인 스토어의 캐시를 공유**한다([14](14-git-bridge.md)의
  "하나의 스토어" 모델과 동형) — 이것이 workspace 간 공유가 성립하는 지점이다.
- `<slug(path)>`는 `path`를 `/`→`__`로 치환한 것. 한 키 아래 여러 공유 경로가 공존한다.

### 3.4 투영 시 연결 — `linkSharedPaths()`

`checkoutInto`가 트리를 쓴 **뒤**에 실행한다(순서가 중요하다: 트리 쓰기가 디렉터리를 만들 수 있다).

```
for each entry in shared:
  key   = deriveKey(entry.keyFrom, reduction)
  cache = <store>/shared/<key>/<slug>
  mkdir -p cache                      # 없으면 빈 디렉터리로 생성
  target = <workDir>/<entry.path>

  if target 가 이미 cache 를 가리키는 symlink  → no-op
  if target 가 존재하고 symlink 가 아님        → 건드리지 않고 경고 (사용자 데이터 보호)
  if mode == "symlink"                        → symlink(cache, target)
  if mode == "copy"                           → cache → target 재귀 복사(없을 때만)
```

반환값으로 각 항목의 `{ path, key, cache, linked, populated }`를 준다. `populated`는 캐시
디렉터리가 비어 있지 않은지 여부 — **호출자가 "설치가 필요한가"를 판단할 유일한 신호**이고,
코어가 설치를 실행하지 않는다는 원칙 2의 표현이다.

CLI는 그것을 사람에게 그대로 말한다:

```
$ avcs workspace project feat-x --out ../feat-x
projected workspace feat-x: 412 file(s) to ../feat-x
shared: node_modules → .avcs/shared/9f2a…/node_modules (EMPTY — 설치를 한 번 실행하세요)
```

두 번째 workspace부터는 `populated`가 true가 되고 설치가 필요 없다. **이것이 #11의 해소다.**

### 3.5 캡처 오염 방지 (원칙 5) — 설정을 빠뜨릴 수 없게

`#readWorkTree`의 ignore 술어에 **shared-path를 자동 합성**한다:

```
ignored(rel) = avcsIgnore(rel) || sharedIgnore(rel) || (ignorePredicate?.(rel) ?? false)
```

즉 `.avcsignore`에 적는 것과 **무관하게** 공유 경로는 캡처되지 않는다. `.avcsignore`에 중복으로
적어도 무해하다. 이것이 "5만 파일 캡처" 사고를 구조적으로 불가능하게 만든다.

추가로 **symlink를 따라 내려가지 않는다**: 워킹트리 순회는 `lstat`으로 판정해 symlink인 디렉터리
항목에는 진입하지 않는다. 지금 코어는 이 구분을 하지 않으므로(`#readWorkTree`) 이것은 **동작
변경**이다 — §5 W6가 회귀 테스트로 고정한다. 안전한 방향의 변경이다(현재는 공유 캐시를 통째로
캡처할 수 있다).

`checkoutInto`도 대칭으로 방어한다: 트리의 파일 경로가 공유 경로 **안쪽**이면 쓰지 않고 경고한다
(정상적으로는 발생하지 않는다 — 캡처가 막았으므로 — 그러나 과거에 오염된 히스토리를 열 수 있다).

### 3.6 수명주기

- **키 변경**(lockfile 수정): 다음 투영이 **새 키**의 캐시를 가리킨다. 옛 캐시는 남는다 —
  브랜치를 왕복하는 동안 재설치를 피하려면 그게 맞다.
- **정리**: `avcs gc`에 `--shared` 옵션. "현재 어떤 view에서도 유도되지 않는 키"를 지운다.
  기본 `gc`는 공유 캐시를 **건드리지 않는다**(재설치 비용이 커서 보수적으로 둔다).
- **workspace 폐기**: symlink만 지운다. 캐시는 남는다([16](16-workspace-scope.md) §4.3의
  "shared-paths는 캐시로 남김"과 일치).

## 4. 변경 지점

| 파일 | 변경 |
|---|---|
| `src/api/repo.ts` — config 접근자 | `readSharedPaths()` / `setSharedPaths()` (aux read/write) |
| `src/api/repo.ts` — 신규 `deriveSharedKey` | §3.2. 투영 결과에서 키 유도(순수 함수) |
| `src/api/repo.ts` — 신규 `linkSharedPaths` | §3.4. `checkoutInto` 말미에서 호출 |
| `src/api/repo.ts` — `#readWorkTree` | §3.5. shared ignore 합성 + `lstat` 기반 symlink 미진입 |
| `src/api/repo.ts` — `checkoutInto` | 공유 경로 안쪽 트리 항목 방어 |
| `src/api/repo.ts` — `gc` | `--shared` 옵션 |
| `src/cli.ts` — `workspace project` | 공유 상태(`populated`) 출력 |
| `src/cli.ts` — `shared` 명령 | `avcs shared ls|add|rm` (설정 편집) |
| `docs/16-workspace-scope.md` | §7을 이 문서로 링크, §10 질문 1 해소 표기 |

## 5. 검증 매트릭스

| # | 케이스 | 기대 |
|---|---|---|
| S1 | 설정 없음 | 투영·캡처 동작이 **현재와 완전히 동일**(하위호환 회귀) |
| S2 | 첫 투영 | 캐시 디렉터리가 생기고 symlink가 걸리며 `populated: false` |
| S3 | 같은 `keyFrom` 내용의 두 번째 workspace | **같은 키** → 같은 캐시를 가리킴, `populated: true` |
| S4 | `keyFrom` 파일 내용 변경 후 투영 | **다른 키** → 새 캐시, 옛 캐시 보존 |
| S5 | 재투영(멱등) | 이미 올바른 symlink면 no-op, 경고 없음 |
| S6 | **공유 경로에 실제 디렉터리가 이미 있음** | 건드리지 않고 경고 (사용자 데이터 보호) |
| S7 | 공유 경로 안에 파일 생성 후 캡처 | **op 0개** (`.avcsignore`에 안 적었어도) |
| S8 | 공유 경로가 symlink일 때 캡처 | symlink를 **따라가지 않는다**, op 0개 |
| S9 | `keyFrom` 파일이 view에 없음 | 빈 내용으로 해시 + 경고, 조용히 다른 키를 만들지 않음 |
| S10 | `keyFrom: []` | 상수 키 + 경고 |
| S11 | `mode: "copy"` | 재귀 복사, 이미 있으면 덮지 않음 |
| S12 | linked worktree에서 투영 | 포인터를 따라 **메인 스토어의 캐시**를 공유 |
| S13 | `gc` 기본 | 공유 캐시 **불변** |
| S14 | `gc --shared` | 유도되지 않는 키만 삭제, 유도되는 키 보존 |
| S15 | 결정론 | 같은 view를 투영한 두 디렉터리가 **반드시** 같은 키 |

## 6. 리스크 / 미결정

| # | 항목 | 처리 |
|---|---|---|
| R1 | **symlink `node_modules`를 일부 툴체인이 싫어한다**(경로 해석·watch·realpath 가정) | `mode: "copy"`를 명시적 탈출구로 제공. 기본은 symlink(비용 0)이되 문서에 한계를 적는다. CoW(APFS `clonefile`)는 플랫폼 의존이라 zero-dep 원칙상 후속 |
| R2 | 캐시가 **오염**되면(설치 실패 중단) `populated: true`인데 깨진 상태 | 코어는 "비어 있지 않다"만 보고한다 — 무결성 판단은 빌드 툴의 몫(원칙 1). `avcs shared rm --cache <key>`로 버릴 수 있게 한다 |
| R3 | `lstat` 기반 symlink 미진입은 **동작 변경**이다 | S8이 회귀로 고정. 안전한 방향(현재는 공유 캐시 전체를 캡처할 수 있다)이고, 실사용에서 symlink를 op으로 기록하려던 사례는 없다 |
| R4 | 여러 workspace가 **같은 캐시에 동시 설치**를 실행 | 코어가 설치를 실행하지 않으므로 코어의 락 범위 밖이다. 다만 `linkSharedPaths`는 `withLock("shared:<key>")` 하에서 캐시 디렉터리를 만들어 생성 경쟁만 막는다. 동시 설치 조율은 호출자 책임 — 문서에 명시 |
| Q1 | 캐시를 store-local이 아니라 사용자 홈에 두어 **레포 간** 공유를 할지 | 하지 않는다(§3.3). 서로 다른 프로젝트의 키 충돌·정리 책임이 커진다. 필요성이 실측되면 별도 설계 |
| Q2 | `keyFrom`에 **디렉터리**를 허용할지(예: `patches/`) | v1은 파일만. 디렉터리 해시는 순회 비용과 정렬 규약이 필요해 후속 |

## 7. 이 설계가 지우는 것 / 남기는 것

**지운다:** workspace 생성마다 의존성 재설치(#11) · 물리 격리를 위해 git worktree에 의존해야 하는
이유 · 공유 디렉터리가 op으로 새어 들어갈 가능성.

**남긴다(의도적으로):** 설치 명령의 실행(원칙 2 — 호출자의 일) · 캐시 무결성 판단 ·
동시 설치 조율 · CoW 투영(후속).

→ 관련: [16 — Workspace 스코프](16-workspace-scope.md) §7·§10 · [20 — Workspace-first git 브리지](20-workspace-bridge.md) ·
[14 — Git 브릿지](14-git-bridge.md)
