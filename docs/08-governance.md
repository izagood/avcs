# 08 — 거버넌스 & 합의 (avcshub)

멀티 머신 스트레스 테스트에서 드러난 구멍은 전부 "불변 객체 그래프"가 아니라 **가변·합의가 필요한 층**에 있었다:

- **C-1** operation에 서명이 없어 누구나 임의 actor로 위조 가능
- **C-2** policy/view가 머신별 가변 ref라 "어느 게 canonical"인지 합의 부재 → 같은 객체집합인데 머신마다 다른 트리
- **H-4** 모순된 사람 결정이 **wall-clock**으로 정해짐 (결정 권한 모델 없음)
- **H-7** 신뢰 키(keyring)가 머신 간 연합되지 않음

해법은 GitHub이 이미 검증한 모델 — **역할(roles) · CODEOWNERS · branch protection · approve/merge 권한** — 을 AVCS 객체 모델 위에 올리는 것이다.

## 핵심 아이디어: 두 개의 plane

GitHub의 진짜 구조를 보면, **커밋(내용)** 은 그냥 git 객체라 누구나 가질 수 있지만, **"무엇이 main인가 / 누가 merge하나 / 리뷰 몇 개 필요한가"** 는 GitHub 서버가 권위적으로 정한다. AVCS도 똑같이 쪼갠다:

```
┌─────────────────────────────────────────────────────────────┐
│ CONTENT PLANE  — 분산, gossip, append-only, 충돌 없음          │
│   operation · evidence · blob · intent · session             │
│   (member 키로 서명되기만 하면 누구나 보유·교환)                │
├─────────────────────────────────────────────────────────────┤
│ GOVERNANCE PLANE — avcshub 권위, 서명, 선형화(linearized)     │
│   membership/role · policy · protection · 보호된 view의 head   │
│   (= GitHub 서버가 정하는 "main/권한/필수리뷰"에 해당)         │
└─────────────────────────────────────────────────────────────┘
```

→ 내용은 분산이라 합의가 공짜(C-2의 절반 해결), **거버넌스만 avcshub가 권위적으로 직렬화**한다. 이게 빠졌던 합의 계층이다.

## 1. 권한 사다리 (GitHub roles 매핑)

avcshub는 **org trust root** 키쌍을 가진다. root가 서명한 **Membership** 객체가 각 멤버의 키·역할·범위를 발급한다. 모든 머신은 avcshub에서 서명된 멤버 집합을 pull → 그 키들을 신뢰 (**H-7 키 연합 해결**).

| GitHub | AVCS role | 권한 |
|--------|-----------|------|
| read | `reader` | 객체 pull, materialize |
| write | `proposer` | **서명된** operation/evidence push |
| review + CODEOWNERS | `reviewer` | 소유 scope에 Approval/Decision 서명 |
| maintain | `maintainer` | (scope 한정) 정책 변경, 보호 view에 **finalize(merge)**, release cut |
| admin | `admin` | 역할/멤버십·root 정책·protection 규칙 관리 |

권한 가중치: `admin(4) > maintainer(3) > reviewer(2) > proposer(1)`.

```ts
interface Membership {            // root가 서명 → 키 연합의 신뢰 뿌리
  type: "membership";
  actorId: string; publicKey: string;
  role: "reader"|"proposer"|"reviewer"|"maintainer"|"admin";
  scopes?: ScopeRef[];            // 비면 전역, 있으면 scoped(예: 특정 패키지 maintainer)
  issuedBy: string;              // root keyId
  expiresAt?: string;
}
```

## 2. operation/decision 인증 (C-1 해결, push 게이트키퍼)

avcshub는 GitHub이 권한 없는 push를 거부하듯, push 경계에서 강제한다:

- **모든 operation은 member 키로 서명**되어야 하며 역할 ≥ `proposer`. 미서명·비멤버 op는 **avcshub가 거부**.
- evidence/decision도 동일(이미 서명 구조 있음). 즉 `actor` 자기신고가 아니라 **서명으로 검증**.
- 현재 코드 갭: operation에 `sig`가 없음 → BaseObject의 `sig`를 operation에도 채우고, `computeOid`가 이미 `sig`를 해시에서 제외하므로 추가 변경 없이 서명 가능.

## 3. PR 라이프사이클 매핑 (open → review → merge)

```
GitHub PR                         AVCS
─────────────                     ───────────────────────────────
open PR              ≈  intent + 서명된 operation 묶음을 avcshub에 push (= Proposal)
CI checks            ≈  validate.run → 서명된 evidence (required checks)
review / approve     ≈  reviewer(소유자)가 서명한 Approval/Decision
required approvals   ≈  Protection 규칙 (view에 부착)
merge                ≈  maintainer가 보호 view의 head를 전진(finalize checkpoint)
merge 권한            ≈  Protection.finalizeRole
merge queue          ≈  avcshub가 head 전진을 선형화(직렬화)
```

```ts
interface Protection {            // = branch protection rule
  type: "protection";
  view: string;                  // 예: "main"
  requiredApprovals: number;     // 필요한 Approval 수
  requireOwnerApproval: boolean; // CODEOWNERS = 우리 OwnerRule 재사용
  requiredChecks: EvidenceKind[];// 서명된 pass 증거가 있어야 하는 검사
  finalizeRole: "maintainer"|"admin";
  requireSignedOps: boolean;     // 기본 true
  requireUpToDate: boolean;      // 기본 true — stale finalize/decision 거부(§4.0, §6, §9)
  allowForcePush: boolean;       // 기본 false — admin도 head 롤백 금지
}
interface Approval {              // = PR approve
  type: "approval";
  proposalId: string;            // 승인 대상 op 묶음/intent
  by: string;                    // actorId (role ≥ reviewer, 서명됨)
  verdict: "approve"|"request_changes";
}
```

**보호된 `view:main`에 들어가는 조건** (= branch protection 통과):
1. `requiredApprovals` 만큼의 유효 Approval (소유자 포함 시 `requireOwnerApproval`)
2. `requiredChecks` 가 **서명된 pass 증거**로 충족
3. `finalizeRole` 권한자가 finalize
충족 전까지 operation은 비승격(proposed) 상태 = **열린 PR**. avcshub만이 보호 view의 head를 전진시킨다.

## 4. 결정 우선순위 = 인과적 최신성 **그 다음** 권한 (H-4 해결, wall-clock 추방)

`reducer`의 기존 "나중 createdAt이 이김"을 교체하되, **권한만으로는 부족하다**(§9 참조). 권한은 *최신 상태인 결정자들 사이의* tiebreaker이지, 못 본 것을 덮어쓰는 license가 아니다.

0. **인과적 최신성 전제 (먼저 통과해야 함).** 같은 conflict key에 대해, 이 Decision이 **인과적으로 보지 못한** 더 나중 Decision이 이미 보호 head 히스토리에 있으면 → 이 Decision은 **stale**로 dismiss된다. **권한이 높아도 예외 없음.** (= GitHub "require up to date before merge" + "stale review dismissal")
1. 유효 Decision = 역할 ≥ `reviewer` **이고** 해당 scope의 소유자(또는 역할 ≥ `maintainer` override). 비멤버/권한부족 결정은 무효.
2. **서로를 못 본 진짜 동시(concurrent)** 유효 Decision 간 → **권한 가중치 높은 쪽이 이김** (admin > maintainer > reviewer). ← "권한 높은 사람이 합의 우선권"
3. **같은 가중치 동률** → wall-clock으로 풀지 않는다. `needs_decision`으로 **막힌 채 상위 권한자에게 escalate**(또는 정족수 규칙). 명시적 supersede만 인정.

이로써 "두 사람이 반대로 결정 → 노트북 시계가 승자"도, "오래된 고권한자가 신선한 결정을 덮어씀"도 사라지고, GitHub의 "up-to-date + merge 권한자/CODEOWNERS가 최종"과 동형이 된다.

## 5. 정책 합의 (C-2 해결)

policy를 머신별 가변 ref로 두지 않는다:

- **avcshub가 canonical policy의 권위 기관.** 정책 변경은 `admin`/`maintainer`의 서명된 거버넌스 변경으로만 발생하고 avcshub가 직렬화·게시한다.
- 머신은 avcshub의 서명된 latest policy를 pull → **모두 같은 policy로 reduce** → 결정론 복구.
- protection·membership도 동일하게 avcshub 권위. (content 객체는 여전히 분산 gossip.)

## 6. finalize = head에 대한 CAS (non-fast-forward 거부, lost-update 방지)

finalize는 보호 head 포인터를 전진시키는 유일한 연산이며, **compare-and-swap**다:

```ts
interface Finalize {                 // = git push / PR merge
  type: "finalize"; view: "main";
  parentHead: string;                // 이 finalize가 기반한 head oid
  newCheckpoint: string;             // 전진시킬 checkpoint
  by: string;                        // role ≥ Protection.finalizeRole, 서명됨
}
```
- avcshub: `parentHead === 현재 head`일 때만 수락(원자적 CAS). 아니면 **거부** "head moved: X → Y, pull first" (= git non-fast-forward 거부). **권한 무관** — admin도 stale finalize는 못 한다(`requireUpToDate`가 force-push를 금지).
- 거부받은 쪽은 pull → 그동안의 결정/op를 흡수 → 현재 head 위에서 re-reduce(객체 합집합이라 rebase가 trivial) → 다시 finalize. **operation은 유실되지 않는다**(append-only, union).
- CAS가 head 전진을 자연히 **선형화**(merge queue). finalize 전 **causal-complete 검사**(모든 causalDep 객체 존재)로 부분 sync silent 오류(C-3)도 차단.

## 7. 무엇이 닫히고, 무엇이 분산으로 남나

| 구멍 | 닫는 방법 |
|------|-----------|
| C-1 op 위조 | member 서명 필수 + avcshub push 게이트 |
| C-2 정책 합의 | governance plane을 avcshub 권위로, 서명·직렬화 |
| H-4 결정 권한 | 권한 가중치 우선 + 동률은 escalate (wall-clock 금지) |
| H-7 키 연합 | root 서명 Membership = org trust root |

**분산으로 남는 것(오프라인 가능):** operation/evidence 제안, 로컬 reduce(마지막으로 알던 policy로), 충돌 미리보기. — GitHub에서 오프라인 커밋은 되지만 보호된 PR merge는 서버가 필요한 것과 동일하게, **보호 main에 finalize만 avcshub가 필요**하다.

## 8. 트레이드오프 / 열린 질문

- **avcshub는 finalize·거버넌스의 권위점** = 가용성 SPOF. 완화: 거버넌스 객체도 서명되어 있어 여러 hub로 복제/페일오버 가능(권위 = root 키, 호스트 아님). content는 어차피 분산.
- **정족수 vs 단일 소유자**: `requiredApprovals`로 표현. 보안 민감 scope는 N-of-M 소유자 정족수 권장.
- **Byzantine**: member 키 탈취 시 그 권한까지 위조 가능 → 키 폐기(revocation) 목록을 Membership에 `expiresAt`/`revokedAt`로. admin 키는 하드웨어/threshold 권장.
- **scoped maintainer**: `Membership.scopes` + `OwnerRule`로 "이 패키지만 merge 가능" 표현.

## 9. 권한 ≠ 최신성 — stale 고권한 결정 문제

권한만 보면 치명적 구멍이 생긴다: **인과적으로 뒤처진 고권한자가 신선한 결정을 덮어쓴다.**

> 시나리오: 원격(avcshub)은 D1→…→D10까지 진행. 로컬은 D1까지만 sync된 채 고권한자가 D1 위에 D2'를 만들어 push.

권한만 적용하면:
- 같은 conflict key를 D5와 D2'가 다르게 결정 → 권한 높은 D2'가 이김 → D2~D4 맥락을 **못 본 채** 8단계 결정을 덮어씀 (stale-clobber)
- 보호 head를 순진하게 받으면 10 → 2로 **롤백** (lost-update)

**핵심: 권한은 최신성을 대체하지 않는다.** 고권한자의 D2'는 D2~D10을 *본 적이 없다*. 해결은 §4.0(인과적 최신성 전제) + §6(head CAS)로, GitHub의 non-fast-forward 거부와 동형이다.

```
로컬:    D2'(parentHead=D1) push
avcshub: 현재 head = D10 ≠ D1  →  ❌ REJECT "head moved D1→D10, pull first"
로컬:    pull D2..D10  →  D2'의 ops는 합집합에 흡수, reduce가 D10 위에서 재평가
         ├─ D2'가 D5와 다른 key  →  자동 합쳐짐 (override 없음)
         └─ D2'가 D5와 같은 key  →  고권한자가 D2~D10을 *보고* 재결정
                                   → 그제서야 권한 적용 (D5를 명시적 supersede, 히스토리 보존)
로컬:    D11(parentHead=D10) finalize  →  ✅ 수락
```

- **operation은 유실되지 않는다** — append-only union이라 D2'의 코드는 살아서 현재 head 위에서 재평가될 뿐. (git push 거부돼도 로컬 커밋이 남아 rebase하는 것과 동일)
- **고권한자의 최종 결정권은 보존** — 단 "informed 권한 우선": 정보를 갖춘 뒤에만 그 권한이 적용된다.

## 다음 단계 (구현 시 Phase 7에 포함)

1. operation 서명 필수화 + avcshub push 게이트(서명/역할 검증)
2. Membership/Protection/Approval/**Finalize** 객체 + root 키 부트스트랩
3. reducer 결정 우선순위: createdAt → **인과적 최신성 → 권한 가중치** (§4)
4. canonical policy/protection을 avcshub가 게시, 클라이언트 pull
5. **head CAS finalize**(non-fast-forward 거부, §6) + causal-complete 게이트

→ [07 — 로드맵](07-roadmap.md)의 Phase 7(sync)와 함께 구현. 이 문서는 **설계 합의용**이며 코드는 아직 미변경.
