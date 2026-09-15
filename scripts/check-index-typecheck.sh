#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || git rev-parse --git-common-dir)"
case "$COMMON_DIR" in
  /*) ;;
  *) COMMON_DIR="$ROOT/$COMMON_DIR" ;;
esac
PRIMARY_ROOT="$(dirname "$COMMON_DIR")"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aimux-index-typecheck-XXXXXX")"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

cd "$ROOT"
git checkout-index --all --force --prefix="$TMP_ROOT/"

link_dependency_dir() {
  local rel="$1"
  local source=""

  has_typecheck_dependencies() {
    [ -x "$1/.bin/tsc" ]
  }

  if has_typecheck_dependencies "$ROOT/$rel"; then
    source="$ROOT/$rel"
  elif has_typecheck_dependencies "$PRIMARY_ROOT/$rel"; then
    source="$PRIMARY_ROOT/$rel"
  fi

  if [ -n "$source" ] && [ ! -e "$TMP_ROOT/$rel" ]; then
    mkdir -p "$(dirname "$TMP_ROOT/$rel")"
    ln -s "$source" "$TMP_ROOT/$rel"
  fi
}

link_dependency_dir node_modules
link_dependency_dir relay/node_modules

cd "$TMP_ROOT"
yarn typecheck
