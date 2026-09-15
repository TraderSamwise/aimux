#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

MSG_FILE="${1:?commit message file is required}"
MARKER="$(git rev-parse --git-path aimux/pre-commit-ok)"

if [ ! -s "$MARKER" ]; then
  echo "aimux: missing pre-commit attestation; run git commit without --no-verify." >&2
  exit 1
fi

EXPECTED="$(tr -d '[:space:]' <"$MARKER")"
ACTUAL="$(git write-tree)"

if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "aimux: staged tree changed after pre-commit ran." >&2
  echo "aimux: expected $EXPECTED but found $ACTUAL." >&2
  exit 1
fi

git interpret-trailers --in-place --trailer "Aimux-Pre-Commit: $ACTUAL" "$MSG_FILE"
