#!/usr/bin/env bash
# PR 커밋의 신원(author·committer)과 Co-authored-by 메일을 허용 목록과 대조한다(pr-guard.yml).
#
# 왜: 공개 저장소의 커밋 메타데이터는 지울 수 없다 — 2026-10 에 회사 메일이 들어간 커밋을
# 지우려고 히스토리를 통째로 다시 썼다. 다시 들어오지 않게 PR 단계에서 막는다.
# 금지 목록이 아니라 허용 목록인 이유: 막아야 할 주소를 여기 적으면 그 주소가 다시 공개된다.
#
# 사용: check-commit-emails.sh <base> <head>
# 허용 목록을 넓히려면 ALLOWED_EMAIL_RE 를 고친다(확장 정규식, 대소문자 무시).
set -euo pipefail
set -f  # 메일 값에 * 같은 글자가 와도 파일 이름으로 펼치지 않는다
base=${1:?base}; head=${2:?head}
ALLOWED_EMAIL_RE=${ALLOWED_EMAIL_RE:-'^([^@]+@users\.noreply\.github\.com|noreply@github\.com|noreply@anthropic\.com|ljbfif50@gmail\.com)$'}

bad=0
while IFS=$'\t' read -r sha ae ce; do
  # 걸린 메일 값은 찍지 않는다 — 공개 저장소의 Actions 로그는 누구나 본다. 어느 칸인지만 알린다.
  allowed() { printf '%s\n' "$1" | grep -qiE "$ALLOWED_EMAIL_RE"; }
  allowed "$ae" || { echo "::error::${sha:0:9} author 메일이 허용 목록 밖이다"; bad=1; }
  allowed "$ce" || { echo "::error::${sha:0:9} committer 메일이 허용 목록 밖이다"; bad=1; }
  while IFS= read -r e; do
    [ -z "$e" ] && continue
    allowed "$e" || { echo "::error::${sha:0:9} Co-authored-by 메일이 허용 목록 밖이다"; bad=1; }
  done < <(git log -1 --format='%(trailers:key=Co-authored-by,valueonly,separator=%x0A)' "$sha" | sed -n 's/.*<\([^>]*\)>.*/\1/p')
done < <(git log --format='%H%x09%ae%x09%ce' "$base..$head")

[ "$bad" = 1 ] && echo "고치는 법: git config user.email 을 GitHub noreply 주소로 바꾸고 git rebase -x 'git commit --amend --no-edit --reset-author' $base"
[ "$bad" = 0 ] && echo "커밋 메일 검사 통과 ($(git rev-list --count "$base..$head")개)"
exit "$bad"
