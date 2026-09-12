#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/aimux-cargo-target-${AIMUX_SESSION_ID:-async-audit}-$$}"

exec cargo clippy \
  --manifest-path "$repo_root/native/Cargo.toml" \
  -p aimux \
  --all-targets \
  -- \
  -D warnings \
  -D clippy::await_holding_lock \
  -D clippy::await_holding_refcell_ref \
  -D clippy::await_holding_invalid_type
