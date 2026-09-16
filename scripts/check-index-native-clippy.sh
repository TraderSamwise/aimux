#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

if ! git diff --cached --name-only --diff-filter=ACMR -- 'native/**/*.rs' '*.rs' | grep -q .; then
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aimux-index-native-clippy-XXXXXX")"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

cd "$ROOT"
git checkout-index --all --force --prefix="$TMP_ROOT/"

cd "$TMP_ROOT"
CARGO_INCREMENTAL=0 \
CARGO_TARGET_DIR="${AIMUX_PRECOMMIT_CARGO_TARGET_DIR:-${TMPDIR:-/tmp}/aimux-cargo-target-precommit-$(id -u)}" \
  cargo clippy --manifest-path native/Cargo.toml -p aimux --all-targets -- -D warnings
