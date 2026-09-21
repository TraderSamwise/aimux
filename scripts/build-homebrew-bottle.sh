#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: scripts/build-homebrew-bottle.sh aimux|aimux-local

Builds a genuine Homebrew bottle for an Aimux formula by installing the rendered
formula with `brew install --build-bottle`, then running `brew bottle`.

Required environment is the same release metadata used by
scripts/render-homebrew-formulas.sh:
  TAG, VERSION
  DARWIN_ARM64, DARWIN_X64, LINUX_ARM64, LINUX_X64
  LOCAL_DARWIN_ARM64, LOCAL_DARWIN_X64, LOCAL_LINUX_ARM64, LOCAL_LINUX_X64

Optional environment:
  AIMUX_HOMEBREW_BASE_URL          Source asset URL prefix
  AIMUX_HOMEBREW_BOTTLE_ROOT_URL   Bottle URL prefix, default source prefix
  AIMUX_HOMEBREW_BOTTLE_OUT_DIR    Output directory, default homebrew-bottles
  AIMUX_HOMEBREW_BREW              brew executable, default brew
USAGE
}

fail() {
  printf 'aimux Homebrew bottle build failed: %s\n' "$*" >&2
  exit 1
}

append_standard_path_dirs() {
  local current_path="${PATH:-}"
  for dir in /usr/local/bin /opt/homebrew/bin /usr/bin /bin /usr/sbin /sbin; do
    [ -d "$dir" ] || continue
    case ":$current_path:" in
      *":$dir:"*) ;;
      *) current_path="${current_path:+$current_path:}$dir" ;;
    esac
  done
  PATH="$current_path"
  export PATH
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi
if [ "$#" -ne 1 ]; then
  usage >&2
  fail "expected exactly one formula name"
fi

FORMULA="$1"
case "$FORMULA" in
  aimux | aimux-local) ;;
  *) fail "unsupported formula: $FORMULA" ;;
esac

append_standard_path_dirs
for command in awk find mkdir mktemp mv node rm sed; do
  need "$command"
done
BREW="${AIMUX_HOMEBREW_BREW:-brew}"
if ! command -v "$BREW" >/dev/null 2>&1; then
  fail "missing brew executable: $BREW"
fi

OUT_DIR="${AIMUX_HOMEBREW_BOTTLE_OUT_DIR:-homebrew-bottles}"
BASE_URL="${AIMUX_HOMEBREW_BASE_URL:-"https://github.com/TraderSamwise/aimux/releases/download/${TAG:-}"}"
BASE_URL="${BASE_URL%/}"
BOTTLE_ROOT_URL="${AIMUX_HOMEBREW_BOTTLE_ROOT_URL:-"$BASE_URL"}"
BOTTLE_ROOT_URL="${BOTTLE_ROOT_URL%/}"
TMP_DIR="$(mktemp -d)"
STAGING_TAP="aimux/bottle-${FORMULA//-/_}-$$"
CREATED_STAGING_TAP=0

cleanup() {
  if [ "$CREATED_STAGING_TAP" -eq 1 ]; then
    "$BREW" untap "$STAGING_TAP" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

. "$ROOT_DIR/scripts/lib/run-and-capture.sh"

canonicalize_bottle_tarballs() {
  local metadata_file="$1"
  local output_dir="$2"
  local tag cellar sha filename local_filename source_path target_path
  while IFS="$(printf '\t')" read -r tag cellar sha filename local_filename || [ -n "$tag$cellar$sha$filename$local_filename" ]; do
    case "$tag" in
      "" | "#"*) continue ;;
    esac
    if [ -z "$filename" ] || [ -z "$local_filename" ]; then
      fail "bottle metadata row for $FORMULA $tag is missing filename/local_filename"
    fi
    source_path="$output_dir/$local_filename"
    target_path="$output_dir/$filename"
    if [ "$source_path" = "$target_path" ]; then
      [ -f "$target_path" ] || fail "brew bottle did not produce expected archive: $target_path"
      continue
    fi
    [ -f "$source_path" ] || fail "brew bottle did not produce local archive from metadata: $source_path"
    if [ -e "$target_path" ]; then
      fail "canonical bottle archive already exists before rename: $target_path"
    fi
    mv "$source_path" "$target_path"
    printf 'Renamed Homebrew bottle archive for upload: %s -> %s\n' "$local_filename" "$filename"
  done < "$metadata_file"
}

if "$BREW" tap | grep -Fx "$STAGING_TAP" >/dev/null 2>&1; then
  fail "temporary Homebrew tap already exists: $STAGING_TAP"
fi
run_and_capture "Homebrew bottle tap creation" "$TMP_DIR/tap-new.log" \
  "$BREW" tap-new "$STAGING_TAP" --no-git
CREATED_STAGING_TAP=1
if "$BREW" help trust >/dev/null 2>&1; then
  run_and_capture "Homebrew bottle tap trust" "$TMP_DIR/tap-trust.log" \
    "$BREW" trust "$STAGING_TAP"
fi

TAP_REPO="$("$BREW" --repo "$STAGING_TAP")"
FORMULA_DIR="$TAP_REPO/Formula"
export AIMUX_HOMEBREW_FORMULA_DIR="$FORMULA_DIR"
export AIMUX_HOMEBREW_BASE_URL="$BASE_URL"
bash "$ROOT_DIR/scripts/render-homebrew-formulas.sh"

FORMULA_REF="$STAGING_TAP/$FORMULA"
if "$BREW" list --formula --versions "$FORMULA" >/dev/null 2>&1; then
  fail "$FORMULA is already installed in this Homebrew prefix; refusing to overwrite it"
fi

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
export HOMEBREW_NO_AUTO_UPDATE="${HOMEBREW_NO_AUTO_UPDATE:-1}"
export HOMEBREW_NO_ENV_HINTS="${HOMEBREW_NO_ENV_HINTS:-1}"

run_and_capture "Homebrew build-bottle install for $FORMULA" "$TMP_DIR/install-build-bottle.log" \
  "$BREW" install --formula --build-bottle "$FORMULA_REF"

(
  cd "$OUT_DIR"
  run_and_capture "Homebrew bottle archive for $FORMULA" "$TMP_DIR/bottle.log" \
    "$BREW" bottle --json --no-rebuild --root-url "$BOTTLE_ROOT_URL" "$FORMULA_REF"
)

shopt -s nullglob
bottle_json=("$OUT_DIR"/*.bottle.json)
shopt -u nullglob
if [ "${#bottle_json[@]}" -eq 0 ]; then
  fail "brew bottle produced no JSON for $FORMULA in $OUT_DIR"
fi

node "$ROOT_DIR/scripts/homebrew-bottle-metadata.mjs" \
  --formula "$FORMULA" \
  --output "$OUT_DIR/$FORMULA.bottles.tsv" \
  "${bottle_json[@]}"
canonicalize_bottle_tarballs "$OUT_DIR/$FORMULA.bottles.tsv" "$OUT_DIR"

printf 'Built Homebrew bottle for %s:\n' "$FORMULA"
printf '  output: %s\n' "$OUT_DIR"
printf '  metadata: %s\n' "$OUT_DIR/$FORMULA.bottles.tsv"
