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

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s <release-dir>\n' "$0" >&2
  exit 2
fi

RELEASE_DIR="$1"
[ -d "$RELEASE_DIR" ] || fail "release directory not found: $RELEASE_DIR"

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

for command in grep shasum tar mktemp rm sed; do
  need "$command"
done

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

verify_checksum() {
  local asset="$1"
  local sha_path="$2"
  local output

  if ! output="$(cd "$RELEASE_DIR" && shasum -a 256 -c "$(basename "$sha_path")" 2>&1)"; then
    printf 'checksum mismatch for release asset: %s\n%s\n' "$asset" "$output" >&2
    return 1
  fi
}

verify_archive_shape() {
  local asset_path="$1"
  local platform_arch="$2"
  local expected_variant="$3"
  local list_path variant

  list_path="$TMP_DIR/$(basename "$asset_path").list"
  if ! tar -tzf "$asset_path" > "$list_path" 2>"$list_path.err"; then
    printf 'release asset is not a readable tar.gz archive: %s\n' "$asset_path" >&2
    sed 's/^/  /' "$list_path.err" >&2
    return 1
  fi
  for entry in \
    aimux/VERSION \
    aimux/BUILD_STAMP \
    aimux/PACKAGE_PROFILE \
    aimux/BUILD_VARIANT \
    "aimux/native/$platform_arch/aimux"
  do
    if ! grep -Fx "$entry" "$list_path" >/dev/null 2>&1; then
      printf 'release asset is missing expected archive entry: %s in %s\n' "$entry" "$asset_path" >&2
      return 1
    fi
  done
  if ! variant="$(tar -xOzf "$asset_path" aimux/BUILD_VARIANT 2>"$list_path.variant.err" | sed -n '1{s/[[:space:]]*$//;p;}')"; then
    printf 'could not read BUILD_VARIANT from release asset: %s\n' "$asset_path" >&2
    sed 's/^/  /' "$list_path.variant.err" >&2
    return 1
  fi
  if [ "$variant" != "$expected_variant" ]; then
    printf 'release asset BUILD_VARIANT mismatch for %s: expected %s, got %s\n' \
      "$asset_path" "$expected_variant" "$variant" >&2
    return 1
  fi
}

missing=0
for platform in darwin linux; do
  for arch in arm64 x64; do
    for variant in full local; do
      if [ "$variant" = "local" ]; then
        asset="aimux-local-${platform}-${arch}.tar.gz"
      else
        asset="aimux-${platform}-${arch}.tar.gz"
      fi
      asset_path="$RELEASE_DIR/$asset"
      sha_path="$RELEASE_DIR/$asset.sha256"
      provenance_path="$RELEASE_DIR/$asset.provenance.json"
      sbom_path="$RELEASE_DIR/$asset.sbom.spdx.json"

      if [ ! -f "$asset_path" ]; then
        printf 'missing release asset: %s\n' "$asset_path" >&2
        missing=1
      elif [ ! -r "$asset_path" ]; then
        printf 'release asset is not readable: %s\n' "$asset_path" >&2
        missing=1
      fi
      if [ ! -f "$sha_path" ]; then
        printf 'missing release checksum file: %s\n' "$sha_path" >&2
        missing=1
      elif [ ! -r "$sha_path" ]; then
        printf 'release checksum file is not readable: %s\n' "$sha_path" >&2
        missing=1
      elif ! grep -F " $asset" "$sha_path" >/dev/null 2>&1; then
        printf 'release sha file does not name its asset: %s\n' "$sha_path" >&2
        missing=1
      elif [ -f "$asset_path" ] && ! verify_checksum "$asset" "$sha_path"; then
        missing=1
      fi
      if [ -f "$asset_path" ] && ! verify_archive_shape "$asset_path" "${platform}-${arch}" "$variant"; then
        missing=1
      fi
      if [ ! -f "$provenance_path" ]; then
        printf 'missing release provenance file: %s\n' "$provenance_path" >&2
        missing=1
      elif [ ! -r "$provenance_path" ]; then
        printf 'release provenance file is not readable: %s\n' "$provenance_path" >&2
        missing=1
      fi
      if [ ! -f "$sbom_path" ]; then
        printf 'missing release SBOM file: %s\n' "$sbom_path" >&2
        missing=1
      elif [ ! -r "$sbom_path" ]; then
        printf 'release SBOM file is not readable: %s\n' "$sbom_path" >&2
        missing=1
      fi
    done
  done
done

if [ "$missing" -ne 0 ]; then
  exit 1
fi
