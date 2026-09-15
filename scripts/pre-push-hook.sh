#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

yarn verify:push

while read -r local_ref local_sha remote_ref remote_sha; do
  if [ -z "${local_ref:-}" ] || [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi

  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    bash scripts/check-commit-hook-attestations.sh "$local_sha"
  else
    bash scripts/check-commit-hook-attestations.sh "$remote_sha..$local_sha"
  fi
done
