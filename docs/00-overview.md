# 00 — 개요와 원칙

## 문제

Git은 본질적으로 **파일 스냅샷의 DAG**다. commit은 특정 시점의 top-level tree를 가리키고, merge는 줄 단위 텍스트 충돌을 사람이 직접 봉합하는 모델이다. 이 모델은 사람 몇 명이 가끔 합치는 환경에는 잘 맞았다.

AI 에이전트가 동시에 코드를 바꾸는 환경은 다르다. 여기서 중요한 단위는 commit이 아니라:

- **누가** (사람 / AI 에이전트 / CI 봇)
- **언제** (인과 순서)
- **어떤 의도로** (intent)
- **어떤 작은 단위를** (operation)
- **어떤 근거로** (evidence: 테스트·타입체크·정적분석)
- **어떤 기존 변경에 의존해서** (causal deps)
- **어떤 충돌에서 무엇을 선택했고 왜** (decision)

바꿨는지다. Git에는 이 중 첫 두 개(누가/언제)밖에 없다.

## AVCS의 한 줄 정의

> 코드를 저장하는 VCS가 아니라, 에이전트들이 코드를 바꾼 **의도·작업·증거·결정**을 저장하고, 그 결과로 코드를 **materialize**하는 시스템.

코드 트리는 원본이 아니다. 원본은 연산 그래프이고, 코드는 그것의 projection이다:

```
state = reduce(base, operationDAG, decisions, policy, materializer)
```

같은 객체 + 같은 정책 + 같은 materializer는 어떤 replica에서도 같은 트리를 만든다(결정론).

## 다섯 가지 핵심 원칙

| # | 원칙 | Git과의 대비 |
|---|------|-------------|
| 1 | Commit이 아니라 **Operation**이 히스토리다 | commit = 여러 operation의 checkpoint일 뿐 |
| 2 | 파일 경로가 아니라 **Entity ID**가 정체성이다 | rename + edit가 자동 병합 가능 |
| 3 | Merge는 텍스트 선택이 아니라 **결정론적 환원**이다 | conflict marker 없음 |
| 4 | Conflict는 깨진 파일이 아니라 **1급 Decision 객체**다 | 결정 근거가 히스토리에 남음 |
| 5 | AI 출력은 신뢰된 코드가 아니라 **증거가 붙은 제안 연산**이다 | 테스트 없는 동작 변경은 accepted 불가 |

여섯 번째 운영 원칙: **코드에 last-write-wins를 기본값으로 쓰지 않는다.** 마지막에 쓴 사람이 맞는 게 아니라, 정책이 정한 우선순위에서 이긴 변경이 맞다. recency는 최후의 tie-break일 뿐이다.

## 무엇을 "충돌"이라 부르는가

핵심은 충돌을 *줄이는* 게 아니라 **사람이 봐야 하는 충돌만 남기는** 것이다. 충돌을 5등급으로 나눈다(상세: [03](03-reducer.md)).

- **L0** 서로 다른 entity → 자동 병합
- **L1** 같은 파일, 다른 의미 슬롯 → 자동 병합
- **L2** 같은 슬롯 동시 변경, 정책으로 결정 가능 → 정책 자동 결정
- **L3** 문법은 병합되나 의미가 깨질 수 있음 → 검증(테스트/타입체크) 필요
- **L4** 정책으로도 불가(아키텍처 선택) → 사람 결정 필요

## 용어집

| 용어 | 의미 |
|------|------|
| **Intent** | 작업의 목적·제약·허용 범위 |
| **Session** | 한 에이전트/사람의 작업 에피소드 |
| **Operation** | 의미 단위 변경 1개 (진짜 히스토리) |
| **Evidence** | 연산에 붙는 기계 검증 결과 |
| **Decision** | 충돌/설계 선택의 기록 |
| **View** | 연산 그래프에 대한 쿼리 (branch 대체) |
| **Checkpoint** | 검증된 (ops + policy + materializer) 상태 벡터 (commit 대체) |
| **Policy** | reduce를 매개변수화하는 병합 규칙 |
| **Materializer** | 연산 → 파일 트리 변환기 (언어별) |

## 흡수한 선행 사례

- **CRDT (Yjs/Automerge)** — 동시 편집 자동 수렴. 단, 코드엔 "문법 병합 ≠ 의미 정합"이라 한 계층 더 필요.
- **Pijul** — 파일 이름/inode 정체성 분리 → rename·edit commute.
- **Jujutsu** — operation log를 1급으로.
- **Peritext** — stable identifier + deterministic 최종 계산.
- **Entire** — 에이전트의 session/checkpoint(프롬프트·도구 호출·증거)를 저장소 데이터로. AVCS는 이를 Git 옆이 아니라 **저장소의 중심**에 둔다.

→ 다음: [01 — 아키텍처](01-architecture.md)
