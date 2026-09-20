#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be sourced from bash\n' "${BASH_SOURCE[0]}" >&2
  exit 2
fi

run_and_capture() {
  local label="$1"
  local outfile="$2"
  shift 2
  printf 'Running %s: %s\n' "$label" "$*"
  set +e
  "$@" >"$outfile" 2>&1
  local status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    printf '%s passed\n' "$label"
    return 0
  fi
  printf '%s failed with exit %s\n' "$label" "$status" >&2
  sed 's/^/  /' "$outfile" >&2
  return "$status"
}
