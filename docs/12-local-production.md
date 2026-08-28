# docs/12 — Local production hardening (Track D)

The determinism engine (`reduce`) is already production-grade: same op set ⇒ same
`treeHash`, enforced by the property harness. What stands between AVCS and a
*local* production VCS — "in an agent environment the final code stays stable,
correct, and recoverable" — is the durability and integrity skin around that
engine. Track D closes those gaps. Each stage is opt-in-safe (no default-on
behaviour change that could break determinism) and ships as a merged PR.

## Termination condition

Local production is "possible" when a normal local workflow
(init → propose → materialize → checkout/commit) is:

1. **Durable** — an object/ref/op-log entry that a call reported as written
   survives a hard crash (power loss), not just a clean process exit.
2. **Recoverable & self-checking** — corruption or drift (a bit-flipped object,
   an op-log shorter than the object set) is *detectable* and *repairable*
   without a full re-clone.
3. **Correct under symbol merges** — symbol-granular ops never silently
   materialize wrong code; an unparseable splice degrades to a safe, flagged
   path instead of corrupting content.

## Stages

| Stage | Gap (from the audit) | Fix | Severity |
|---|---|---|---|
| D1 | `#writeAtomic` fsyncs the file but not the containing directory; `appendFile` (oplog, entity index) isn't fsynced — a hard crash can drop a just-written object/ref/HEAD/op-log line | fsync the directory after every rename, fsync the file+dir after every append. `AVCS_NO_FSYNC=1` escape hatch for bulk import. | Med |
| D2 | `compact()` writes the snapshot with a plain `writeFile` (torn CBOR on crash) | route it through `#writeAtomic` | Low |
| D3 | no integrity check: nothing re-hashes objects (bit-rot) or detects op-log drift | `avcs fsck` — re-hash loose objects (oid==content), validate pack idx offsets, report op-log drift, `--rebuild` to repair the op-log | Med |
| D5 | the symbol parser is an approximate brace/regex scanner; a `set_symbol` on code it can't parse can splice wrong content — deterministic but incorrect | round-trip / safe-fallback guard: a splice that doesn't verifiably round-trip degrades to whole-file replace (or is flagged), never silent corruption | Med |

(D4 — automatic op-log reconciliation — is folded into D3's `fsck --rebuild`.)

## Invariants Track D must not break

- **Determinism**: no stage may change `reduce`'s output for a given op set. D1/D2
  are pure I/O durability; D3 is read-only (except `--rebuild`, which only
  rewrites the op-log *cache* to match the object set — the source of truth);
  D5 changes only the materialized content of *unparseable* symbol splices, and
  its equivalence with the old behaviour on parseable input is property-tested.
- **Append-only**: no stage deletes or mutates an object except the existing
  redaction/GC exceptions — to which [23](23-local-undo.md) adds one more, on the same
  terms: `undo --purge` evicts blob bytes while preserving the oid, exactly as `redact`
  does. The *ledger* is untouched either way; the undone ops stay, and both the exclusion
  and the eviction are recorded as new append-only objects (`view` + `Undo`).
- **Default-safe**: durability is default-on (correct by default); the only flag
  is the `AVCS_NO_FSYNC` *opt-out* for throughput-bound bulk loads.

## 개인키 보관소 (machine-level keystore)

*(issue #98. Phase 3의 "후속: 개인키 보관소"([07](07-roadmap.md) §Phase 3)가 여기서 닫힌다.)*

actor identity 는 **체크아웃이 아니라 사람+머신**에 속한다 — `~/.ssh`, `~/.gnupg`,
`~/.config/gh` 가 각각 머신에 하나의 자격증명을 두고 그 박스의 모든 저장소가 그것을
쓰는 것과 같은 스코프다. 0.35.0 까지 개인키는 `<store>/private/<actorId>.json`, 즉
저장소마다 따로 있었고 머신 레벨 경로가 없었다. 그래서:

- `clone` 이 **만들** 저장소의 키로 첫 `GET /have` 를 서명해야 한다는 구조적 모순이
  생겼다([#58](https://github.com/izagood/avcs/issues/58)). `--key` 는 그 경계를 넘겨
  자격증명을 실어 나르려고 존재했던 플래그다.
- 머신이 이미 identity 를 들고 있어도 새 `avcs init` 은 `signable (0)` 이었다.
- 키가 체크아웃마다 복제되어, 보호할 사본이 N개, 회전할 곳이 N곳이었다.

### 경로 해석

호출 시점마다 다시 읽는다(CI 잡과 테스트가 프로세스별로 갈아끼울 수 있도록):

| 순서 | 경로 | 용도 |
|---|---|---|
| 1 | `$AVCS_CONFIG_HOME` | 명시적 override. CI 와 테스트의 공식 노브 |
| 2 | `$XDG_CONFIG_HOME/avcs` | 사용자가 XDG 를 쓰는 경우의 플랫폼 관례 |
| 3 | `~/.avcs` | 기본값. `~/.ssh`, `~/.gnupg` 와 나란히 |

키 파일은 `<configHome>/private/<actorId>.json`, 모드 **0600**, 디렉터리 **0700**.
`private/` 하위 디렉터리를 쓰는 이유는 저장소의 `<store>/private/` 와 레이아웃이
동일해져 파일을 그대로 옮길 수 있고, 나중에 머신 레벨 설정 파일이 actor id 와
충돌하지 않기 때문이다. 경로를 탈출할 수 있는 actor id(`../x`, `a/b`)는 거부한다 —
저장소 스코프에서는 체크아웃을 벗어나는 정도였지만 이제는 사용자의 config home 을
벗어나기 때문이다.

### 우선순위 — repo → machine

1. `<store>/private/` — **override**. 다른 actor 로 서명해야 하는 의도된 경우(CI
   체크아웃, 두 번째 identity)를 위해 남는다. **먼저** 읽으므로 오늘 키를 가진
   저장소는 바이트 단위로 동일하게 계속 동작한다.
2. 머신 보관소 — 기본값.

`avcs key ls` 는 어느 쪽에서 왔는지 함께 출력한다. override 가 머신 identity 를
가리고 있다는 사실은 사용자가 볼 수 있어야 하는 정보다.

### 마이그레이션

repo 에만 있는 키는 **첫 사용 시 머신 보관소로 채택(adopt)** 되고, 사용자에게
알린다(`Repo.keystoreNotices` → CLI stderr). 복사이므로 저장소의 사본은 남고,
우선순위 때문에 그 저장소의 서명 동작은 변하지 않는다.

같은 actor id 로 **다른** 키가 머신 보관소에 이미 있으면 **덮어쓰지 않는다.**
경고만 남기고 둘 다 유지한다:

- 덮어쓰면 이미 history 에 들어간 서명을 다시 만들 수 없는 자격증명이 사라진다
  (`ensureOwnerKey` 가 idempotent 한 것과 같은 이유).
- 에러를 내면 사용자가 지금 요청하지도 않은 마이그레이션 때문에 잘 동작하던
  저장소가 멈춘다.
- 둘 다 두면 비용이 없다. repo 우선순위 덕분에 그 저장소는 이전과 똑같이 서명하고,
  사용자는 두 개가 있다는 사실을 알고 의도적으로 정리할 수 있다.

`AVCS_KEYSTORE_ADOPT=0` 으로 채택을 끌 수 있다. 공유 빌드 박스에서 저장소에 묶어둔
CI identity 를 의도적으로 그 안에 가둬 두는 경우가 있고, 자격증명의 이동은 사용자가
거부할 수 있어야 한다.

### `clone --key` 의 새 역할

머신이 identity 를 들고 있으면 `avcs clone` 은 **플래그 없이** read-gated hub 에
도달한다 — #58 이 사라진 것이지 옮겨간 것이 아니다. `--key` 는 남는다: 아직 identity
가 없는 머신, 또는 다른 actor 로 서명해야 하는 저장소. `--key` 로 들여온 키는
**저장소 스코프**에 쓴다(clone 플래그의 부수효과로 머신 전역 자격증명을 심지 않는다).
새 머신에 identity 를 얹는 정상 경로는 `avcs key import <key-file>` 이다.

`importLocalKey` 는 개인키의 **공개 절반도 신뢰 목록에 등록**한다. 이전에는 개인
절반만 저장해서 `signable 1 / trusted 0` — 서명은 되지만 아무도 믿어주지 않는
상태였다([#96](https://github.com/izagood/avcs/issues/96) 의 "Related, same command").
ed25519 개인키는 공개점을 담고 있으므로 신뢰 레코드를 복원할 수 있고, 개인키 보유자는
이미 무엇이든 서명할 수 있으므로 권한이 추가되는 것은 아니다.

### 테스트 격리

머신 보관소의 기본값은 개발자의 **실제** 자격증명 저장소다. `npm test` 는
`--import ./test/_isolate-keystore.ts` 로 모든 테스트 프로세스에 훅을 걸어
테스트마다 임시 `AVCS_CONFIG_HOME` 을 부여한다. 새로 추가된 테스트가 이 사실을
몰라도 격리되고, CLI 테스트가 띄우는 자식 프로세스도 환경을 상속받는다.
`test/machine-keystore.test.ts` 의 `the real config home is never touched` 가
이 보장을 가정이 아니라 단정으로 검증한다.
