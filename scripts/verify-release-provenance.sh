#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

fail() {
  printf 'release provenance verification failed: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

if [ "$#" -ne 4 ]; then
  fail "usage: scripts/verify-release-provenance.sh <release-dir> <asset> <platform-arch> <full|lite>"
fi

for command in awk grep python3 shasum sed; do
  need "$command"
done

RELEASE_DIR="$1"
ASSET="$2"
PLATFORM_ARCH="$3"
EXPECTED_VARIANT="$4"
case "$EXPECTED_VARIANT" in
  full | lite) ;;
  *) fail "invalid expected variant: $EXPECTED_VARIANT" ;;
esac

ASSET_PATH="$RELEASE_DIR/$ASSET"
SHA_PATH="$RELEASE_DIR/$ASSET.sha256"
PROVENANCE_PATH="$RELEASE_DIR/$ASSET.provenance.json"
SBOM_PATH="$RELEASE_DIR/$ASSET.sbom.spdx.json"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for pair in \
  "asset:$ASSET_PATH" \
  "checksum:$SHA_PATH" \
  "provenance:$PROVENANCE_PATH" \
  "SBOM:$SBOM_PATH"
do
  label="${pair%%:*}"
  path="${pair#*:}"
  [ -f "$path" ] || fail "$label file is missing for $ASSET: $path"
  [ -r "$path" ] || fail "$label file is not readable for $ASSET: $path"
done

checksum_line="$(sed -n '1p' "$SHA_PATH")"
expected_sha="$(printf '%s\n' "$checksum_line" | awk '{ print $1 }')"
named_asset="$(printf '%s\n' "$checksum_line" | awk '{ print $2 }')"
if ! printf '%s\n' "$expected_sha" | grep -Eq '^[0-9a-fA-F]{64}$'; then
  fail "checksum file does not contain a sha256 digest for $ASSET: $SHA_PATH"
fi
if [ "$named_asset" != "$ASSET" ]; then
  fail "checksum file names ${named_asset:-"(nothing)"} but expected $ASSET: $SHA_PATH"
fi
actual_sha="$(shasum -a 256 "$ASSET_PATH" | awk '{ print $1 }')"
if [ "$actual_sha" != "$expected_sha" ]; then
  fail "checksum mismatch for $ASSET: expected $expected_sha, got $actual_sha"
fi

require_json_string() {
  local path="$1"
  local key="$2"
  local expected="$3"
  local description="$4"
  if ! grep -F "\"$key\": \"$expected\"" "$path" >/dev/null 2>&1; then
    fail "$description mismatch for $ASSET: expected $expected"
  fi
}

require_json_string "$PROVENANCE_PATH" "schemaVersion" "https://aimux.app/schemas/release-provenance.v1.json" "provenance schema"
require_json_string "$PROVENANCE_PATH" "package" "aimux" "provenance package"
require_json_string "$PROVENANCE_PATH" "name" "$ASSET" "provenance artifact name"
require_json_string "$PROVENANCE_PATH" "sha256" "$actual_sha" "provenance sha256"
require_json_string "$PROVENANCE_PATH" "buildVariant" "$EXPECTED_VARIANT" "provenance variant"
require_json_string "$PROVENANCE_PATH" "variant" "$EXPECTED_VARIANT" "provenance build variant"
require_json_string "$PROVENANCE_PATH" "platformArch" "$PLATFORM_ARCH" "provenance platform-arch"

revision="$(sed -n 's/.*"revision": "\([^"]*\)".*/\1/p' "$PROVENANCE_PATH" | sed -n '1p')"
if ! printf '%s\n' "$revision" | grep -Eq '^[0-9a-fA-F]{40}$'; then
  fail "provenance source revision is missing or not a git sha for $ASSET"
fi
version="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$PROVENANCE_PATH" | sed -n '1p')"
if [ -z "$version" ]; then
  fail "provenance version is missing for $ASSET"
fi
for gate in assetSet boundary attestation; do
  if ! grep -F "\"$gate\":" "$PROVENANCE_PATH" >/dev/null 2>&1; then
    fail "provenance gate $gate is missing for $ASSET"
  fi
done

require_json_string "$SBOM_PATH" "spdxVersion" "SPDX-2.3" "SBOM spdxVersion"
require_json_string "$SBOM_PATH" "name" "$ASSET.sbom" "SBOM name"
if ! grep -F '"packages": [' "$SBOM_PATH" >/dev/null 2>&1; then
  fail "SBOM has no packages for $ASSET"
fi
if ! grep -F '"documentDescribes": [' "$SBOM_PATH" >/dev/null 2>&1; then
  fail "SBOM documentDescribes is empty for $ASSET"
fi
if ! python3 "$ROOT_DIR/scripts/generate-cargo-sbom.py" \
  --manifest-path "$ROOT_DIR/native/Cargo.toml" \
  --asset "$ASSET" \
  --asset-sha256 "$actual_sha" \
  --version "$version" \
  --source-revision "$revision" \
  --variant "$EXPECTED_VARIANT" \
  --platform-arch "$PLATFORM_ARCH" \
  --verify "$SBOM_PATH"; then
  fail "SBOM dependency set verification failed for $ASSET"
fi

printf 'release provenance verified for %s\n' "$ASSET"
