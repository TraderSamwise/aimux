#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

STAGED_PATHS_FILE="$(mktemp "${TMPDIR:-/tmp}/aimux-index-native-clippy-paths.XXXXXX")"
TMP_ROOT=""
cleanup() {
  rm -f "$STAGED_PATHS_FILE"
  if [ -n "$TMP_ROOT" ]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

git diff --cached --name-only -z -- >"$STAGED_PATHS_FILE"
has_native_clippy_input_change=0
while IFS= read -r -d '' staged_path; do
  case "$staged_path" in
    *.rs | Cargo.toml | */Cargo.toml | Cargo.lock | */Cargo.lock)
      has_native_clippy_input_change=1
      break
      ;;
  esac
done <"$STAGED_PATHS_FILE"

if [ "$has_native_clippy_input_change" -eq 0 ]; then
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aimux-index-native-clippy-XXXXXX")"

cd "$ROOT"
git checkout-index --all --force --prefix="$TMP_ROOT/"

cd "$TMP_ROOT"
CARGO_INCREMENTAL=0 \
CARGO_TARGET_DIR="${AIMUX_PRECOMMIT_CARGO_TARGET_DIR:-${TMPDIR:-/tmp}/aimux-cargo-target-precommit-$(id -u)}" \
  cargo clippy --manifest-path native/Cargo.toml -p aimux --all-targets -- -D warnings
