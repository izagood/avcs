# 23 — 로컬 undo: 공유 전의 실수를 되돌리는 길

> **상태: 구현됨** ([이슈 #91](https://github.com/izagood/avcs/issues/91)). Phase 12의
> [`redact`](02-object-model.md)가 **이미 공유된** 저장소의 유출을 다루는 거버넌스 행위라면,
> 이 문서는 **아직 아무것도 나가지 않은** 저장소의 같은 사고를 다루는 로컬 행위를 정의한다.

## 1. 문제

`.env`가 섞여 들어간 커밋 하나. 혼자 쓰는 로컬 저장소. v0.33.0에서 사용자가 할 수 있는 것:

| 단계 | 결과 |
|---|---|
| `ViewQuery.excludeOps`로 op 제외 | ✅ 트리에서 파일이 사라진다 |
| `repo.gc({})` | ❌ `{ blobs: [] }` — op이 여전히 blob을 참조하므로 orphan이 아니다 |
| `repo.readBlob(oid)` | ❌ `AWS_SECRET_ACCESS_KEY=…` 가 그대로 읽힌다 |
| `repo.redact(oid, …)` | ❌ `redact requires role admin; human:dev is reader` |

`roleOf`는 `Membership`이 없는 actor를 전부 `reader`로 돌려주고, membership은 org trust root가
발급한다. 이는 **"admin이 공유 저장소에서 유출 blob을 축출한다"** 에 정확히 맞는 모양이며, 혼자
작업하는 사람에게는 닫혀 있다. CLI 표면도 없었다 — `undo`도, `reset`도, `commit --amend`도.

즉 **바이트는 읽히는 채로 남고, 인가된 축출 경로는 닫혀 있다.** 남는 선택지는 저장소를 새로
만드는 것뿐인데, 그건 avcs를 쓰는 이유인 intent·decision 이력을 통째로 버리는 일이다.

### 1.1 append-only는 이것을 요구하지 않는다

append-only는 **원장**에 대한 원칙이지 모든 바이트의 불멸성이 아니다. 설계는 이미 둘을 분리해
두었다:

- `redact`는 oid를 보존한 채 바이트만 축출한다 → `treeHash`는 계속 유효하다. 모델은 **바이트
  축출을 구조적으로 허용**한다.
- 어떤 view도 선택하지 않는 op은 어떤 projection에도 기여하지 않는다. **op**을 남기는 감사
  가치는 **blob**을 버리는 것과 무관하다.

없던 것은 메커니즘이 아니라 **공유 전 로컬 사례를 위한 경로**였다. 그리고 그 사례에서는 위험
계산이 완전히 다르다 — 아무것도 복제되지 않았으므로, 깨질 다른 보유자의 `treeHash`가 없다.

## 2. 명령

```
avcs undo [--last | <op-oid>…] [--purge] [--reason <r>] [--author <id>] [--line <l>]
```

| 형태 | 하는 일 | 되돌릴 수 있나 |
|---|---|---|
| `avcs undo <oid>…` | 그 op들을 현재 view에서 제외한다 | ✅ op도 바이트도 그대로 남는다 |
| `avcs undo --last` | 가장 최근 커밋의 op 전부를 제외한다 | ✅ |
| `avcs undo … --purge` | 추가로, 그 op들이 **유일하게** 참조하는 blob 바이트를 축출한다 | ❌ |

API는 `repo.undo({ ops \| last, view, workspace, purge, by, reason })` → `UndoResult`
(`{ undoOid, view, excluded, alreadyExcluded, purged, retained }`).

기본형이 되돌릴 수 있다는 점이 중요하다. 대부분의 "아 잘못 커밋했다"는 비밀이 아니라 노이즈이고,
그 경우 필요한 것은 projection에서 빼는 것뿐이다. 바이트를 지우는 쪽은 **따로 이름 붙여** 옵트인
시킨다 — 되돌릴 수 없는 일은 실수로 일어나면 안 된다.

## 3. 경계: undo ↔ redact

이 기능의 핵심은 명령이 아니라 **경계**다.

```
      아직 push 안 됨                        이미 push 됨
  ┌──────────────────────────┐        ┌──────────────────────────────┐
  │  avcs undo [--purge]     │        │  repo.redact(blob, …)        │
  │  · 역할 요구 없음         │        │  · role admin 필요            │
  │  · 서명 없음              │        │  · admin 서명 필수            │
  │  · 전파 없음              │        │  · 모든 replica에 전파         │
  │  · Undo 객체로 기록       │        │  · Redaction 객체로 기록       │
  └──────────────────────────┘        └──────────────────────────────┘
```

- **undo가 role을 요구하지 않는 이유**: undo는 op이 push된 순간 **거부한다**(§5). 따라서
  구성상 다른 보유자가 없는 이력에만 작동한다. 조율할 상대가 없으므로 물어볼 권위도 없다.
- **redact의 admin gate를 건드리지 않는 이유**: 그 gate는 자기 일에 정확히 맞다. 이미 남이 들고
  있는 저장소에서 바이트를 축출하는 것은 거버넌스 행위다. 두 경로가 코드를 공유하더라도
  (§4의 stub) **gate는 공유하지 않는다.**

두 객체를 하나로 합치지 않은 것도 같은 이유다. `Undo`와 `Redaction`이 별개이기 때문에
`applyRedactions`(전파)는 undo를 절대 집어 들지 않고, hub는 admin 서명 없는 축출을 계속 거부한다.

## 4. `--purge`: 무엇이 "유일 참조"인가

content-addressing 때문에 **같은 내용은 하나의 blob**이다. 그래서 "이 op의 blob을 지운다"는
곧바로 위험해진다 — 다른 op이 그 blob을 여전히 필요로 할 수 있다.

축출 대상은 다음 규칙으로 정한다(`Repo.#purgeableBlobs`):

- **후보**: undo 대상 op들의 `body.blobOid`(chunked manifest면 그 chunk들까지).
  대상 op의 `baseBlobOid`는 **후보가 아니다** — 그건 이전 내용이고, 그 내용을 쓴 op의 것이다.
- **면제(spared)**: 대상이 **아닌** 저장소 안 모든 operation의 `blobOid` **및** `baseBlobOid`
  (+ chunk). 남은 `edit_file`은 3-way merge base가 있어야 하므로 base도 똑같이 보호한다.
  ref가 가리키는 oid도 면제한다(op이 언급하지 않는 blob을 ref가 들 수 있다 — landed-workspace 집합).
- **면제 판정은 view가 아니라 store 전체 기준**이다. 다른 line의 op, workspace의 op, 이전 undo가
  제외만 하고 purge하지 않은 op — 전부 유일성을 깬다.

비대칭은 의도된 것이다. **하나 더 남기면** 사용자가 op 하나를 더 undo해야 할 뿐이고,
그 사실은 `retained`로 보고된다. **하나 더 지우면** 아무도 바꾸라고 하지 않은 projection이
되돌릴 수 없이 깨진다.

축출은 `purgedStub`(`src/store/applyRedactions.ts`)을 blob oid **자리에** 덮어쓴다.
`redactedStub`과 같은 메커니즘이고 같은 `redacted: true` 플래그를 쓴다 — 그 플래그가
store와 `fsck`가 이미 이해하는 "인가된 oid≠content 불일치" 표시다. 다른 것은 출처 포인터뿐:
`redactionOid` 대신 `undoOid`.

기록 순서는 **먼저 `Undo`를 put하고 그다음 바이트를 축출**한다. 둘 사이에서 죽으면 "지워졌어야
할 바이트"를 지목하는 기록이 남고, 다시 실행하면 마저 끝난다. 반대 순서였다면 아무도 설명하지
못하는 축출이 남는다.

## 5. 이미 push된 op은 거부한다

```
undo refuses: 1 of these op(s) have already been pushed (<oid> → http://…).
Another holder's projection depends on them, so evicting them is a governance act,
not a local one — use `redact` (admin-signed, propagates to every replica) instead.
```

### 5.1 무엇으로 판정하나

이슈의 제안은 `.avcs/sync-cursors.json`을 근거로 들었지만, **그 파일은 pull 커서다** — 이 replica가
어디까지 **읽었는지**를 기록할 뿐, 무엇이 **나갔는지**에 대해선 아무 말도 하지 않는다. push는
`GET /have`와의 diff이지 시퀀스가 아니라 재사용할 커서도 없다.

그래서 push 원장을 새로 둔다: **`.avcs/pushed-ops.json`** — `op oid → 그 op을 받아들인 hub URL 목록`.
`pushToHub`가 기록하며(`land`/`submit` 안의 push 포함), 루프가 도중에 throw해도 `finally`에서
기록한다 — throw 이전에 나간 것은 이미 나간 것이므로, 여기서 덜 기록하면 로컬 경로가 복제된
이력을 조용히 다시 쓰게 된다. aux 파일이라 gossip되지 않는다(remotes.json·last-sync.json과 같은 층).

`repo.pushedOps()`로 읽을 수 있다.

### 5.2 이 판정이 보지 못하는 것

정직하게 적어 둔다. 원장은 **이 replica의 push**를 기록한다. 따라서:

- 상대가 `avcs pull <이-디렉터리>`로 로컬 dir gossip을 해 갔다면 — 이쪽은 물어보인 적이 없으므로
  알 수 없다.
- `avcs bundle`로 만든 파일을 남에게 건넸다면 — 파일이 나간 사실은 avcs가 관측하지 않는다.

두 경우 모두 `undo --purge`는 통과한다. 이는 "hub push = 복제"라는 실제 배포 경로를 기준으로 삼은
선택이며, 확장이 필요하면 원장에 항목을 추가하는 문제이지 모델의 문제가 아니다.

## 6. 기록: `Undo` 객체

undo가 흔적을 남기지 않는다면, 그건 피하려던 이력 재작성보다 나쁜 이력 재작성이다.
`Decision`/`Redaction`/`Promotion`과 같은 자리, 같은 모양으로 기록한다:

```ts
interface Undo extends BaseObject {
  type: "undo";
  view: string;      // projection이 op을 잃은 view(line)
  ops: string[];     // 이 undo가 새로 제외한 op (이미 제외된 것은 다시 기록하지 않는다)
  viewOid: string;   // 제외가 만들어 낸 새 view 객체
  purged?: string[]; // 바이트가 축출된 blob. 일반 undo에는 없음
  reason?: string;
  by: string;        // actor id — role 요구 없음(§3)
  createdAt: string;
}
```

조회: `repo.listUndos()`(오래된 순), 또는 `repo.store.collect("undo")`.

reducer에는 **inert**하다. checkpoint처럼 트리에 projection되지 않는다. projection을 실제로 바꾸는
것은 undo가 함께 저작한 **새 view 객체**(`viewOid`)다. 즉 undo도 append-only다 — view를 수정하지
않고 새로 쓴다.

## 7. `--last`의 대상 해석

"가장 최근 커밋"은 새 부기(bookkeeping) 없이 기존 구조로 결정된다. `commitWorkingTree`는 한 번의
capture마다 **session 하나**를 열고 그 capture의 모든 op을 거기에 저작한다 — **session이 곧 커밋**이다.

1. 그 scope의 view가 **현재 선택하는** op 집합을 구한다(`materialize().statuses`).
2. reducer와 같은 canonical 순서(`lamport`, 동률이면 `oid`)로 가장 나중 op을 고른다.
3. 그 op의 `sessionOid`를 가진 **선택된 op 전부**를 대상으로 한다 — 2-파일 커밋은 2개 다 undo된다.

"현재 선택하는" 집합 기준이므로 **반복하면 한 커밋씩 뒤로 걸어간다**: 방금 제외한 op은 더 이상
후보가 아니다.

## 8. 결정론 · 호환성

- **`MATERIALIZER_VERSION`/`MERGE3_VERSION`을 건드리지 않는다.** op을 제외하는 것은 reduce의
  이미 지원되는 정상 입력이다(`ViewQuery.excludeOps`는 `materialize`가 원래 존중한다). 같은
  (op 집합 + policy + materializer) ⇒ 같은 `treeHash`라는 불변식은 그대로다.
- 증분 reduce는 op 집합이 **줄어드는** 것을 append-superset 전제 위반으로 보고
  `NonIncrementalError` → 전체 reduce로 폴백한다. `AVCS_VERIFY_INCREMENTAL=1`로 검증한다.
- 스키마 변경은 **가산적**이다: `ObjectType`에 `"undo"`, `Blob`에 선택적 `undoOid`.
  기존 `.avcs` 저장소는 그대로 열린다.

### 4.1 뒤 op이 내용을 물고 간 경우 — 한 번에 전부 지목해야 한다

가장 중요한 함정이다. 비밀이 들어간 커밋 **뒤에** 같은 파일을 한 번 더 고쳤다면, 그 나중 op의
내용에도 비밀이 그대로 들어 있다(`put_file`/`edit_file`은 **전체 내용**을 담는다). 그 op은
여전히 선택되어 있으므로:

```
avcs undo --purge <처음 커밋의 op>     → purged 0, kept 1   (트리에 비밀이 그대로 남는다)
```

`--purge`가 아무것도 지우지 않은 것은 **버그가 아니라 §4의 면제 규칙이 제대로 동작한 것**이다 —
그 blob은 나중 `edit_file`의 merge base이므로 지우면 남은 projection이 깨진다. 그리고 그 사실을
`retained`(CLI: `kept N blob(s) …`)로 **보고한다.**

해결은 **내용을 물고 있는 op을 전부 한 호출에 지목**하는 것이다:

```
avcs undo --purge <처음 커밋의 op> <나중 커밋의 op>
```

두 op이 모두 대상 집합에 있으면 서로를 면제해 주지 않으므로 두 blob이 함께 축출된다.
purge는 **대상 집합 상대적**이며, 이는 의도된 성질이다 — 지목하지 않은 op이 붙들고 있는 바이트를
avcs가 혼자 판단해 지우는 일은 없다.

> 요령: `--purge` 후 `retained`가 0이 아니면 아직 끝나지 않았다는 신호다. `avcs blame`/`avcs log`로
> 그 파일을 건드린 op을 모아 한 번에 지목하라.

### 4.2 op을 제외해도 뒤 op의 내용은 남는다

같은 이유로, 어떤 op을 undo해도 **그 위에 쌓인 뒤 op의 내용은 사라지지 않는다.** 뒤 op은 전체 내용을
담고 있고, `excludeOps`는 그 op을 지우지 않는다. 이는 `ViewQuery.excludeOps`의 원래 의미 그대로이며
undo가 새로 들여온 성질이 아니다. "커밋 하나를 통째로 없던 일로" 만들고 싶다면 그 뒤 커밋들까지
함께 지목하거나, 정방향 역연산인 `repo.revert(op)`를 쓴다.

## 9. checkpoint를 찍은 op도 `--purge`할 수 있다

소유자 결정이다. 비밀은 **checkpoint를 찍었든 말든** 사라져야 한다. checkpoint는 기록된
`treeHash`를 불변 기록으로 그대로 유지하므로 감사 흔적은 살아남는다. 잃는 것은 **그 옛 checkpoint를
다시 projection하는 능력**뿐이고, 그것이 정확히 의도한 바다.

## 10. 테스트

`test/local-undo.test.ts` — 이슈의 repro가 표제 테스트다(비밀 커밋 → `undo --purge` →
바이트가 **사라졌고** 앞선 정상 커밋은 멀쩡하며 트리가 계속 projection된다). 그 외:
`--purge` 없는 undo(바이트 보존·파일만 사라짐), 여전히 선택된 op과 공유하는 blob은 축출되지 않음,
남은 edit의 merge base 보호, push된 op 거부(메시지가 `redact`를 지목), `--last`의 대상 해석과
반복 시 뒤로 걸어가기, `Undo` 기록 조회, 이미 undo한 것을 다시 undo해도 오류가 아니라 멱등,
그리고 CLI 경로 전체.
