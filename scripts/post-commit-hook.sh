#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

if ! bash scripts/check-commit-hook-attestations.sh HEAD^..HEAD; then
  echo "aimux: HEAD is missing a valid pre-commit attestation; do not mark this work delivered." >&2
fi
