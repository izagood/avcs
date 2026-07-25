# 17 — 수렴(Sync Convergence): 통합 큐와 라이브 동기화

> **상태: Phase 13–14 구현 완료, Phase 15 설계 합의(구현 전).** 이 문서는 병렬 에이전트에게 남아 있는 마지막 git식 고통 — "head가 움직였으니 pull 하고 다시 하세요" — 을 제거하는 Phase 13–15의 설계 결론을 기록한다. 구현 상태는 [07 — 로드맵](07-roadmap.md) 참조. 에이전트 표면(MCP)은 [18 — MCP 일급 커넥션](18-mcp-first-class.md)이 담당한다.

## 1. 배경 — 무엇이 남았나

avcs는 이미 **저작(authoring) 레이어의 rebase를 제거**했다: op는 append-only 합집합이고, reduce는 항상 전체 op-set을 3-way 병합하므로 "base가 전진했다"는 로컬 에이전트에게 사건이 아니다([16 — Workspace 스코프](16-workspace-scope.md) §6). 그러나 정밀 점검 결과 git식 루프(작업→stale→pull→재작업→재시도)가 **정확히 다음 지점에 잔존**한다:

| # | 잔존 지점 | 코드 근거 |
|---|---|---|
| 1 | **finalize CAS 재시도 퍼널** — stale `parentHead`에 `"head moved: … — pull and re-reduce first"` 거부. 패자가 수동으로 pull→re-materialize→re-checkpoint→re-finalize를 반복. N개 에이전트가 한 protected view에 몰리면 직렬화 병목 + 토큰 낭비 | `repo.finalize` (repo.ts), hub `POST /finalize` 409 (hubServer.ts) |
| 2 | **수동 폴링 동기화** — 데몬/이벤트/구독 전무. 수렴은 누군가 `pull`을 실행할 때만. remote는 영속화조차 안 됨(URL을 매번 인자로) | `hubClient.ts` (sync-cursors.json만 존재) |
| 3 | **충돌 조기 경보 부재** — 타 에이전트의 op가 내가 편집 중인 키에 도착해도 finalize 시점까지 모름 | — |
| 4 | **O(all-ops) reduce** — incremental reduce는 구현됐으나 `AVCS_INCREMENTAL`/`AVCS_COMPACT` opt-in. 다수 에이전트 읽기 처리량 🔴([09](09-usecase-coverage.md)) | `#pass1Reduce` (repo.ts) |
| 5 | **Lamport 단일 프로세스 가정** — pull로 들어온 op를 관찰하지 않고, 같은 디렉토리의 두 프로세스(CLI+MCP)가 겹치는 lamport를 발급할 수 있음 | `core/clock.ts`, [07](07-roadmap.md) 기술 부채 |

그리고 설계에 반드시 반영해야 할 **잠재 결함 두 가지**를 발견했다:

- **(A) checkpoint는 view 전체를 materialize한다.** `createCheckpoint`는 `materialize(view)` 결과(= view의 op **전체 합집합**)를 동결한다. 허브가 "view를 재reduce해서 자동 통합"하는 순진한 설계는 **push만 되고 제출되지 않은 제3자의 진행 중 op까지 protected head에 섞는다.** → 통합 단위는 반드시 `materializeAt`(frontier 인과폐포 합집합)이어야 한다.
- **(B) evidence의 treeHash 바인딩은 현재 장식이다.** `createCheckpoint`의 evidence 집계는 `forOps ∩ accepted`만 확인하고 `Evidence.treeHash`를 checkpoint의 `treeHash`와 **비교하지 않는다.** `finalize`도 `cp.evidence[k] === "pass"`만 본다. 통합 큐의 게이트가 의미를 가지려면 바인딩 실체화가 선행돼야 한다.

## 2. 원칙 (제약)

1. **pull-and-redo 금지 계약** — 에이전트에게 보이는 어떤 응답에도 "pull 후 다시 하세요"류 지시가 나타나지 않는다. 제출의 결과는 항상 네 가지 중 하나: `advanced`(전진 완료) | `conflict`(최소 수리 패킷 동봉) | `needs_evidence`(정확히 한 번의 검증 실행) | `queued`(retryAfterMs 동봉). **재작업(redo)은 어떤 경로에도 없다** — op는 append-only이므로 버려지는 작업 자체가 존재하지 않는다.
2. **결정론은 신성하다** — 같은 객체 + 같은 policy + 같은 materializer ⇒ 어느 replica에서든 같은 트리. 통합 큐의 모든 판정은 객체+Protection의 순수 함수이고, 판정 자체가 append-only 객체로 남는다(감사 가능).
3. **zero-dep** — node 표준 라이브러리만. 이벤트는 롱폴(플레인 HTTP), 워처는 폴링+`fs.watch` 보조.
4. **하위 호환** — 기존 store는 무변경으로 열린다(신규 객체 kind + 옵셔널 필드만). 구 허브/구 클라이언트는 기존 `POST /finalize` 경로로 계속 동작.
5. **reduce 불변** — [13 — Hub production](13-hub-production.md)과 동일: 이 트랙은 복제·신뢰·조율 레이어만 만지고 환원 로직은 건드리지 않는다.

---

## Phase 13 — 수렴 기반 (선행 하드닝)

### 13.1 영속 remote (S)

- `.avcs/remotes.json` — aux 파일(객체 아님, gossip 제외): `{ [name]: { url, autoSync?: boolean, freshnessMs?: number } }`. 원자적 쓰기는 store의 aux 쓰기 경로 재사용.
- `repo.addRemote(name, url, opts)` / `removeRemote(name)` / `listRemotes()`, `repo.sync(remote = "origin")` = 해당 remote에 `pullHub` + `pushHub`.
- CLI: `avcs remote add|rm|ls`, `avcs sync [remote]`. `avcs clone <url>`이 `origin`을 자동 기록.
- `sync-cursors.json`은 지금처럼 URL 키 유지(전송 최적화, 의미 불변).

### 13.2 Lamport 보정 (S)

HLC(hybrid logical clock)는 **도입하지 않는다.** 결정론은 lamport 품질에 의존한 적이 없다(reducer는 `(lamport, oid)` 정렬로 총순서를 얻고, 정책 점수는 recency를 의도적으로 배제). 고칠 결함은 둘뿐:

- **observe-on-import**: `pull`/`pullHub` 완료 후 가져온 op들의 max lamport로 `clock.observe()` — 이후 발급되는 lamport가 수입된 히스토리보다 뒤에 온다.
- **multi-process reseed**: propose 직전 op-log tail에서 관찰된 `maxLamportSeen`과 reseed(`lamport = max(clock.tick(), maxSeen + 1)`) — 같은 `.avcs`를 쓰는 CLI+MCP 두 프로세스의 겹침 발급 수정. tail은 이미 캐시되므로 O(1).

개선되는 것은 순서의 **품질**(인과 반영도)이지 정확성이 아님을 문서화한다.

### 13.3 incremental reduce 기본 ON (M)

- `#pass1Reduce`의 플래그 반전: incremental + 영속 snapshot 경로가 **기본**, `AVCS_INCREMENTAL=0`으로 opt-out. `AVCS_COMPACT` 게이트 제거(콜드 로드는 항상 시도; 손상/비호환 → 전체 reduce 폴백은 기존 처리 그대로).
- snapshot 수명주기: 주 경로 materialize 후 "영속 base 이후 ops ≥ 256"이면 view별 `withLock("snapshot:<view>")` 하에 자동 compact/persist(상각).
- snapshot 직렬화 헤더에 `MATERIALIZER_VERSION` + policy oid 스탬프 → merge 알고리즘/정책 변경 시 콜드 snapshot 자동 무효화(웜 무효화는 `NonIncrementalError`가 이미 처리).
- `AVCS_VERIFY_INCREMENTAL=1`은 CI 매트릭스 전용 잡으로 이동(핫패스 권장 해제).
- 합격 기준: **전체 계약 테스트 스위트가 기본값 ON으로 green** + 콜드 스타트/버전 bump/정책 변경 무효화 신규 테스트 + `bench/incremental-bench.ts` 전후 수치를 [11](11-incremental-reduce.md)에 기록.

통합 큐(Phase 14)는 제출마다 허브에서 reduce를 1회 수행하므로, 허브 처리량이 이 단계에 직접 의존한다 — **가장 먼저 한다.**

### 13.4 evidence treeHash 바인딩 실체화 (S/M)

- `createCheckpoint` 집계 규칙 변경: `ev.treeHash === result.treeHash`인 evidence를 우선 채택, **다른** treeHash의 evidence는 제외, treeHash가 **없는**(legacy) evidence는 수용하되 checkpoint에 기록: `Checkpoint.evidenceBinding?: Partial<Record<EvidenceKind, "bound" | "legacy">>` (옵셔널 필드 — 구 checkpoint oid 불변).
- `Protection.requireBoundEvidence?: boolean` (기본 false → 기존 테스트 무변): true면 finalize/integrate가 `legacy` 바인딩을 거부.
- 이 단계가 없으면 14.5의 evidence 모드는 이론에 그친다 — **Phase 14의 게이트 전제조건.**

---

## Phase 14 — 통합 큐 (integration queue): "pull 하고 다시 하세요"의 제거

핵심 관찰: op가 append-only 합집합이고 reduce가 결정론적이라면, **stale 제출을 거부할 이유가 없다 — 허브(또는 로컬 finalize 경로)가 합집합 재환원을 대신 하면 된다.** git의 merge queue가 "브랜치를 대신 rebase+테스트"하는 것의 avcs식 번역이되, rebase 자체가 없으므로 훨씬 싸다.

### 14.1 신규 객체 `integration` + Protection 확장 (S)

```ts
interface Integration extends BaseObject {
  type: "integration";
  view: string;
  ticketId: string;              // 멱등키 (클라이언트 지정 or sha256(view+submittedCheckpoint))
  submittedCheckpoint: string;   // 클라이언트가 제출한 draft checkpoint oid
  baseHead: string | null;       // 판정 당시의 protected head
  resultCheckpoint?: string;     // 허브가 저작한 integrated checkpoint (advanced/needs_evidence 시)
  verdict: "advanced" | "conflict" | "needs_evidence" | "rejected" | "expired";
  evidenceBinding?: "fresh" | "carried" | "waived";
  carriedApprovals?: string[];   // 승계된 approval oid들
  conflictKeys?: string[];       // verdict=conflict 시 대상 키
  reason?: string;
  by: string;
  createdAt: string;
}
```

- 모든 큐 판정의 **append-only 감사 기록**. reduce에는 불활성(checkpoint처럼 투영에 관여하지 않음).
- hub `authRequirement`: `integration`은 push **거부**(허브/로컬 finalize 경로 저작 전용; replica는 일반 pull로 수신).
- Protection 확장(옵셔널 → 하위 호환): `integration?: { evidenceMode: "fresh" | "carry-disjoint" | "carry-always"; carryApprovals?: boolean; reserveTtlMs?: number }`.

### 14.2 `repo.submitIntegration()` — 핵심 알고리즘 (L)

허브 전용이 아니라 **repo API**다 — 허브 없는 로컬 다중 프로세스 finalize 퍼널도 함께 죽인다.

```
submitIntegration({ view, checkpoint, by, ticketId?, signWith? })
  → { verdict: "advanced";       head; integration }
  | { verdict: "conflict";       packet; integration }
  | { verdict: "needs_evidence"; integratedCheckpoint; treeHash; requiredChecks; missingLocally: oid[]; ticketId }
  | { verdict: "rejected";       reason }
  | { verdict: "queued";         behindTicket; retryAfterMs }
```

`store.withLock("finalize:<view>")` 하에서 (기존 mkdir 락이 곧 직렬화기 — v1에서 별도 큐 자료구조를 만들지 않는다; FIFO 티켓 저널은 경합 측정 후 후속):

1. **멱등성** — ref `integration:<view>:<ticketId>` 조회. 기존 티켓이면 기록된 verdict를 그대로 반환(재제출 안전).
2. **예약 검사** — 다른 티켓의 active `needs_evidence` 예약(`.avcs/queue/<view>.json`, TTL)이 있으면 `queued` + `retryAfterMs`(지터 포함).
3. **causal-complete** — `#missingCausalDeps(cp.headOps)` 재사용. 누락 시 `rejected` + 누락 oid 목록.
4. **통합 환원** — `F = frontier( closure(currentHead.headOps) ∪ closure(submitted.headOps) )`를 **`materializeAt` 경로로** reduce. 절대 `materialize(view)`가 아니다(§1-(A): 미제출 제3자 op 격리). 결정론에 의해 같은 객체를 가진 어느 replica든 같은 트리를 재현한다.
5. **충돌 판정** — 제출 델타와 교차하는 `needs_human`/파일 충돌이 있으면 verdict `conflict` + **최소 수리 패킷**: 키별 상대 op oid/actor/purpose, base blob oid, `detectFileConflicts`의 ConflictRegion, 그리고 **`recallDecisions(key)` 결정 메모리 동봉** — 에이전트가 과거 선례로 L2급 겹침을 스스로 결정 제안까지 끌고 갈 수 있게 한다(L4 인간 게이트는 불변). "pull 하고 다시 하세요"를 이 패킷이 대체한다.
6. **게이트** — 역할(`finalizeRole`), 승인(제출 checkpoint에 바인딩된 approval을 integrated checkpoint로 **승계**, `carryApprovals !== false`일 때; GitHub이 PR approval을 merge commit과 무관하게 세는 것과 동형 — `carriedApprovals`로 기록), waiver, required checks(모드는 14.5).
7. **전진** — integrated `Checkpoint` 저작(headOps=F, treeHash=4의 결과, evidence는 14.5 규칙) → `setRef("head:<view>")` → `Integration{verdict:"advanced"}` 기록 → 이벤트 waiter wake. **fast-forward**(현 head ⊆ closure(submitted))는 기존 finalize 의미로 단락 + `fresh` 바인딩.

### 14.3 hub 엔드포인트 (M)

- `POST /integrate` — body `{ view, checkpoint, by, ticketId?, sig }`. gated hub는 `integrate:<view>:<checkpoint>:<ticketId>` 서명 검증(기존 finalize 서명 패턴). verdict → HTTP 매핑: 200 `advanced` / 409 `conflict`(패킷 동봉) / 428 `needs_evidence` / 202 `queued` / 422 `rejected`. audit·rate-limit 재사용.
- `GET /integrations/:ticketId?view=` — verdict 멱등 조회(폴링용).
- 기존 `POST /finalize` **불변**(구 클라이언트). `HUB_PROTOCOL_VERSION` bump(가산적), `GET /version`이 `integrate: true` 광고 → 클라이언트 capability 탐지.
- `needs_evidence` 예약은 `.avcs/queue/<view>.json`으로 영속 → 허브 재시작에도 진행 중 티켓 존중.

### 14.4 클라이언트 / CLI / MCP (M)

- `hubClient.integrateWithHub(localDir, hubUrl, args)`: 델타 push → `POST /integrate` → `conflict`/`needs_evidence`면 `missingLocally` oid**만** pull → 구조화된 verdict 반환. **재시도 루프 없음, 재제안 없음, 재작업 없음.** 에이전트의 후속 행동은 최대 "정확히 그 integrated tree에서 검증 1회 실행 → evidence 첨부 → 같은 티켓 재제출".
- `repo.integrateHub(remoteOrUrl, args)` facade: `/version`에 `integrate`가 없으면 legacy `finalizeOnHub` + pull 재시도 루프로 **폴백**(구 허브 호환).
- CLI `avcs submit [--view main] [--remote origin]`. MCP `avcs.integration.submit` / `avcs.integration.status` — 도구 설명에 계약을 명시: "절대 pull-and-redo 하지 말 것; 반환된 패킷에 따라 행동".

### 14.5 evidence 바인딩 모드 (M) — 최대 리스크 결정

head가 움직인 뒤 integrated treeHash ≠ 제출 treeHash라면, 옛 evidence는 새 트리를 **증명하지 않는다.** 검토한 선택지와 결론:

| 모드 | 규칙 | 평가 |
|---|---|---|
| **`carry-disjoint`** (**기본, 확정**) | 두 델타(`closure(head)∖closure(cp)`와 `closure(cp)∖closure(head)`)의 `keysOf` 집합이 **서로소** + 신규 충돌 0 + 교차 AutoDecision 0이면, 제출 checkpoint의 bound evidence를 승계. 승계 사실은 Integration(`evidenceBinding:"carried"`)과 checkpoint 양쪽에 기록 | "독립적으로 green인 두 브랜치의 머지"에서 git 사용자가 이미 감수하는 리스크와 동일하되, (a) 서로소성이 기계적으로 검사되고 (b) 기록되고 (c) opt-out 가능 |
| `fresh` | head가 움직였으면 항상 2단계: 허브가 integrated checkpoint + TTL 예약을 만들고 `needs_evidence` 반환 → 에이전트는 델타 oid pull → `materializeAt`로 **동일 트리를 로컬 재현**(결정론) → `validate.run`(treeHash 자동 스탬프) → evidence push → 같은 티켓 재제출 → 허브가 `evidence.treeHash === 예약 treeHash` 확인 후 전진 | GitHub merge queue 수준 엄격성. 비용은 통합당 검증 1회 — **재병합/재제안이 아니라 검증만** |
| `carry-always` | 항상 승계 | "충돌은 없는데 버그"(의미 충돌) 리스크를 그대로 수용. 명시적 admission이 있을 때만 권장 |
| (허브 재실행 훅) | `startHub`의 embedder 옵션 `opts.verify?: (dir, checkpoint) => Promise<Evidence[]>` | 러너 인프라·시크릿을 허브에 요구하므로 **기본이 될 수 없음**. `fromUntrustedRunner` 위험도 동일 적용 |

**하지 말아야 할 것**: 재실행 인프라 없이 `fresh`를 기본으로 삼는 것 — 그 순간 이 레이어가 죽이려는 재시도 퍼널이 부활한다. 승계는 절대 조용히 이루어지지 않는다(양쪽 기록) — 정직성은 차단 게이트가 아니라 감사 추적에 둔다.

### Phase 14 계약 테스트

- `test/integrate-queue.test.ts` — 실제 허브에 N=8 동시 제출: 전원 `advanced` 또는 conflict 패킷 수신, **클라이언트측 pull-redo 재시도 0회**; 최종 head가 모든 replica에서 동일 treeHash로 환원; 티켓마다 Integration 감사 객체 존재; 재제출 멱등.
- `test/integrate-evidence.test.ts` — 서로소 델타 승계 / 겹침 + `carry-disjoint` → `needs_evidence` / `fresh` 2단계 happy path / 예약 TTL 만료 → `expired` 후 다음 티켓 진행 / `requireBoundEvidence` 상호작용.
- `test/integrate-conflict-packet.test.ts` — 겹치는 edit_file hunk → 패킷에 region + 결정 메모리 동봉; `recordDecision` 후 재제출로 전진.
- `test/hardening-hub-finalize-cas.test.ts` 확장 — legacy `/finalize` 의미 불변. determinism-property 하네스 재실행(reducer diff 0 확인).

---

## Phase 15 — 라이브 수렴 (live convergence)

### 15.1 `GET /events` 롱폴 (M)

- `GET /events?since=<objlogCursor>&timeoutMs=30000`: 신규 oid가 있으면 즉시 `{ cursor, oids, refs }`(refs = 거버넌스 ref 전체 맵 — 클라이언트가 diff해서 head 전진 감지), 없으면 응답 파킹. 모든 성공 mutation(`POST /objects`/`/integrate`/`/finalize`/redaction)이 waiter를 깨움. 타임아웃 → `{ cursor, oids: [] }` 하트비트. waiter 상한(기본 256, 초과 503) + `res.on("close")` 정리.
- **SSE가 아니라 롱폴**인 이유: zero-dep, 프록시 친화, 기존 hubClient의 fetch 루프 스타일과 동형, 그리고 objlog 커서를 `/sync?since=N`과 **공유**(커서 의미 하나).

### 15.2 sync 데몬 + freshness 창 (M)

- `avcs sync --watch [remote]`: 루프 = 롱폴 → 커서 incremental pull → redaction 적용 → 거버넌스 refs 채택 → contention 검사(15.3) → 구조화 로그. 에러 시 backoff. `withLock("syncd")`로 repo당 단일 인스턴스.
- **락 heartbeat**(`LockOptions.heartbeatMs`): 데몬처럼 오래 잡는 홀더는 대기자의 `staleMs`를 넘겨 **살아있는 락이 회수**되므로, 보유 중 owner 스탬프를 주기적으로 갱신한다. 크래시하면 갱신이 멎으니 기존 stale-reclaim은 그대로 동작. 갱신 쓰기는 **체인으로 직렬화하고 release가 await 한다** — `clearInterval`은 이미 떠 있는 tick을 막지 못해, 그 `rename`이 제거 중인 락 디렉터리에 `owner`를 되살리면 `rmdir`이 `ENOTEMPTY`로 실패하고(=`finally`에서 던져져 **성공한 임계 구역의 반환값을 대체**), 신선한 스탬프를 안은 락이 남아 대기자를 `staleMs` 동안 막는다.
- **freshness on materialize**: `autoSync: true`인 remote가 있으면 materialize가 `lastSyncAt`(aux 타임스탬프)을 확인, `freshnessMs` 초과 시 **백그라운드** sync 발화 — stale-while-revalidate. **읽기 경로는 절대 차단하지 않는다**(materialize는 처리량 임계 경로). blocking이 필요한 호출자(제출 직전 등)는 `repo.syncIfStale()`.
- **quiesce 규약**: 백그라운드 revalidate는 fire-and-forget이되 **핸들 없이 던지지 않는다** — `repo.settleBackgroundSync()`가 in-flight 실행을 await한다(유휴면 즉시 resolve, 절대 reject 안 함). 필요한 이유: revalidate는 호출자가 자연스럽게 기다릴 만한 **관측 효과보다 오래 산다**(pull이 객체를 안착시킨 뒤에도 push와 `last-sync.json` 스탬프 쓰기가 남는다). 그래서 repo 디렉터리를 정리하는 쪽(데몬 종료, 테스트 teardown)은 반드시 settle 후에 지운다 — 아니면 `rmdir`이 in-flight `.avcs` 쓰기와 경합해 `ENOTEMPTY`가 난다. 데몬의 `runSyncWatch`가 반환 프로미스로 같은 역할을 하는 것과 대칭.

### 15.3 충돌 조기 경보 (M)

- `repo.contention({ keys? | sessionOid?, line? })`: 각 키에 대해 **entity index**(`readEntityIndex`, O(ops-on-key) — reduce 불필요)로 "내 인과폐포 밖 + 타 actor + 최신 환원에서 superseded/rejected 아님"인 op들과, 겹치는 scope의 active lease holder를 반환: `{ key, theirs: [{op, actor, lamport, purpose}], leaseHolders }`. lease는 일반 객체로 gossip되므로 15.2와 결합하면 **기계 간** 조기 경보가 성립.
- 배선: `proposeEdit`/`proposeOperation`에 옵셔널 `warnContention` — 반환 타입 불변(경보는 응답 가산 필드/로그/메트릭); MCP `avcs.operation.propose` 응답에 `contentionWarnings` 가산; 신규 MCP `avcs.contention.check`; watch 데몬이 **수신** op의 키 교차 시 경보 방출("에이전트 B의 op가 네 키 K에 도착했다" 신호).
- CLI `avcs status`에 contention 표시.

### Phase 15 계약 테스트

`test/hub-events.test.ts`(append 시 wake / 타임아웃 하트비트 / head 전진이 refs에 보임 / waiter 상한), `test/sync-watch.test.ts`(단일 인스턴스 락, stale-while-revalidate 비차단, **settle이 스탬프 쓰기까지 끝난 뒤에만 resolve**, 유휴 settle은 no-op), `test/contention-warning.test.ts`(타 actor 동시 op 경보, lease holder 경보, 자기 op 무경보).

---

## 3. 하위 호환 요약

| 대상 | 보장 |
|---|---|
| 기존 `.avcs` store | 무변경으로 열림 — 신규 객체 kind + 옵셔널 필드 + aux 파일(구버전은 무시)만 |
| 구 클라이언트 | `POST /finalize` 그대로 |
| 구 허브 | 클라이언트가 `/version` capability 탐지 후 legacy finalize+pull 루프로 폴백 |
| reducer | 무변경 — determinism-property 하네스가 각 PR에서 재실행됨 |
| 기존 계약 테스트 | 전부 green 유지(13.3 기본값 반전 포함) |

## 4. 이 설계가 지우는 것 / 남기는 것

**지운다**: stale finalize 거부→수동 pull→재작업 루프(제출은 항상 판정으로 끝난다), 수동 폴링 수렴(이벤트+데몬+freshness), finalize 시점에야 발견되는 충돌(조기 경보), O(all-ops) 상시 재환원(기본 incremental).

**남긴다(의도적으로)**: 같은 키를 진짜로 겹쳐 쓴 L4급 충돌의 **인간 결정 게이트** — 단, 결정 메모리를 동봉한 최소 패킷으로 도착하므로 에이전트가 선례 기반 결정 제안까지 준비할 수 있다. protected head의 선형화 자체(직렬화는 correctness다 — 퍼널이 문제였지 직렬화가 문제가 아니다).

→ 에이전트 표면: [18 — MCP 일급 커넥션](18-mcp-first-class.md)
