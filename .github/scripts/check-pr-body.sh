#!/usr/bin/env bash
# PR 본문을 검사한다. 본문은 PR_BODY 환경변수로 받는다(워크플로 식을 셸에 바로 넣지 않는다 —
# 본문은 PR 을 연 사람이 쓴 글이라 셸 주입 통로가 된다).
#
# 1. 이미지 금지: 공개 저장소의 PR 본문 이미지는 지워도 첨부 주소가 남는다. 스크린샷이
#    필요하면 저장소 밖(채팅 첨부)에 둔다. 마크다운 이미지·<img>·첨부 주소·raw 링크를 막는다.
# 2. 실제 테넌트 호스트 금지: `<이름>.harkroom.com` 은 실제 사용자의 서버 주소다. 본문에는
#    `<tenant>.harkroom.com` 처럼 자리표시자로 쓴다. 공개 호스트만 허용 목록에 둔다.
#    TENANT_HOST_CHECK=off 이면 건너뛴다(테넌트를 다루는 비공개 저장소용).
set -euo pipefail
set -f
body=${PR_BODY:-}
ALLOWED_HOSTS_RE=${ALLOWED_HOSTS_RE:-'^(gate|www|example)\.harkroom\.com$'}
bad=0

# 마크다운 이미지(`![` — 인라인·참조형·단축 참조형 모두)·HTML 이미지 태그(<img>·<picture>·<source>·<video>, srcset)·
# GitHub 첨부와 githubusercontent 전체·raw 링크(/raw/, ?raw=true).
IMG_RE='!\[|<img([[:space:]/>]|$)|<(picture|source|video)([[:space:]/>]|$)|srcset[[:space:]]*=|user-attachments|githubusercontent\.com|github\.com/[^[:space:])]*/raw/|[?&]raw=true'
img=$(printf '%s\n' "$body" | grep -niE "$IMG_RE" || true)
if [ -n "$img" ]; then
  while IFS= read -r l; do echo "::error::PR 본문 ${l%%:*}번째 줄에 이미지·첨부·raw 링크가 있다 — 스크린샷은 저장소 밖(채팅 첨부)에 둔다"; done <<<"$img"
  bad=1
elif printf '%s' "$body" | tr '\r\n' '  ' | grep -qiE "$IMG_RE"; then
  # 줄바꿈으로 쪼갠 것(![a⏎b](url) 등)은 한 줄로 합쳐서 다시 본다
  echo "::error::PR 본문에 여러 줄에 걸친 이미지·첨부 표기가 있다 — 스크린샷은 저장소 밖(채팅 첨부)에 둔다"
  bad=1
fi

if [ "${TENANT_HOST_CHECK:-on}" != off ]; then
  hosts=$(printf '%s\n' "$body" | grep -oiE '[a-z0-9-]+\.harkroom\.com' | tr 'A-Z' 'a-z' | sort -u | grep -vE "$ALLOWED_HOSTS_RE" || true)
  if [ -n "$hosts" ]; then
    echo "::error::PR 본문에 허용 목록 밖의 harkroom.com 하위 호스트가 $(printf '%s\n' "$hosts" | wc -l | tr -d ' ')개 있다 — <tenant>.harkroom.com 처럼 자리표시자로 쓴다"
    bad=1
  fi
fi

[ "$bad" = 0 ] && echo "PR 본문 검사 통과"
exit "$bad"
