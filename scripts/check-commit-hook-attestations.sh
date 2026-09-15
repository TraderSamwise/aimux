#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

HOOK_PATH=".husky/commit-msg"

if [ "$#" -gt 0 ]; then
  REV_ARGS=("$@")
elif [ -n "${AIMUX_HOOK_ATTESTATION_RANGE:-}" ]; then
  REV_ARGS=("$AIMUX_HOOK_ATTESTATION_RANGE")
elif git rev-parse --verify --quiet origin/master >/dev/null; then
  REV_ARGS=("origin/master..HEAD")
else
  REV_ARGS=()
fi

if [ "${#REV_ARGS[@]}" -eq 0 ]; then
  exit 0
fi

failed=0

while IFS= read -r commit; do
  if [ -z "$commit" ]; then
    continue
  fi

  if ! git rev-parse --verify --quiet "$commit^" >/dev/null; then
    continue
  fi
  parent_count="$(git rev-list --parents -n 1 "$commit" | wc -w | tr -d '[:space:]')"
  if [ "$parent_count" -gt 2 ]; then
    continue
  fi
  if ! git cat-file -e "$commit^:$HOOK_PATH" 2>/dev/null; then
    continue
  fi

  expected="$(git show -s --format=%T "$commit")"
  actual="$(
    git log -1 --format=%B "$commit" |
      git interpret-trailers --parse |
      awk -F': ' '$1 == "Aimux-Pre-Commit" { value = $2 } END { print value }'
  )"

  if [ -z "$actual" ]; then
    echo "aimux: commit $(git rev-parse --short "$commit") is missing Aimux-Pre-Commit; hooks may have been skipped." >&2
    failed=1
    continue
  fi

  if [ "$actual" != "$expected" ]; then
    echo "aimux: commit $(git rev-parse --short "$commit") has invalid Aimux-Pre-Commit." >&2
    echo "aimux: expected $expected but found $actual." >&2
    failed=1
  fi
done < <(git rev-list --reverse "${REV_ARGS[@]}")

exit "$failed"
