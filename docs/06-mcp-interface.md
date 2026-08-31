# 06 — MCP / Skill 인터페이스

AVCS에서 **1급 인터페이스는 CLI가 아니라 MCP 서버**다. 에이전트는 git status/diff/commit을 이해할 필요 없이, MCP tool과 skill로 사용법을 즉시 주입받는다. 구현: [`src/mcp/server.ts`](../src/mcp/server.ts).

> MCP는 AI 앱이 외부 데이터·도구·워크플로우에 연결되는 표준이다. 서버는 `resources`(읽기 맥락)·`prompts`(작업 템플릿)·`tools`(행위)를 제공한다. **Phase 16(M1–M5)에서 셋 다 구현 완료** — tools 36종 + 구독 가능한 resources 4종 + prompts 4종 + 변경 알림. 설계 근거는 **[18 — MCP 일급 커넥션](18-mcp-first-class.md)**.

## 정본 루프

에이전트가 도는 표준 경로다. `avcs.guide`가 이 루프를 기계가독 형태로 돌려주며, **도구 색인과 에러맵은 live 테이블에서 생성**되므로 서버와 어긋날 수 없다.

```
intent.read → context.build → lease.request → operation.propose
  → validate.run / evidence.attach → view.materialize → sync.land
```

마지막 단계가 핵심이다: `sync.land`가 push·checkpoint·통합을 **내부에서** 수행하므로, 에이전트가 보는 결과는 `landed` 또는 사람이 결정할 충돌 패킷 **둘뿐**이다. "head moved, pull first"는 도달하지 않는다.

## 프로필 — 광고되는 도구 수를 줄인다

도구 스키마는 에이전트가 **매 세션 지불하는 통행료**다. 기본은 전체 광고(호환)이고, `avcs mcp --profile core` 또는 `AVCS_MCP_PROFILE=core`가 정본 루프에 필요한 13종만 광고한다:

`guide · intent.read · intent.list · session.start · context.build · lease.request · operation.propose · evidence.attach · validate.run · repair.context · view.materialize · conflict.list · sync.land`

| 프로필 | 도구 | description 단어 |
|---|---|---|
| Phase 16 이전 | 27 | 873 |
| full (기본) | 36 | 620 |
| **core** | **13** | **230** |

도구를 9종 **늘렸는데도** full이 시작점보다 가볍다(M1의 25단어 상한 + 교육 내용의 `avcs.guide` 이관). core는 74% 가볍다. `checkpoint.create`·`sync.push`·`integration.submit`이 core에서 빠진 것은 `sync.land`가 셋을 흡수하기 때문이다 — 작은 표면에 남기면 M2가 없앤 checkpoint 춤을 다시 가르치게 된다. **프로필은 메뉴를 줄일 뿐 능력을 없애지 않는다**: 이름을 아는 클라이언트는 여전히 모든 도구를 호출할 수 있다.

## Tool 표면 (현재: 36종)

모든 도구는 공통 선택 인자 `cwd`(대상 저장소 힌트, 아래 repo discovery)와 `verbose`(pretty-print)를 받는다.

**온보딩** *(Phase 16 M1 — [18](18-mcp-first-class.md) §1.3)*

| tool | 역할 |
|------|------|
| `avcs.guide` | 정본 루프·에이전트 규칙·도구 색인·에러 복구. **먼저 호출한다.** 도구 색인과 에러맵은 live 테이블에서 생성되므로 서버와 어긋날 수 없다. `topic`: workflow(기본)·tools·sync·rules·errors |

**거버넌스 / 리뷰** *(Phase 16 M4 — [18](18-mcp-first-class.md) §4.4)*

| tool | 역할 |
|------|------|
| `avcs.governance.status` | 뷰의 protection·head·내 역할·유효 승인 (읽기 전용) |
| `avcs.approval.record` | 리뷰어 판정 기록(로컬 키 서명, 역할 ≥ reviewer). `decision.record`와 달리 사람 elicitation 게이트가 없다 — 승인은 역할·서명으로 이미 게이트되므로 키를 가진 리뷰어 봇이 의도된 사용자다 |

> **승인 조회는 게이트와 같은 뷰를 쓴다.** `repo.approvalsFor()`는 finalize가 쓰는 것과 동일한 신뢰 게이트를 지난다 — 역할을 잃은 actor의 승인은 빠지고, 같은 리뷰어의 나중 판정이 앞선 것을 덮는다. 리뷰 화면이 게이트가 세지 않을 승인을 보여줄 수 없다.

**Resources (구독 가능)** — `capabilities.resources.subscribe: true`

| uri | 내용 |
|-----|------|
| `avcs://view/{view}/head` | `{ view, head, treeHash }` — 구독하면 head 전진을 통보받는다 |
| `avcs://view/{view}/conflicts` | 열린 충돌 (`avcs.conflict.list`와 동일 출력) |
| `avcs://view/{view}/context` | 뷰 기본 ContextPack. **스코프는 "지금 판에 올라온 키"** — 열린 충돌의 키 + 최근 op 20개가 만진 키 |
| `avcs://guide` | guide |

**Prompts** — `avcs.onboard`(guide 인라인) · `avcs.propose-change`(intent 제약·범위 인라인) · `avcs.resolve-repair`(repair 패킷 인라인) · `avcs.review-change`(protection·승인·충돌 수 인라인)

> **알림.** 로컬 워처가 `.avcs`를 주기 비교(`AVCS_MCP_WATCH_MS`, 기본 3000, `0`이면 off)해 `head-advanced`·`foreign-op-hot-key`·`conflict-opened`를 방출한다. 구독 중이면 `notifications/resources/updated`, 아니면 `notifications/message`로도 보내므로 구독 없는 클라이언트도 눈이 멀지 않는다. **폴링이 정확성 경로다** — `fs.watch`는 플랫폼별로 이벤트를 흘리고, head 전진을 놓치는 것이 이 기능이 막으려는 실패다.

**컨텍스트 / 결정 메모리** *(Phase 16 M3 — [18](18-mcp-first-class.md) §M3)*

| tool | 역할 |
|------|------|
| `avcs.context.build` | 스코프(`intentOid` \| `entityKeys` \| `paths`, **하나는 필수**)의 작업 맥락을 예산 안에 한 번에: provenance·이전 결정·정책·리스크(conflict/quarantine/lease)·최근 history. **파일 내용은 담지 않는다** — `blobOid`만 주고 텍스트는 `object.show`의 lines/maxBytes 슬라이스에 위임 |
| `avcs.decision.recall` | 키의 이전 인간 결정 + 그로부터 학습된 정책. 재결정 전에 선례를 읽는다 |

> **결정적 절단.** 섹션 우선순위는 고정이다 — `risks` > `decisions`/`policies` > `symbols` > `evidence` > `history` > `suggestedOps`. 섹션 내부는 recency→oid 정렬, 예산은 **컴팩트 직렬화 바이트** 기준 greedy fill. 따라서 **같은 입력은 바이트 동일한 출력**을 내고(reduce에 요구하는 결정론을 컨텍스트에도 적용), 예산에 밀린 섹션은 `budget.truncated`에 기록된다 — 빈약한 저장소와 잘린 팩을 구분하지 못하면 에이전트가 부분 정보로 확신에 찬 결정을 한다. 스코프 없는 호출은 **거부**한다.

**동기화 / 랜딩** *(Phase 16 M2 — [18](18-mcp-first-class.md) §M2)*

| tool | 역할 |
|------|------|
| `avcs.sync.land` | **정본 루프의 종점.** push → merge-check → checkpoint → 통합을 한 호출로. 결과는 `landed:true` 또는 `landed:false` + `reason`/`nextActions`. **"head moved"는 에이전트에게 도달하지 않는다** |
| `avcs.sync.pull` | 허브에서 객체 pull(무충돌 gossip이라 언제든 안전). `dryRun`은 받아올 개수와 local/hub head 비교만 |
| `avcs.sync.push` | 로컬 객체 push → `{pushed, rejected}` |
| `avcs.workspace.project` | 뷰를 디스크에 기록 → `{dir, fileCount, treeHash}`. validate.run 밖 빌드/테스트 루프용 |

> **land 계약.** 충돌은 **재시도하지 않는다** — 사람이 골라야 하므로 첫 시도에 `conflicts` + 결정 패킷 + `nextActions`(conflict.list → decision.record → land)를 돌려준다. 통합 큐의 `queued`는 루프가 백오프로 흡수하고, `needs_evidence`는 예약된 트리에 검증 1회가 필요하다는 뜻이라 `validate.run` → `evidence.attach` → `land`로 안내한다. 허브가 없거나 구버전이면 로컬 CAS finalize로 폴백하되 **계약은 동일**하다.

> **응답 관례 (M1).** 모든 응답은 **컴팩트 직렬화**가 기본이다(들여쓰기는 에이전트가 매 호출 지불하는 토큰). 사람이 읽을 때만 범용 입력 `verbose: true`. 실패는 산문이 아니라 `{ error, hint?, nextActions? }` 봉투로 오므로, **에러 문자열을 파싱하지 말고 `nextActions`를 따른다.** 목록형 읽기는 유계다 — `history`(limit 20 + cursor), `intent.list`(limit 50), `view.materialize`(filesLimit 500 + `filesTotal`/`filesTruncated`), `object.show`(lines/maxBytes + `bytes`/`truncated`). `treeHash`·status·conflicts는 정확성 데이터라 **절대 잘리지 않는다.**

**intent / session**

| tool | 역할 |
|------|------|
| `avcs.intent.create` | 목적·제약·허용 범위 개시. 모든 작업의 출발점 |
| `avcs.intent.read` | intent와 제약 읽기 — propose 전에 반드시 |
| `avcs.intent.list` | intent 목록 (limit, 기본 50) |
| `avcs.session.start` | intent에 대한 작업 세션 시작 → sessionOid |

**변경 제안**

| tool | 역할 |
|------|------|
| `avcs.operation.propose` | 의미 변경 제출. `baseText`/`baseBlobOid`가 있으면 3-way 병합 가능한 `edit_file`, 없으면 `put_file`. **effects 정직 선언**, 선택 `line`/`workspace`/`causalDeps` |
| `avcs.operation.backport` | op를 다른 line으로 이식(cherry-pick/backport, `derivedFrom` provenance) |

**검증 / 수리**

| tool | 역할 |
|------|------|
| `avcs.evidence.attach` | test/typecheck/... 증거 첨부 (선택 `treeHash` 바인딩) |
| `avcs.validate.run` | 실제 셸 체크를 실행해 treeHash 바인딩 Evidence 생성 |
| `avcs.repair.context` | 실패 op의 최소 수리 패킷(전체 재독 대신) — 토큰 절약 장치 |

**view / 충돌 / 결정**

| tool | 역할 |
|------|------|
| `avcs.view.materialize` | 연산 그래프 → treeHash + 파일 목록 + status + conflicts + dropped (내 작업이 병합되는지 확인; 파일 **내용**은 `object.show`로) |
| `avcs.conflict.list` | 사람이 결정할 충돌 목록 |
| `avcs.decision.record` | 충돌 해결 기록. **사람 전용** — 로컬 서명 키 + elicitation 확인 요구. CLI 대응물은 `avcs decide <conflict-id> --choose <op-oid>`(호출자가 사람이므로 elicitation 대신 서명 자체가 게이트) |

**checkpoint / release / 통합**

| tool | 역할 |
|------|------|
| `avcs.checkpoint.create` | 검증된 상태 벡터 동결 |
| `avcs.release.cut` | 검증된 checkpoint + 증거 + SBOM + 서명 아티팩트로 릴리스 |
| `avcs.integration.submit` | Phase 14 통합 큐 제출 — 결과는 항상 verdict(advanced/conflict 패킷/needs_evidence/queued), **절대 pull-and-redo 아님** |
| `avcs.integration.status` | 티켓 verdict 멱등 조회(폴링) |

**동시성 / line / workspace**

| tool | 역할 |
|------|------|
| `avcs.lease.request` | 편집 전 scope soft 선점 — 시작 시점 충돌 예방 |
| `avcs.line.create` / `avcs.line.list` | 장수 라인 분기/목록 |
| `avcs.workspace.land` / `avcs.workspace.list` | 격리 workspace를 base line에 land / 목록 |

**관측**

| tool | 역할 |
|------|------|
| `avcs.blame` | 엔티티의 현재 소유 op — 누가/왜 |
| `avcs.blame.lines` | **줄 단위** provenance — 각 줄을 마지막에 쓴 op(actor·intent·purpose). "이 줄이 왜 여기 있나" |
| `avcs.history` | 엔티티 인과 순서 히스토리 (entity index, O(ops-on-entity)). 페이지: `limit`(20) + `cursor`, 짧은 페이지 = 끝 |
| `avcs.diff` | 두 view의 added/removed/modified 경로 |
| `avcs.object.show` | oid로 임의 객체/blob 읽기 (타 에이전트 내용·base blob 조회) |
| `avcs.metrics` | reduce 캐시 hit/miss 등 인프로세스 메트릭 |

> **아직 CLI 전용인 것**: pull/push/clone/finalize/serve 등 분산·거버넌스 표면. 이를 MCP로 올리는 설계(`avcs.sync.land`, `avcs.context.build`, 알림/구독, core 프로필)는 [18 — MCP 일급 커넥션](18-mcp-first-class.md), 허브측 통합 큐는 [17 — 수렴](17-sync-convergence.md) 참조.

실행 — `avcs mcp`가 stdio MCP 서버를 띄운다(이것이 에이전트가 spawn하는 1급 진입점):
```bash
# 전역 설치본 / 소스 체크아웃 어디서든
avcs mcp                          # 대상 저장소를 호출마다 자동 발견 (아래 우선순위)
AVCS_REPO=/path/to/repo avcs mcp  # 특정 저장소에 고정 (자동 발견 비활성)

# 소스 체크아웃에서 직접 실행할 때
npm run mcp                       # = node --experimental-strip-types src/mcp/server.ts
```

### 대상 저장소 해석 (repo discovery)

전역으로 한 번 등록된 단일 MCP 서버는 서버의 cwd가 저장소 밖이어도, 또 여러 저장소를 오가도 동작해야 한다. 서버는 각 tool **호출마다** 다음 우선순위로 대상 저장소를 정하고, 각 후보를 상위로 거슬러 올라가며 `.avcs/`를 찾는다(git의 `.git` 탐색과 같되 AVCS 자체 마커만 사용 — git 비의존):

1. **`AVCS_REPO`** — 명시 고정. 설정 시 이것만 사용한다(서브디렉토리도 상위 탐색으로 해석). "고정은 고정".
2. **tool 인자 `cwd`** — 모든 tool이 받는 선택 인자. "이 디렉토리가 속한 저장소에 작업하라". 한 서버로 여러 저장소를 타게팅하는 수단.
3. **클라이언트 워크스페이스 roots** — MCP `roots` capability로 클라이언트가 광고하는 작업 디렉토리(프로토콜 표준 경로). 미지원 클라이언트면 건너뛴다.
4. **서버 자신의 cwd** — 최후 폴백.

어디서도 못 찾으면 "어디를 뒤졌는지 + `cwd`/`AVCS_REPO`/`avcs init` 안내"를 담은 실패 메시지를 던진다. 같은 저장소는 호출 간 `Repo` 인스턴스를 재사용해 reduce 캐시·메트릭을 유지한다.

Claude Code에 등록:
```bash
avcs mcp install                  # `claude mcp add avcs -- avcs mcp` 를 대신 실행 (scope: user)
avcs mcp install -s local --repo /path/to/repo   # 스코프/대상 저장소 지정
claude mcp list                   # "avcs" 가 Connected 인지 확인
```
`claude` CLI가 PATH에 없으면 `avcs mcp install`이 그대로 실행할 수 있는 수동 등록 명령을 출력한다.

`@modelcontextprotocol/sdk`는 optionalDependency라 `avcs` 설치 시 기본 동봉된다. 만약 누락됐다면 서버는 재설치 안내 후 종료한다(tool 표면 정의는 코드에 그대로 존재).

## 에이전트 워크플로우

```
1. avcs.intent.read         (intent와 제약 파악)
2. avcs.context.build       (관련 symbol/test/decision 로드 — 설계: 18)
3. avcs.lease.request        (scope 선점)
4. (코드 작업)
5. avcs.operation.propose    (변경을 operation으로 제출)
6. avcs.validate.run / avcs.evidence.attach  (검증·증거 첨부)
7. avcs.view.materialize     (병합 가능 여부 확인)
8. 실패 → avcs.repair.context → repair op 덧붙임 (기존 op를 숨기지 않음)
9. 충돌 → avcs.conflict.list → 사람에게 선택지 제시
10. accepted → avcs.checkpoint.create (→ 설계: avcs.sync.land, 18)
```

핵심: 에이전트는 **git commit부터 하지 않는다.** 먼저 operation + evidence를 제출하고, 코드 트리는 마지막 materialization이다.

## Skill 규칙 (에이전트 system prompt에 주입)

```
- 너는 raw file을 직접 최종 수정하지 않는다. 모든 변경은 avcs.operation.propose로 제출한다.
- public API 변경은 effects.breaksPublicApi=true 로 정직하게 선언한다.
- 동작을 바꾸는 연산은 통과 테스트 evidence 없이 accepted 될 수 없다.
- validation 실패 시 새 op를 덧붙이고 기존 op를 숨기지 않는다 (히스토리 보존).
- 충돌이 나면 조용히 덮어쓰지 말고, 사람을 위한 선택지를 만든다.
- intent의 allowedScopes 밖을 건드리지 않는다.
```

이 규칙들은 정책 엔진이 *강제*하기도 한다(예: 테스트 없는 동작 변경은 reducer가 reject). skill은 에이전트가 처음부터 올바른 모양으로 일하게 만들고, 정책은 최후의 보증이다.

## 보안 — transcript를 영구 저장하지 말 것 {#보안}

Entire는 transcript·checkpoint 메타데이터를 Git 전용 branch에 저장하는데, public repo면 그 branch도 public이 되고 redaction은 best-effort다. AVCS는 이를 피한다:

| 저장 위치 | 내용 | 보존 |
|-----------|------|------|
| 별도 암호화 스토어 | raw prompt/transcript | 짧게, 기본 push 금지 |
| 저장소(repo) | distilled context: 의도 요약·제약·버린 대안·도구 호출 요약·decision | 영구 |

즉 "모든 프롬프트"가 아니라 **왜 바꿨는가 / 무슨 제약이 있었는가 / 무엇을 버렸는가 / 어떤 검증을 통과했는가 / 다음 에이전트가 기억할 것**만 남긴다. commit 전 redaction + secret 스캔은 머지 파이프라인의 일부.

→ 다음: [07 — 로드맵](07-roadmap.md)
