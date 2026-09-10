#!/usr/bin/env bash
set -euo pipefail

if ! command -v rustfmt >/dev/null 2>&1; then
  echo "rustfmt is required to check staged Rust files." >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aimux-staged-rustfmt-XXXXXX")"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

failed=0

while IFS= read -r -d '' file; do
  temp_file="$TMP_ROOT/$file"
  mkdir -p "$(dirname "$temp_file")"
  if ! git show ":$file" >"$temp_file"; then
    failed=1
    continue
  fi
  if ! rustfmt --edition 2024 --check "$temp_file"; then
    echo "staged Rust file is not rustfmt-clean: $file" >&2
    failed=1
  fi
done < <(git diff --cached --name-only --diff-filter=ACMR -z -- '*.rs')

if [ "$failed" -ne 0 ]; then
  echo "Run rustfmt on the staged Rust files before committing." >&2
  exit 1
fi
