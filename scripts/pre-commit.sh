#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

MARKER="$(git rev-parse --git-path aimux/pre-commit-ok)"
mkdir -p "$(dirname "$MARKER")"
rm -f "$MARKER"

node scripts/run-yarn.mjs native:fmt:staged
bash scripts/check-index-typecheck.sh
bash scripts/check-index-native-clippy.sh
npx lint-staged --no-stash --no-hide-partially-staged

git write-tree >"$MARKER"
