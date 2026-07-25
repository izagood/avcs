# 18 — MCP 일급 커넥션: 에이전트 표면의 완성

> **상태: M1 구현 완료, M2–M5 설계 합의(구현 전).** 이 문서는 MCP를 avcs의 명실상부한 1급 인터페이스로 완성하는 M1–M5의 설계 결론을 기록한다. 허브측 통합 큐·라이브 동기화는 [17 — 수렴](17-sync-convergence.md)이 담당하고, 이 문서는 그 위의 **에이전트가 보는 면**만 다룬다. 도구 현황은 [06 — MCP 인터페이스](06-mcp-interface.md).

> **설계 시점 대비 갱신(구현 중 확인).** 이 문서는 "24개 도구"를 전제로 쓰였으나 Phase 14·15가 그 사이에 착지했다: `integration.submit`/`integration.status`(14), `contention.check`(15.3), `hubClient.integrateWithHub`(14.4), 이벤트 롱폴 소비(15.1 — `src/hub/syncWatch.ts`)는 **이미 존재한다**. §3 파일 목록에서 이들을 신규로 적은 항목은 완료로 읽어야 하고, M4의 남은 실제 신규는 `governance.status`/`approval.record`다. M1 완료 시점 도구 수는 **28개**.

## 1. 배경 — 무엇이 비어 있나

[06](06-mcp-interface.md)의 선언("1급 인터페이스는 CLI가 아니라 MCP")은 절반만 실현됐다. 정밀 점검 결과:

| # | 공백 | 결과 |
|---|---|---|
| 1 | **sync/분산 도구 전무** — pull/push/clone/finalize/serve는 CLI 전용 | 에이전트는 MCP만으로 허브와 수렴할 수도, protected head에 land할 수도 없다 |
| 2 | **`avcs.context.build`(ContextPack) 미구현** — [05](05-views-checkpoints.md)에 설계, [06](06-mcp-interface.md) 워크플로우 2번에 등장하지만 도구가 없다 | 에이전트가 작업 맥락을 blame/history/decision 개별 호출로 긁어모음 → 토큰 낭비 |
| 3 | **알림/구독 없음** — MCP resources/prompts/notifications 미사용 | "타 에이전트 op가 네 키에 도착" / "head 전진"을 알 방법이 폴링뿐 |
| 4 | **응답이 pretty-print JSON** (`JSON.stringify(result, null, 2)`) | 모든 응답에서 들여쓰기 토큰 낭비 |
| 5 | **무제한 응답** — materialize 파일 목록, history 등 상한 없음 | 큰 저장소에서 응답 폭주 |
| 6 | 실패 응답에 **다음 행동 힌트 없음** | 에이전트가 에러 문자열을 해석하느라 배회(flail) |

## 2. 원칙 (제약)

1. **하위 호환 절대** — 기존 24개 도구의 이름·입력 스키마 보존. 신규 입력은 옵셔널만, 신규 도구는 가산만. **성공 응답을 봉투로 감싸지 않는다**(기존 소비자·테스트가 raw shape을 파싱) — 가산 필드만 허용.
2. **토큰은 예산이다** — 모든 응답 유계(bounded), 컴팩트 기본, 모든 실패는 산문 대신 `nextActions`.
3. **에이전트는 git 고통을 모른다** — `avcs.sync.land`가 내부에서 push→reduce→checkpoint→통합을 처리하고, 에이전트가 보는 결과는 `landed` 또는 최소 conflict 패킷 **둘뿐**. "head moved"라는 문자열은 에이전트에게 도달하지 않는다.
4. **zero-dep** — SDK는 optionalDependency 유지. 이벤트 소비는 내장 fetch, 로컬 감시는 폴링+`fs.watch` 보조.

---

## M1 — 토큰 기반(substrate) + 자가 온보딩 ✅ *(구현 완료)*

> **구현 결과.** 도구 27→28개인데 **description 총량은 873단어 → 489단어(-44%)**. 도구를 늘리고도 에이전트가 매 세션 지불하는 스키마 비용이 줄었다 — M5가 예고한 효과가 프로필 없이도 이미 성립한다. 테스트가 25단어 상한을 강제하므로 산문이 스키마로 되돌아올 수 없다.
>
> **설계와 달라진 두 곳(의도적):**
> 1. **`avcs.history`는 배열 shape을 유지한다.** §1.2 표는 "`total` 가산"이라 했으나 배열에는 필드를 가산할 수 없고, 그렇게 하려면 `{ops,total}` 봉투가 되어 §2 원칙 1·§5의 "성공 응답을 봉투로 감싸지 않는다"를 위반한다. 원칙이 표를 이긴다 — 대신 `limit`+`cursor`의 표준 페이지네이션(짧은 페이지 = 끝)을 쓴다.
> 2. **`object.show`의 `entity: "symbol:<path>#<name>"` 슬라이스는 미구현.** 이 저장소에 `EntityIndexer`가 존재하지 않는다. `lines`/`maxBytes` 유계 읽기는 구현됐고, entity 슬라이스는 인덱서가 생기는 시점으로 미룬다.

### 1.1 응답 레이어 `src/mcp/respond.ts` (신규) — S

- **컴팩트 기본**: `JSON.stringify(result)` (들여쓰기 제거). 범용 옵셔널 입력 `verbose: boolean`(모든 도구에 `cwd`처럼 주입)이 사람 디버깅용 pretty-print 복원.
- **에러 봉투(비파괴)**: 핸들러는 지금처럼 throw; CallTool 래퍼가 잡아 `{ error, hint?, nextActions?: string[] }`로 직렬화. 정적 `RECOVERY` 맵이 알려진 실패 클래스를 번역 — 예: `head moved` → `["avcs.sync.land (자동 재시도)", "avcs.sync.pull"]`, `no local signing key` → `["avcs key provision …"]`, `not an AVCS repo` → `["cwd 전달", "avcs init"]`.
- 성공 응답은 shape 불변, 힌트가 필요한 곳(materialize/propose/land)만 `hint`/`nextActions` **가산** 필드.

### 1.2 유계 읽기 — M

| 도구 | 추가 입력 | 응답 변화 |
|---|---|---|
| `avcs.history` | `limit`(기본 20), `cursor`(불투명=마지막 op oid) | `total` 가산 |
| `avcs.intent.list` | `limit`(기본 50) | — |
| `avcs.view.materialize` | `filesLimit`(기본 500), `pathsOnlyUnder` | `filesTotal`, `filesTruncated` 가산 (`treeHash`/`status`/`conflicts`/`dropped`는 항상 완전) |
| `avcs.object.show` | `lines: {start, end}`, `entity: "symbol:<path>#<name>"`(EntityIndexer 슬라이스), `maxBytes`(기본 64KB) | `bytes`(전체 크기), `truncated` 가산 |
| `avcs.diff` | `format: "paths"\|"patch"`(기본 paths=현행), `path` 필터 | patch면 unified diff (신규 `unifiedDiff(a,b)` in `src/query/diff.ts` — merge3의 라인 diff 코어 재사용) |

- **description 감량 패스**: 24개 도구 설명을 ≤25단어로(교육 내용은 `avcs.guide`로 이관). 신규 도구 추가분보다 큰 클라이언트 컨텍스트 절감 — 도구 스키마는 에이전트가 **항상** 지불하는 토큰이고, guide는 필요할 때만 지불한다.

### 1.3 `avcs.guide` (신규, `src/mcp/guide.ts`) — S

- 입력 `{ topic?: "workflow" | "tools" | "sync" | "rules" | "errors" }`, 무topic → 정본 루프.
- 출력(컴팩트, 버전 필드 `{v:1,…}`): 정본 루프의 `{step, tool, why}` 배열(`intent.read → context.build → lease.request → operation.propose → validate.run/evidence.attach → view.materialize → sync.land`), [06](06-mcp-interface.md) 스킬 규칙 6조(기계가독), **TOOLS 배열에서 생성되는** 도구 한 줄 색인(드리프트 불가), 에러→nextAction 맵. 약 600토큰, 온디맨드.
- M4에서 MCP prompt `avcs.onboard`로도 등록.

---

## M2 — sync 일급화: 에이전트는 손으로 pull하지 않는다 ✅ *(구현 완료)*

> **구현 결과.** `avcs.sync.pull`/`push`/`land`/`avcs.workspace.project` 4종 추가(28→32). land 루프는 `src/mcp/land.ts`에 분리해 SDK 없이 단위 테스트하며, CLI `avcs land`가 **같은 함수**를 호출한다(사람과 에이전트의 의미가 갈라지지 않는다).
>
> **M1이 남겨둔 연결을 완성:** `RECOVERY`의 "head moved" → `avcs.sync.land`, guide 정본 루프의 마지막 3단계(materialize→checkpoint→submit)가 `sync.land` 한 번으로 축약. M1의 드리프트 가드가 이 도구들이 실재하게 된 시점에 그대로 통과하며 연결됐다.
>
> **설계보다 결과를 하나 늘렸다.** §2.2는 결과를 `landed | conflict` 둘로 적었으나 통합 큐의 verdict는 넷이다(advanced·conflict·needs_evidence·queued). `queued`는 루프가 흡수하고(백오프 후 재시도), `needs_evidence`는 **흡수하면 안 된다** — 큐가 예약한 트리에 검증을 딱 1회 돌린 뒤 같은 티켓으로 전진하는 계약이라, 그냥 재시도하면 재예약만 반복한다. 그래서 `{landed:false, reason:"needs_evidence", nextActions:[validate.run, evidence.attach, land]}`로 돌려준다. 에이전트가 "pull 하고 다시"를 듣지 않는다는 계약은 그대로다.

### 2.1 `avcs.sync.pull` / `avcs.sync.push` — S

- `avcs.sync.pull { hub?, dryRun? }` → `{ pulled, head: {local, hub}, converged }`. pull은 무충돌 객체 gossip이므로 항상 안전; `converged:false`여도 다음 행동은 대개 "없음"(reduce가 처리) — 힌트로 명시. `dryRun`이 별도 `sync.status` 도구를 대체(스키마 1개 절약).
- `avcs.sync.push { hub?, as? }` → `{ pushed, rejected }`.
- `hub` 생략 시 [17](17-sync-convergence.md) 13.1의 영속 remote(`origin`) 사용.

### 2.2 `avcs.sync.land` — L, 기함

입력 `{ view?: "main", summary?, by, hub?, maxAttempts?: 5, workspace? }`. 알고리즘(`src/mcp/land.ts`, SDK 없이 단위 테스트 가능하게 export):

1. `workspace` 지정 시 `repo.landWorkspace` 먼저(로컬, 멱등).
2. 루프(≤ maxAttempts, 지터 backoff):
   a. `pushHub`(op/evidence가 허브 게이트에 보여야 함),
   b. `materialize(view)` — **open conflict면 즉시 중단, 패킷 반환. 인간 결정이 필요한 충돌을 재시도로 관통하지 않는다.**
   c. `createCheckpoint(view, summary)`,
   d. **허브 통합 큐 우선**(`hubClient.integrateWithHub`, [17](17-sync-convergence.md) 14.4; `/version` capability 1회 탐지 후 캐시) — 폴백은 legacy CAS finalize + 409 시 pull 후 루프 계속(로컬 모드/구 허브).
3. 성공 → `{ landed: true, head, attempts, treeHash }`.
4. 충돌 → `{ landed: false, attempts, conflicts, packet, nextActions: ["avcs.conflict.list", "사람에게 선택지 제시 후 avcs.decision.record"] }`.

두 경로(통합 큐/legacy 폴백) 모두 **동일한 2-결과 계약**을 노출하므로, 에이전트가 보는 의미는 어느 경로가 실행됐는지에 의존하지 않는다.

### 2.3 `avcs.workspace.project` — S

`{ name?, view?, out }` → `{ dir, fileCount, treeHash }` (`repo.checkoutInto` 래핑, `.avcs-workspace` 마커의 clobber 안전장치 그대로). validate.run 밖에서 반복 빌드/테스트하는 루프를 MCP만으로 완성.

---

## M3 — ContextPack ✅ *(구현 완료)*

> **구현 결과.** `avcs.context.build` + `avcs.decision.recall` 추가(32→34). **결정적 절단**이 계약으로 고정됐다 — 섹션 우선순위(risks > decisions/policies > symbols > evidence > history > suggestedOps), 섹션 내 recency→oid 정렬, 컴팩트 직렬화 바이트 위의 greedy fill. 같은 입력 3회 빌드가 **바이트 동일**함을 테스트가 못박고, 예산에 밀린 섹션은 `budget.truncated`에 기록된다.
>
> **스코프 없는 호출은 에러다.** 저장소 전체를 조용히 담는 대신 거부한다 — 무제한 컨텍스트는 이 도구가 없애려는 문제 그 자체다.
>
> **정본 루프 완성.** `context.build`가 실재하게 되면서 루프가 설계가 처음부터 그린 모양(`intent.read → context.build → lease → propose → validate/attach → materialize → land`)에 도달했다. 루프 3단계의 `contention.check`는 `context.build`로 대체됐다 — §3.1이 ContextPack의 `risks`에 "겹치는 active lease holder = 작업 시작 시점의 충돌 조기 경보"를 명시하므로 진입점 역할을 흡수한다. `contention.check`는 편집 도중 재확인용으로 도구 목록에 남는다.

### 3.1 `avcs.context.build` (신규, `src/mcp/context.ts`) — M/L

- 입력: `{ intentOid? | entityKeys?: string[] | paths?: string[] (≥1 필수), view?: "main", maxBytes?: 8192, include?: string[] }`. 스코프 해석: intentOid → allowedScopes + 그 세션들의 op가 만진 엔티티; paths → `file:` 키.
- 집계는 **기존 API만** 사용: 키별 `blame`(owner/intent/purpose/blobOid/bytes — **내용 미포함**, 에이전트는 `object.show entity`로 슬라이스), `historyOf` 최근 3, `recallDecisions(key)` + `learnedPolicies()`, 리스크(해당 키의 open conflict, quarantine, **겹치는 active lease holder** = 작업 시작 시점의 충돌 조기 경보), head op별 최신 evidence.
- 출력:

```
{ v:1, view, treeHash,
  budget: { maxBytes, usedBytes, truncated: ["history", ...] },
  symbols:  [{key, blobOid, bytes, owner, intent, purpose}],
  decisions:[{key, reason, futurePolicy, by}], policies:[...],
  risks:    [{kind:"conflict"|"quarantine"|"lease", key, detail}],
  evidence: [{op, kind, result}], history:[{key, op, actor, purpose}],
  suggestedOps: [string] }
```

- **결정적 절단**: 섹션 우선순위 고정(risks > decisions/policies > symbols > evidence > history > suggestedOps), 섹션 내 recency→oid 정렬, 컴팩트 직렬화 바이트의 greedy fill, 탈락 섹션은 `budget.truncated`에 기록. **같은 입력 ⇒ 바이트 동일 출력**(avcs 불변식 — 테스트 대상).
- `suggestedOps` v1은 의도적으로 얇게: learnedPolicies + 실패 evidence에서 유도한 문자열("land 전에 통과 unit_test를 첨부하라").

### 3.2 `avcs.decision.recall` — S

`{ conflictKey? }` → `{ decisions: recallDecisions(key), policies: learnedPolicies() }`. 결정 메모리 API 둘을 도구 하나로.

---

## M4 — resources / prompts / 알림 ✅ *(구현 완료)*

> **구현 결과.** resources 4종(subscribe:true 광고) + prompts 4종 + 로컬 워처 + 거버넌스 도구 2종(`governance.status`·`approval.record`, 34→36). `repo.approvalsFor()` 공개 접근자 추가 — finalize가 쓰는 것과 **같은 신뢰 게이트 뷰**라 리뷰 화면이 게이트가 세지 않을 승인을 보여줄 수 없다.
>
> **resources는 도구 핸들러와 같은 repo 호출을 지난다** — 테스트가 `avcs://view/main/conflicts`와 `avcs.conflict.list`의 출력이 deepEqual임을 못박는다(진실은 하나, 문은 둘).
>
> **`avcs://view/{view}/context`의 스코프 문제(설계 미기재).** ContextPack은 스코프 없는 호출을 거부하는데(§3.1) 뷰 단위 resource에는 줄 스코프가 없다. 해결: **지금 판에 올라온 키** — 열린 충돌의 키 + 최근 op 20개가 만진 키. 뷰에 막 도착한 에이전트가 필요로 하는 집합이 정확히 그것이다.
>
> **워처는 폴링이 정확성 경로다.** `fs.watch`는 플랫폼별로 이벤트를 흘리는데(coalescing, 하위 디렉터리 누락, 네트워크 마운트에서 조용히 사망), **head 전진을 놓치는 것**이 이 기능이 막으려는 실패 그 자체다. 그래서 상태 비교가 주 경로이고 fs.watch는 조기 트리거일 뿐이다. 감지기(`RepoWatcher.poll()`)는 SDK 알림 배선과 분리해 직접 구동 테스트한다. 첫 poll은 baseline만 잡는다 — 이력이 있는 저장소에 **도착한 것**은 이벤트가 아니다.
>
> **`foreign-op-hot-key`의 스코프.** stdio 서버는 클라이언트당 1개이므로, 이 클라이언트가 `operation.propose`로 만진 키가 곧 정확한 hot set이다. 자기 op는 경보하지 않는다.
>
> **`avcs.bisect`는 설계대로 보류**(수요 확인 전).

### 4.1 Resources (`src/mcp/resources.ts`) — M

`capabilities.resources`(subscribe: true) 광고. URI(해석된 repo 디렉토리 스코프):

| URI | 내용 |
|---|---|
| `avcs://view/{view}/head` | `{ head, treeHash }` |
| `avcs://view/{view}/conflicts` | 열린 충돌 |
| `avcs://view/{view}/context` | 기본 ContextPack(maxBytes 8192) |
| `avcs://guide` | guide |

읽기 핸들러는 도구 핸들러 재사용. 도구가 파라미터화된 주 경로이고, resources는 **구독 가능**하기 위해 존재한다.

### 4.2 Prompts (`src/mcp/prompts.ts`) — S

`avcs.onboard`(=guide), `avcs.propose-change`(인자 intentOid/paths — intent 제약 인라인), `avcs.resolve-repair`(인자 ops — repairContext 패킷 인라인), `avcs.review-change`(인자 view/checkpoint — diff 경로+evidence+protection 인라인).

### 4.3 로컬 워처 + 알림 (`src/mcp/watch.ts`) — M

- zero-dep: `.avcs` 폴링(oplog 길이 + refs mtime, `AVCS_MCP_WATCH_MS` 기본 3000, 0=off) + `fs.watch`는 기회적 조기 트리거(정확성 경로는 폴링 — fs.watch는 플랫폼별 불안정).
- remote 설정 시 [17](17-sync-convergence.md) 15.1 이벤트 롱폴 소비(내장 fetch) → `objects`/`head` 이벤트에 **기본 auto-pull**(`AVCS_MCP_AUTOPULL=1` 기본 on; pull은 무충돌 gossip이므로 로컬 store가 상시 수렴 → land 1회차 성공률 상승). backoff 재접속, 허브에 피드 없으면 조용히 저하.
- 방출: 구독 URI에 `notifications/resources/updated`, 폴백으로 `notifications/message`(info) — `head-advanced {view, head}`, `foreign-op-hot-key {key, op, actor}`(이 서버 인스턴스의 `operation.propose`가 채운 sessionOid→entityKey 맵 기반 — stdio 서버는 클라이언트당 1개이므로 정확히 맞는 스코프), `conflict-opened`.

### 4.4 거버넌스/리뷰 서브셋 (M, M5로 밀 수 있음)

- `avcs.governance.status { view? }` → `{ protection, head, myRole, approvals }` (읽기 전용).
- `avcs.approval.record { checkpointOid, verdict, by }` — 키를 가진 리뷰어 봇용(`repo.approve` 래핑; decision.record처럼 로컬 키 서명하되 `ci_bot` actor에는 인간 elicitation 게이트 없음 — 승인은 하류에서 역할·서명으로 이미 게이트됨).
- `avcs.contention.check` — [17](17-sync-convergence.md) 15.3의 `repo.contention` 래핑.
- `avcs.bisect`(서버 주도 술어 = `runChecks` per step; MCP는 콜백을 못 넘기므로) — 수요 확인 전까지 보류.

---

## M5 — 프로필 + 문서 ✅ *(구현 완료)*

> **구현 결과 — 설계의 핵심 주장이 실측으로 확인됐다.**
>
> | | 도구 | description 단어 |
> |---|---|---|
> | Phase 16 이전 | 27 | 873 |
> | full (기본) | 36 | 620 |
> | **core** | **13** | **230** |
>
> 도구를 9종 **늘렸는데도** full이 시작점보다 29% 가볍고, core는 74% 가볍다. M1의 25단어 상한 + 교육 내용의 `avcs.guide` 이관이 프로필 없이도 이미 절감을 만들었고, 프로필이 그 위에 얹혔다.
>
> **최종 도구 수는 설계 추정(31–33)보다 많은 36이다.** Phase 14·15가 설계 이후에 착지하며 `integration.submit`/`status`·`contention.check` 3종을 먼저 넣었고, M2가 `sync.pull`/`push`를 별도 도구로 유지했기 때문이다. core 프로필이 있으므로 이 숫자가 에이전트 비용으로 직결되지는 않는다.
>
> **프로필은 메뉴를 줄일 뿐 능력을 없애지 않는다** — 광고 목록만 필터되고, 이름을 아는 클라이언트는 여전히 모든 도구를 호출할 수 있다. 알 수 없는 프로필 이름은 **전체로 degrade**한다(오타가 능력이 아니라 토큰만 쓰게). 테스트가 정본 루프 전체가 core 안에 들어감을 못박아, "작다"가 "일을 끝낼 수 없다"를 뜻하지 않게 한다.

- 최종 도구 수 ≈ 31–33. **기본 광고는 전체**(호환). `avcs mcp --profile core` / `AVCS_MCP_PROFILE=core`가 핵심 13개만 광고:
  `guide, intent.read, intent.list, session.start, context.build, lease.request, operation.propose, evidence.attach, validate.run, repair.context, view.materialize, conflict.list, sync.land` (+ 범용 cwd/verbose).
  core 루프에서 `sync.land`가 checkpoint+finalize+push를 흡수함을 문서화. description 감량(1.2)과 합치면 **core 프로필 에이전트의 도구 컨텍스트는 오늘보다 작다.**
- [06](06-mcp-interface.md)을 권위 레퍼런스로 재작성: 그룹별 도구 표, `sync.land`로 끝나는 정본 루프, 토큰 예산 표(도구별 전형 응답 토큰 + 강제하는 상한), resources/prompts/알림, `verbose`/페이지네이션 관례, 프로필.
- [07 — 로드맵](07-roadmap.md) 갱신, [05](05-views-checkpoints.md)의 ContextPack 절에 구현 링크, README 에이전트 절을 5줄 루프 + `avcs mcp install`로 교체.

---

## 3. 파일 단위 변경 목록

| 파일 | 변경 |
|---|---|
| `src/mcp/server.ts` | 부팅/디스패치/워처 배선만 남김; 봉투+verbose를 CallTool 레이어에; resources/prompts/구독 등록 |
| `src/mcp/tools.ts` (신규) | 기존 24 ToolDef 이동 + 신규: sync.pull/push/land, workspace.project, context.build, decision.recall, guide, integration.submit/status (+M4: governance.status, approval.record, contention.check) |
| `src/mcp/respond.ts` (신규) | 컴팩트/verbose 직렬화, 에러 봉투, RECOVERY 맵, 목록 절단 헬퍼 |
| `src/mcp/land.ts` (신규) | land 루프 (export, SDK 없이 단위 테스트) |
| `src/mcp/context.ts` (신규) | ContextPack 빌더 + 결정적 예산기 |
| `src/mcp/guide.ts` / `prompts.ts` / `resources.ts` / `watch.ts` (신규) | 상기 |
| `src/api/repo.ts` | getRemote/setRemote, approval verdict 공개 접근자, (선택) landToHub 편의 |
| `src/hub/hubClient.ts` | integrateWithHub, 이벤트 롱폴 소비자 |
| `src/query/diff.ts` | unifiedDiff |
| `src/cli.ts` | `avcs remote`, `avcs land`(land.ts 위의 얇은 CLI 패리티), `mcp --profile` |
| `test/` | mcp-tools 확장 + 신규 mcp-sync / mcp-context / mcp-notify (기존 스타일: SDK 없이 핸들러 직접 구동) |

## 4. 롤아웃 순서

1. **M1** 토큰 기반 + guide (M) — 최우선: 이후 전부가 이 관례를 상속.
2. **M2** sync (remote S, pull/push S, **land L**, project S) — 기함. [17](17-sync-convergence.md) Phase 14와 접점: integrate 요청/응답 shape만 협상하면 병행 가능(폴백 경로는 독립 동작).
3. **M3** context.build (M/L) + decision.recall (S).
4. **M4** resources/prompts (S–M), 워처+알림 (M — 원격 절반은 17의 15.1 의존, 로컬 워처는 무의존 선행 가능).
5. **M5** 문서 + 프로필 (S/M).

## 5. 최대 리스크 결정 (기록)

**"head-moved를 절대 보지 않는다" 보장의 거처**: 클라이언트측 재시도(`sync.land`) 단독은 N 에이전트 동시성에서 스래싱(시도마다 push/pull/checkpoint, checkpoint 객체 누적); 허브 큐 단독은 로컬 모드·구 허브가 깨지고 두 트랙의 일정이 결합된다. **결론: 허브 통합 큐가 주 경로(capability 탐지, 허브별 1회 캐시), 유한 클라이언트측 pull→재reduce→재시도 루프가 상시 가용 폴백.** 두 경로가 동일한 2-결과 계약을 노출하므로 에이전트 의미는 경로 불변 — 협상할 이음새는 integrate 요청/응답 shape 하나다.

둘째 리스크(해소): 성공 응답 봉투화는 기존 소비자·테스트를 깨는 유일한 제안이었다 — **하지 않는다.** 가산 필드만.

→ 허브측 설계: [17 — 수렴](17-sync-convergence.md)
