# 27 — 파생 상태 읽기: 복제하지 않는 클라이언트가 판정과 트리를 묻는다

> **상태: 설계 (구현 전).** [izagood/avcs-server#7](https://github.com/izagood/avcs-server/issues/7)이
> 제기한 "파생 상태(`OperationStatus`)를 읽을 선택 엔드포인트"의 명세다. 그 이슈의 결론은 맞고
> 이유 하나는 틀렸다 — §1.3이 그것을 바로잡는다. [26 — 서버 프로토콜](26-hub-protocol.md)이
> "발명이 아니라 기록"이므로 이 문서가 먼저 있고, 참조 구현이 따르고, 그 다음 26이 기록한다.
> **26이 계약이고 27은 이유다.** 구현이 끝나면 와이어 형태는 26 §6-4로 옮겨 적고 이 문서는
> 근거로 남는다.

## 1. 문제

### 1.1 상태는 저장되지 않고 계산된다

`src/objects/types.ts`:

```ts
// Operation lifecycle status is *not* stored on the immutable op. It is derived
// from the presence of evidence/decision objects + policy at materialization time.
export type OperationStatus =
  | "proposed" | "validating" | "accepted" | "rejected"
  | "superseded" | "needs_decision" | "quarantined";
```

op 가 `accepted` 인지 `needs_decision` 인지는 **어느 객체에도 적혀 있지 않다.** `reduce()` 가
op·evidence·decision·intent·policy 를 받아 계산한다. 이것은 결함이 아니라 설계다 —
[00](00-overview.md) 의 정의 `state = reduce(base, operationDAG, decisions, policy, materializer)`
그대로다.

### 1.2 그래서 서버에 붙을 수 있는 클라이언트는 한 종류뿐이다

서버는 객체를 나눠 준다. `/sync` · `/events` 의 응답은 `{ cursor, oids, refs }` 이고, 어느
엔드포인트도 `OperationStatus` 를 모른다. 그래서 "지금 결정 대기 중인 제안이 몇 개냐" 한 줄을
알려면 **반드시** 둘 다 해야 한다:

1. 저장소 전체를 로컬로 복제하고 (`/have` → `/objects/fetch` 반복)
2. `@izagood/avcs` 코어를 의존해 `reduce()` 를 직접 돌린다

`avcs` CLI 는 어차피 둘 다 하니 문제가 없다. 못 하는 쪽이 문제다:

- **웹 UI** — 브라우저가 저장소 전량을 받아 환원할 수는 없다
- **봇·CI·알림·읽기 전용 통합** — 상태 한 줄을 위해 전량 복제 + 코어 의존
- **다른 언어 클라이언트** — 코어가 TypeScript 라 `reduce()` 를 부를 방법 자체가 없다.
  [24](24-canonical-interop.md) 가 oid 를 언어 중립으로 고정했지만 **판정은 아직 TypeScript 안에만** 있다

즉 지금 서버에 붙을 수 있는 것은 **avcs 전체를 품은 복제본**만이다. 가볍게 물어보는 길이 없다.

### 1.3 원래 이슈가 든 이유와 실제 이유

avcs-server#7 은 이렇게 썼다: *"정책이 바뀌면 클라이언트마다 따로 갱신해야 하고, 그 사이 서버와
클라이언트가 서로 다른 상태를 말한다."* **이것은 사실이 아니다.**

- policy 는 `policy` ref 로 저장되고 `/refs` 로 배포되며 클라이언트가 pull 에서 채택한다
  (`hubClient` 가 `policy` · `member:` · `protection:` · `head:` 를 받아들인다 — [26](26-hub-protocol.md) §5)
- 리듀서 머리말이 보증한다: *같은 객체 + 같은 정책 + 같은 머티리얼라이저 ⇒ 어느 복제본에서도 동일 트리*

복제본 사이의 어긋남은 정책 미전파가 아니라 **sync lag 뿐**이고, 그 lag 은 서버가 계산해 준
답도 도착할 즈음 똑같이 낡는다. "판정이 갈린다"는 이 엔드포인트의 이유가 될 수 없다.

실제 이유는 §1.2 다: **복제하지 않는 클라이언트가 존재할 수 없다.** 이 문서는 그것을 고친다.
그리고 §3.6 이 틀린 이유를 스펙 차원에서 닫는다 — 이 응답은 권위가 아니다.

## 2. 이 설계가 밟고 서 있는 사실 (이미 존재하는 부품)

새로 계산하는 것이 없다. 필요한 재료가 **이미 다 있다**:

| 부품 | 위치 | 무엇을 주나 |
|---|---|---|
| `ReductionResult` | `src/reducer/reducer.ts` | `statuses` · `conflicts` · `fileConflicts` · `blockedReasons` · `headOps` · `treeHash` · `tree` · `synthBlobs` · `untrustedEvidence` — 응답의 전부 |
| `Repo.materialize(view)` | `src/api/repo.ts` | `ReductionResult` 를 그대로 반환. 지속 스냅샷 시드 + op-log 프리필터 + 증분 환원이 이미 안에 있다 |
| 참조 구현의 `Repo.open(repoDir)` 패턴 | `src/hub/hubServer.ts` `/finalize` · `/integrate` | 판정을 코어에 위임하는 **기존 방식**. 새 의존 방향이 아니다 |
| `cursor` + `refs` 스냅샷 | `hubServer` `/events` 응답 ([26](26-hub-protocol.md) §6-3) | 환원 입력의 지문 재료 — ETag 가 여기서 나온다 (§3.4) |
| `MATERIALIZER_VERSION` | `src/reducer/policy.ts`, `/version` 광고 | 같은 입력이 같은 트리를 내는지의 근거 |
| `GET /objects/:oid` — 필수 | [26](26-hub-protocol.md) §4-3 | 트리 지도의 blob 을 **필요한 것만** 가져오는 기존 경로 |
| `synth` 목록 | `src/api/repo.ts` (checkpoint 헤더) | 합성 oid 를 따로 나열하는 전례 |
| 능력 협상 · 폴백 | [26](26-hub-protocol.md) §0 · §3 · §9 | 선택 엔드포인트 + 플래그 하나로 들어가는 길 |

즉 **`materialize` → 직렬화 → 캐시** 사슬만 잇는다. 리듀서·저장소·정책은 건드리지 않는다.

## 3. 설계

### 3.1 `GET /reduced?view=<name>` — 판정과 트리 지도

```
GET /reduced?view=main
If-None-Match: "3f9a…"          (선택)
```

```json
{
  "view": "main",
  "cursor": 1421,
  "materializer": "avcs-text3/0.3.1",
  "treeHash": "9f2c…",
  "statuses": { "operation_ab12…": "accepted", "operation_cd34…": "needs_decision" },
  "headOps": ["operation_ab12…"],
  "conflicts": [],
  "fileConflicts": [],
  "blockedReasons": { "operation_ef56…": "requiredCheck `test` unsatisfied" },
  "untrustedEvidence": 0,
  "tree": { "src/a.ts": "blob_1a2b…", "README.md": "blob_3c4d…" },
  "synth": ["blob_1a2b…"],
  "treeOmitted": false
}
```

- `view` 생략 시 `main` (`Repo.materialize` 의 기본값과 같다). 없는 view 는 `404`.
- `cursor` 는 `/sync` · `/events` 와 **같은 커서**다 — 이 판정이 objlog 의 어느 시점 것인지.
- `statuses` 는 이 view 가 보는 op 전량, 값은 §1.1 의 일곱 중 하나. `conflicts` · `fileConflicts`
  는 `ReductionResult` 의 같은 이름 타입 그대로(`Conflict` 는 `id` · `key` · `kind` · `options[]` ·
  `recommendedOp` · `reason`). `blockedReasons` 는 op oid → 이유.
- `tree` 는 경로 → blob oid. **내용은 없다.** 내용은 `GET /objects/:oid` 로 가져온다 — 화면에
  보이는 파일만.
- `synth` ⊂ `tree` 의 값. **이 oid 들만** `/objects/:oid` 에 없다 (§3.2).
- `treeOmitted: true` 면 `tree` 와 `synth` 가 빠져 있다. **판정 필드는 그대로다** (§4.1).
- 응답에는 항상 `ETag` 가 실린다. `If-None-Match` 가 일치하면 `304`, 본문 없음 (§3.4).
- `404` — 없는 view, 또는 이 서버가 이 평면을 서빙하지 않는다 ([26](26-hub-protocol.md) §0 의 모양).

### 3.2 `GET /reduced/blob/:oid?view=<name>` — 합성 blob

3-way 텍스트 병합의 결과는 **어느 저장된 blob 도 아니다.** 리듀서가 `synthBlobs` 로 바이트를 들고
있고, 그 바이트는 파생 캐시(`.avcs/snapshot/<view>.cbor`, 웜 캐시)에만 산다. 합성 oid 는
`blob_${sha256(내용).slice(0, 32)}` 로 만들어져 **저장된 blob oid 와 모양이 같다** — 클라이언트가
스스로 구별할 수 없으므로 §3.1 이 `synth` 로 알려 준다.

저장소에 넣어 해결하지 않는다. `Repo.#scrubDerivedCaches` 가 이유를 적어 두었다 — 합성 바이트는
redaction 시 함께 지워야 하는 **평문**이고, 읽기 요청이 저장소를 변형해서도 안 된다. 그래서
동반 경로 하나가 필요하다:

```
GET /reduced/blob/blob_1a2b…?view=main
If-Match: "3f9a…"                 (권장)
```

```json
{ "oid": "blob_1a2b…", "data": "<base64>", "encoding": "base64" }
```

- 그 view 의 **현재** 환원에 속한 합성 oid 일 때만 `200`.
- 저장된 blob 은 여기서 `404` — `/objects/:oid` 로 가라. 두 경로는 겹치지 않는다.
- `If-Match` 가 현재 ETag 와 다르면 `412` — 환원이 바뀌었으니 `/reduced` 를 다시 읽으라는 뜻이다.
  `404` 하나에 "저장된 blob 이다" 와 "더는 합성이 아니다" 를 겹쳐 싣지 않는다.
- 합성 oid 는 내용 해시라 **같은 병합 결과면 환원이 바뀌어도 oid 가 그대로다.** 클라이언트가
  캐시해도 안전하다.

### 3.3 능력 광고 — `protocol` 은 5 를 유지한다

`/version` 에 두 필드가 늘어난다:

```json
{ "reduced": true, "reducedTreeMaxEntries": 50000 }
```

| 필드 | 뜻 | 없거나 false 면 |
|---|---|---|
| `reduced` | 파생 상태 읽기(`/reduced` · `/reduced/blob`)를 서빙한다 | 복제하는 클라이언트는 **아무것도 바꾸지 않는다**. 얇은 클라이언트는 이 서버에서는 못 한다고 판단한다 |
| `reducedTreeMaxEntries` | `tree` 를 실어 주는 최대 항목 수 | `reduced` 가 참이면 반드시 있다 |

`protocol` 은 **5 그대로다.** [26](26-hub-protocol.md) §9: *"능력을 더하는 변경은 버전을 올리지
않는다. `GET /version` 의 플래그로 광고하고, 모르는 클라이언트는 폴백한다."* `hubServer.ts` 의
v3~v5 주석은 §9 가 규칙을 고정하기 **전** 이력이다. 규칙은 문서다.

### 3.4 ETag — 환원 입력의 지문

환원의 출력은 입력이 정하고, 입력은 전부 서버가 이미 아는 값이다:

```
ETag = "<sha256hex(canonicalize({
          v: 1,
          view,
          cursor,                      objlog 길이 — /sync 와 같은 뜻
          materializer,                MATERIALIZER_VERSION
          treeMaxEntries,              §4.1 — 상한이 바뀌면 treeOmitted 가 바뀐다
          refs                         listRefs() 에서 integration: · git: 접두를 뺀 전량
        }))[0:32]>"
```

**왜 refs 를 (거의) 전량 넣는가.** 환원에 닿는 ref 가 여럿이다 — `policy`, `view:<name>`
(view 정의 자체가 바뀔 수 있다), `line:<name>`, `workspaces.landed`, `protection:<view>`, 그리고
**`member:<keyId>`** — 서명 신뢰 게이트가 evidence 를 버리는지가 멤버십에 달렸다. 포함 목록을
고르면 하나를 빠뜨리고, 빠뜨린 무효화는 **틀린 304** 가 된다. 전량은 보수적이다 — 무관한 변경에
과무효화하지만 무효화를 놓치지 않는다.

**왜 두 접두는 빼는가.** `integration:<view>:<ticket>` 과 `git:<sha>` 는 통합·브리지마다 하나씩
영원히 늘고, 둘 다 `materialize` 의 입력이 아니다. 넣으면 ETag 계산이 통합 이력에 비례한다.
제외 목록은 포함 목록과 달리 안전하다 — 빠뜨려도 과무효화일 뿐이다.

ETag 는 클라이언트에게 **불투명**하다. 계산하지 않고 되돌려 준다. 강한 ETag 다 — 같은 입력은
같은 본문 바이트를 낸다(정규 직렬화, [24](24-canonical-interop.md)).

### 3.5 서버 캐시 — 변경당 환원 1회

서버는 view 별로 마지막 `(etag → 본문)` 하나를 든다. 요청 흐름:

1. ETag 계산 — objlog 길이와 refs 를 읽는다. `/events` 가 매 폴마다 하는 일과 같다
2. 클라이언트 `If-None-Match` 일치 → **`304`, 환원 없음**
3. 캐시의 etag 일치 → **캐시 본문, 환원 없음**
4. 불일치 → `Repo.materialize(view)`, 직렬화, 캐시 교체

얇은 클라이언트 N 대가 폴링해도 환원은 **변경당 1회**다. 캐시는 메모리에만 있고 재시작에 사라진다
— 정확성은 캐시에 의존하지 않는다(콜드 스타트는 4번 경로 한 번이다).

### 3.6 이 응답은 권위가 아니다

이 응답은 **어느 복제본이든 같은 입력에서 계산할 값**이다. 서버는 그중 하나를 계산했을 뿐이다.

- 복제하는 클라이언트는 **자기 환원을 우선한다.** 서버의 `statuses` 로 로컬 판정을 덮어쓰지 않는다.
  둘이 다르면 그것은 sync lag 이거나 `materializer` 불일치이고, 둘 다 진단할 값이 응답에 있다
  (`cursor`, `materializer`).
- 얇은 클라이언트는 이 응답을 **그대로 표시**한다. 그것이 이 엔드포인트의 존재 이유다.
- 서버가 판정을 **바꿀 수는 없다** — `reduce()` 는 순수 함수고 서버는 그것을 부를 뿐이다.
  [26](26-hub-protocol.md) §6-2 가 통합 판정에 요구한 것("객체 + Protection 의 순수 함수")과 같은 성질이다.

avcs 는 그 자체로 버전관리를 완결한다. 이 엔드포인트는 그 완결성을 **밖에서 읽는 창**이고,
완결성을 서버로 옮기는 것이 아니다.

### 3.7 폴백

`reduced` 광고가 없거나 `/reduced` 가 `404` · `405` · `501` 이면:

- `hubClient` 는 `null` 을 돌려 준다. 부르는 쪽이 복제 + 로컬 환원으로 간다 — **지금과 같다**
- 컨포먼스 스위트는 그 축을 **건너뛴다** — 실패가 아니다 (§5)

## 4. 크기와 비용 — 이 설계의 가장 무거운 부분

### 4.1 `tree` 는 잘라 주지 않는다 — 뺀다

`tree` 는 유일하게 **파일 수**에 비례하는 필드다. `reducedTreeMaxEntries` 를 넘으면:

- `tree` 와 `synth` 를 **빼고** `treeOmitted: true` 로 `200`
- 판정 필드는 전부 그대로

`/objects/fetch` 의 `truncated` 처럼 잘라 주지 않는 이유: 잘린 객체 목록은 **부분**이지만 잘린
트리는 **틀린 트리**다 — 없는 파일이 "삭제됨" 으로 읽힌다. 부분성을 안전하게 말할 수 없으면
말하지 않는 것이 맞다. `413` 으로 거절하지 않는 이유: 판정만 필요한 봇·알림이 트리 크기 때문에
아무것도 못 받을 이유가 없다. 트리가 필요한 클라이언트는 `treeOmitted` 를 보고 복제로 내려간다
— §0 의 폴백과 같은 모양이다.

참조 구현 기본값은 50,000 이다. 서버는 자기 값을 정하고 **광고**한다 — `batchMaxBytes` 를
광고하는 이유와 같다: 실패로 배우게 하지 않는다.

### 4.2 `statuses` 는 O(ops) 다 — 그리고 그것은 §4-1 이 이미 수용한 크기다

`statuses` 는 view 가 보는 op 전량이고, 오래된 저장소에서는 대부분 `accepted` · `superseded`
이력이다. 상한을 걸지 않는다. 근거:

- `GET /have` 는 **필수** 엔드포인트이면서 보유 oid 전량을 상한 없이 낸다([26](26-hub-protocol.md) §4-1).
  op 수 ≤ oid 수이므로 `statuses` 는 프로토콜이 이미 받아들인 크기 안에 있다
- ETag/304 가 반복 비용을 지운다. 첫 응답의 크기만 남는다

다만 avcs-server#7 의 실제 용례("제안 목록")는 미결 op 만 필요하다. `?statuses=open` 같은
필터는 **이 문서의 범위 밖**으로 남긴다 — 응답 형태를 바꾸지 않고 가산할 수 있는 것이라
지금 정하지 않는다.

### 4.3 ETag 계산 비용

`readObjLog()` 길이 + `listRefs()` 다. `/events` 가 이미 매 폴마다 같은 값을 읽으므로 **새로운
비용은 아니다.** §3.4 의 제외 목록이 refs 쪽 성장을 막는다. objlog 는 길이만 필요하므로 저장
백엔드가 O(1) 로 답할 수 있으면 그렇게 한다 — 이 문서가 강제하지는 않는다.

## 5. 적합성 — 사다리 밖 축

[26](26-hub-protocol.md) §11 의 레벨은 `core → sync → governance → queue` **누적** 사다리다.
`reduced` 는 어디에 놓아도 틀어진다:

- 사다리 끝에 놓으면 — 통합 큐 없는 읽기 전용 미러는 `reduced` 에 도달할 수 없다. 그런데
  "미러 + 웹 UI" 는 이 설계의 **첫 번째 수혜자**다. §0 위반
- `queue` 앞에 놓으면 — 오늘 `queue` 를 통과하는 서버가 내일 `governance` 로 **강등**된다

문제는 `reduced` 가 아니다. 누적 사다리는 "능력은 서로 독립" 이라는 §0 과 본래 긴장 관계이고,
독립 능력이 처음 들어오면서 드러났을 뿐이다. 그래서 §11 에 **사다리 밖 축**을 정의한다:

- **확장(extension)** — 레벨 순서에 참여하지 않고, 자기 플래그가 참일 때만 재는 단언 묶음
- `applicableLevels()` 옆에 `applicableExtensions()`. 광고가 없으면 건너뛰고 로그에 남긴다
  (`(skip reduced: 광고 없음)`)
- 배지는 레벨 + 확장으로 읽는다: `queue +reduced`, `core +reduced`

`test/conformance/target.ts` 의 `LEVELS` · `LEVEL_CAPS` · `LEVEL_PROBES` 옆에 `EXTENSIONS` 테이블
하나가 늘어난다. 다음 독립 능력은 그 테이블에 한 줄이다.

`reduced` 축이 재는 것:

| 단언 | 잡아내는 서버 |
|---|---|
| `/version` 에 `reduced: true` 면 `reducedTreeMaxEntries` 가 양의 정수다 | 상한을 광고하지 않는 서버 |
| `/reduced` 의 `treeHash` 가 **같은 객체로 로컬 환원한 treeHash 와 같다** | 다른 환원기를 돌리는 서버, 정책을 무시하는 서버 |
| `cursor` 가 `/sync` 의 커서와 같은 값이다 | 커서 의미를 둘로 만든 서버 |
| `ETag` 가 있고, 되돌려 주면 `304` 다 | 캐시할 수 없는 서버 |
| 객체를 하나 push 하면 `ETag` 가 바뀐다 | 낡은 답을 주는 서버 |
| `tree` 가 있으면 `treeOmitted: false` 이고 항목 수 ≤ 광고한 상한이다 | **잘라 주는** 서버 |
| `synth` 의 oid 는 `/objects/:oid` 에서 `404`, `/reduced/blob/:oid` 에서 `200` 이다 | 합성 blob 을 저장소에 넣는 서버 |
| `tree` 의 비-`synth` oid 는 `/reduced/blob/:oid` 에서 `404` 다 | 두 경로를 겹치는 서버 |
| 없는 view 는 `404` 다 | 빈 판정을 `200` 으로 주는 서버 |

각 단언에 대해 **일부러 어긋난 서버**를 세워 스위트가 그것을 잡는지 검증한다
(`test/conformance/detects-nonconforming.test.ts` 의 기존 방식).

## 6. 구현 순서 — 두 저장소

**1단계 — avcs (이 저장소), 한 PR:**

1. [26](26-hub-protocol.md) — §0 "나머지 아홉" 을 "나머지는 전부 선택이다" 로(`/landed` 이후 이미
   틀린 숫자다) · §3 표에 `reduced` · `reducedTreeMaxEntries` · §6-4 신설(§3.1–3.2 의 와이어) ·
   §10 표에 두 행("`tree` 를 잘라서 준다", "합성 oid 를 `/objects/:oid` 에 두거나 찾게 한다") ·
   §11 에 확장 축(§5)
2. `src/hub/hubServer.ts` — 두 라우트 + ETag + view 별 캐시. `Repo.open(repoDir).materialize(view)`,
   `/finalize` · `/integrate` 와 같은 패턴. `/version` 에 두 플래그. `HUB_PROTOCOL_VERSION` 은 **불변**
3. `src/hub/hubClient.ts` — `hubReduced(base, view, signer?)` · `hubReducedBlob(base, view, oid, etag?)`.
   `hubCaps` · `hubHave` 와 같은 이름 규칙. 미지원이면 `null`
4. `test/conformance/` — `EXTENSIONS` 테이블 · `reduced` 단언 · 비준수 탐지 대응
5. `RELEASES.md` — `feat:` 항목. 환원기·객체 형식은 바뀌지 않으므로 결정론 절은 해당 없음

릴리스 후 **2단계 — avcs-server**, 별도 사이클:

- `ReductionBackend` SPI (`reduce(view)` · `synthBlob(view, oid)`). `JudgementBackend` 와 **독립** —
  파일시스템 `Repo` 가 없는 배포는 둘 다 못 하지만, 있는 배포가 판정 없이 파생 상태만 서빙하는
  조합은 1급이어야 한다
- 엔진 라우트 + ETag + 캐시, `/version` 에 두 플래그 — 그리고 지금 누락된 `materializer`
- 읽기 게이트는 기존 `verifyRead` 그대로. 새 인증 개념 없음
- 레벨 테스트에 확장 축

## 7. 검증 매트릭스

| # | 케이스 | 기대 |
|---|---|---|
| **R1** | `reduced` 미광고 서버에 대한 `hubClient` | `null`. 복제 경로 **무변경** |
| **R2** | 같은 객체 집합 — 서버 `/reduced` vs 로컬 `materialize` | `treeHash` · `statuses` · `headOps` 동일 |
| **R3** | `If-None-Match` 일치 | `304`, 본문 없음, `materialize` **미호출**(스파이) |
| **R4** | 캐시 etag 일치, 클라이언트 etag 없음 | `200` 캐시 본문, `materialize` 미호출 |
| **R5** | 객체 push 후 | ETag 변경, 재환원 1회 |
| **R6** | ref 만 이동(finalize) | ETag 변경 — 객체 없이도 |
| **R7** | `integration:` ref 만 추가(다른 객체 push 없이는 불가하나, 단위로 강제) | ETag **불변** |
| **R8** | 상한 초과 트리 | `treeOmitted: true`, `tree` · `synth` 부재, 판정 필드 온전 |
| **R9** | 상한 변경 후 같은 저장소 | ETag 변경 (`treeMaxEntries` 가 입력이다) |
| **R10** | 합성 oid | `/objects/:oid` `404`, `/reduced/blob` `200`, 바이트 = 로컬 `synthBlobs` |
| **R11** | 저장된 oid 를 `/reduced/blob` 에 | `404` |
| **R12** | `If-Match` 불일치 | `412` |
| **R13** | 없는 view | `404` |
| **R14** | `view` 생략 | `main` 과 동일 응답 |
| **R15** | `readAccess: "token"` 서버, 토큰 없음 | `401` — 다른 읽기와 같은 게이트 |
| **R16** | 컨포먼스 — 광고 없는 서버 | `reduced` 축 **건너뜀**, 레벨 결과 불변 |
| **R17** | 컨포먼스 — 잘라 주는 서버 | 단언 실패 (비준수 탐지) |

전체 계약 스위트와 컨포먼스 하네스가 green 이어야 한다.

## 8. 리스크 / 미결정

| # | 항목 | 처리 |
|---|---|---|
| R-a | 공개 읽기 서버에서 `/reduced` 가 **가장 비싼 GET** 이 된다 | §3.5 — 환원은 변경당 1회. 첫 요청의 비용은 `Repo.materialize` 의 스냅샷 시드 비용이고, 그것은 CLI 사용자가 이미 매번 내는 값이다 |
| R-b | `statuses` 무상한 (§4.2) | `/have` 전례로 수용. `?statuses=open` 은 범위 밖으로 명시 |
| R-c | refs 전량 해시의 과무효화 — `member:` 하나가 바뀌면 재환원 | 의도된 보수성. 멤버십 변경은 드물고, 틀린 `304` 보다 재환원 1회가 싸다 |
| R-d | `Repo.materialize` 가 `autoSync` remote 에 백그라운드 sync 를 발화한다 | 허브 저장소는 remote 가 없어 no-op. 구현이 이를 **단언**한다(remote 가 있는 허브에서 읽기가 네트워크를 건드리면 안 된다) |
| R-e | §11 사다리 구조 변경은 기존 배지 의미를 건드린다 | 레벨은 **불변**이고 확장이 옆에 붙는다 — 어떤 서버의 레벨도 바뀌지 않는다 |
| Q1 | 워크스페이스 view (`materialize(view, { workspace })`) | **범위 밖.** `view` 하나로 시작한다. 필요하면 쿼리 파라미터로 가산 |
| Q2 | 증분 파생 상태(`?since=N` 으로 바뀐 판정만) | **범위 밖.** ETag/304 가 폴링 비용을 지우므로 급하지 않다 |
| Q3 | CLI · MCP 표면(`avcs status --remote`) | **범위 밖.** 사양이 굳은 뒤 별건 |
| Q4 | `reducedTreeMaxEntries` 기본값 50,000 | 참조 구현의 값일 뿐이다. 서버가 정하고 광고한다 |

## 9. 이 설계가 지우는 것 / 남기는 것

**지운다:** "서버에 붙으려면 avcs 전체를 품어야 한다" · 판정이 TypeScript 안에만 있다는
언어 경계([24](24-canonical-interop.md) 가 oid 에 대해 지운 것을 판정에 대해 지운다) ·
얇은 클라이언트가 병합 결과 파일을 볼 수 없다는 구멍(§3.2) · 독립 능력이 누적 사다리에
들어갈 자리가 없다는 §11 의 긴장(§5).

**남긴다(의도적으로):** 복제본의 **자기 환원 우선**(§3.6 — 이 엔드포인트는 창이고 권위가 아니다) ·
`protocol: 5`(§9 대로) · `statuses` 의 O(ops)(§4.2) · 워크스페이스 view · 증분 판정 · CLI/MCP
표면(Q1–Q3).

→ 관련: [00 — 개요](00-overview.md) 정의 · [03 — 리듀서](03-reducer.md) ·
[24 — 정규 직렬화](24-canonical-interop.md) · [26 — 서버 프로토콜](26-hub-protocol.md) §0 · §3 · §4-1 · §4-6 · §6-3 · §9 · §11 ·
[izagood/avcs-server#7](https://github.com/izagood/avcs-server/issues/7)
