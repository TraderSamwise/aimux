#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

fail() {
  printf 'aimux release asset set verification failed: %s\n' "$*" >&2
  exit 1
}

LITE_BOUNDARY_CHECKER=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --lite-boundary-checker)
      [ "$#" -ge 2 ] || fail "--lite-boundary-checker requires a path"
      LITE_BOUNDARY_CHECKER="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -*)
      printf 'Usage: %s [--lite-boundary-checker <path>] <release-dir>\n' "$0" >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s [--lite-boundary-checker <path>] <release-dir>\n' "$0" >&2
  exit 2
fi

RELEASE_DIR="$1"
[ -d "$RELEASE_DIR" ] || fail "release directory not found: $RELEASE_DIR"
if [ -n "$LITE_BOUNDARY_CHECKER" ] && [ ! -x "$LITE_BOUNDARY_CHECKER" ]; then
  fail "lite boundary checker is not executable: $LITE_BOUNDARY_CHECKER"
fi

missing=0
for platform in darwin linux; do
  for arch in arm64 x64; do
    for variant in full lite; do
      if [ "$variant" = "lite" ]; then
        asset="aimux-lite-${platform}-${arch}.tar.gz"
      else
        asset="aimux-${platform}-${arch}.tar.gz"
      fi
      for path in "$RELEASE_DIR/$asset" "$RELEASE_DIR/$asset.sha256"; do
        if [ ! -f "$path" ]; then
          printf 'missing release asset: %s\n' "$path" >&2
          missing=1
        fi
      done
      sha_path="$RELEASE_DIR/$asset.sha256"
      if [ -f "$sha_path" ] && ! grep -F " $asset" "$sha_path" >/dev/null 2>&1; then
        printf 'release sha file does not name its asset: %s\n' "$sha_path" >&2
        missing=1
      fi
      if [ "$variant" = "lite" ] && [ -n "$LITE_BOUNDARY_CHECKER" ] && [ -f "$RELEASE_DIR/$asset" ]; then
        if ! "$LITE_BOUNDARY_CHECKER" --archive "$RELEASE_DIR/$asset" --platform-arch "${platform}-${arch}"; then
          printf 'lite boundary checker rejected release asset: %s\n' "$RELEASE_DIR/$asset" >&2
          missing=1
        fi
      fi
    done
  done
done

if [ "$missing" -ne 0 ]; then
  exit 1
fi
