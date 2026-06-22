# 06 — MCP / Skill 인터페이스

AVCS에서 **1급 인터페이스는 CLI가 아니라 MCP 서버**다. 에이전트는 git status/diff/commit을 이해할 필요 없이, MCP tool과 skill로 사용법을 즉시 주입받는다. 구현: [`src/mcp/server.ts`](../src/mcp/server.ts).

> MCP는 AI 앱이 외부 데이터·도구·워크플로우에 연결되는 표준이다. 서버는 `resources`(읽기 맥락)·`prompts`(작업 템플릿)·`tools`(행위)를 제공한다. AVCS는 이를 전부 활용하도록 설계됐다 — MVP는 `tools`를 구현, `resources`(ContextPack)·`prompts`(skill 템플릿)는 Phase 3.

## Tool 표면 (MVP: 8종)

| tool | 역할 |
|------|------|
| `avcs.intent.create` | 목적·제약·허용 범위 개시. 모든 작업의 출발점 |
| `avcs.session.start` | intent에 대한 작업 세션 시작 → sessionOid |
| `avcs.operation.propose` | 의미 변경 제출 (MVP: 파일 쓰기). **effects 정직 선언** |
| `avcs.evidence.attach` | test/typecheck/... 증거 첨부 |
| `avcs.view.materialize` | 연산 그래프 → tree + status + conflicts (내 작업이 병합되는지 확인) |
| `avcs.conflict.list` | 사람이 결정할 충돌 목록 |
| `avcs.decision.record` | 사람/owner의 충돌 해결 기록 |
| `avcs.checkpoint.create` | 검증된 상태 벡터 동결 |

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
2. avcs.context.build       (관련 symbol/test/decision 로드 — Phase 3)
3. avcs.lease.request        (scope 선점 — Phase 3)
4. (코드 작업)
5. avcs.operation.propose    (변경을 operation으로 제출)
6. avcs.evidence.attach      (테스트 결과 첨부)
7. avcs.view.materialize     (병합 가능 여부 확인)
8. 실패 → repair op 덧붙임 (기존 op를 숨기지 않음)
9. 충돌 → avcs.conflict.list → 사람에게 선택지 제시
10. accepted → avcs.checkpoint.create
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
