#!/usr/bin/env bash
set -u -o pipefail

RUNS="${1:-10}"
if ! [[ "$RUNS" =~ ^[0-9]+$ ]] || [ "$RUNS" -lt 1 ]; then
  echo "usage: $0 [positive-run-count]" >&2
  exit 2
fi

SESSION_ID="${AIMUX_SESSION_ID:-manual}"
TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/aimux-cargo-target-$SESSION_ID}"
LOG_DIR="${ASYNC_CUTOVER_STABILITY_LOG_DIR:-/tmp/aimux-async-cutover-stability-$(date +%Y%m%d-%H%M%S)-$$}"
TEST_NAME="async_cutover_http_and_sse_surface_matches_pre_conversion_fixture"

mkdir -p "$LOG_DIR"

echo "async cutover characterization stability"
echo "runs: $RUNS"
echo "target: $TARGET_DIR"
echo "logs: $LOG_DIR"
echo "head: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo

failures=0
for run in $(seq 1 "$RUNS"); do
  log="$LOG_DIR/run-$run.log"
  start_epoch="$(date +%s)"
  echo "run $run/$RUNS: starting"
  {
    echo "run: $run/$RUNS"
    echo "started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "head: $(git rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "status:"
    git status --short 2>/dev/null || true
    echo
    echo "command:"
    echo "CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=$TARGET_DIR cargo test --manifest-path native/Cargo.toml -p aimux --test async_cutover_characterization $TEST_NAME -- --nocapture"
    echo
  } >"$log"

  CARGO_INCREMENTAL=0 \
    CARGO_TARGET_DIR="$TARGET_DIR" \
    RUST_BACKTRACE="${RUST_BACKTRACE:-1}" \
    cargo test \
      --manifest-path native/Cargo.toml \
      -p aimux \
      --test async_cutover_characterization \
      "$TEST_NAME" \
      -- --nocapture >>"$log" 2>&1
  status=$?
  elapsed=$(( $(date +%s) - start_epoch ))

  if [ "$status" -eq 0 ]; then
    echo "run $run/$RUNS: PASS (${elapsed}s) log=$log"
  else
    failures=$((failures + 1))
    echo "run $run/$RUNS: FAIL status=$status (${elapsed}s) log=$log"
    echo "run $run/$RUNS: failure context"
    echo "  head: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
    echo "  dirty files:"
    git status --short 2>/dev/null | sed 's/^/    /' || true
    echo "  log tail:"
    tail -120 "$log" | sed 's/^/    /'
  fi
done

echo
if [ "$failures" -eq 0 ]; then
  echo "stability result: PASS ($RUNS/$RUNS)"
  exit 0
fi

echo "stability result: FAIL ($failures/$RUNS failed)"
echo "logs: $LOG_DIR"
exit 1
