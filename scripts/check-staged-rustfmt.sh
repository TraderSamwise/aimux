#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

if ! command -v rustfmt >/dev/null 2>&1; then
  echo "rustfmt is required to check staged Rust files." >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aimux-staged-rustfmt-XXXXXX")"
SCRIPT_COMPLETED=0
cleanup() {
  cleanup_status=$?
  set +e
  if [ "$cleanup_status" -eq 0 ] && [ "${SCRIPT_COMPLETED:-0}" -ne 1 ]; then
    cleanup_status=1
  fi
  rm -rf "$TMP_ROOT"
  exit "$cleanup_status"
}
trap cleanup EXIT
if [ "${AIMUX_TRAP_STATUS_PROOF:-}" = "scripts/check-staged-rustfmt.sh" ]; then
  : "${AIMUX_TRAP_STATUS_PROOF_UNSET}"
fi

failed=0

while IFS= read -r -d '' file; do
  temp_file="$TMP_ROOT/$file"
  mkdir -p "$(dirname "$temp_file")"
  if ! git show ":$file" >"$temp_file"; then
    failed=1
    continue
  fi
  if ! rustfmt --edition 2024 --check --config skip_children=true "$temp_file"; then
    echo "staged Rust file is not rustfmt-clean: $file" >&2
    failed=1
  fi
done < <(git diff --cached --name-only --diff-filter=ACMR -z -- '*.rs')

if [ "$failed" -ne 0 ]; then
  echo "Run rustfmt on the staged Rust files before committing." >&2
  exit 1
fi
SCRIPT_COMPLETED=1
