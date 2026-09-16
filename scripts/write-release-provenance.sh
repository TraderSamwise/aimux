#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

fail() {
  printf 'aimux release provenance generation failed: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

json_escape() {
  awk 'BEGIN { ORS = "" } {
    gsub(/\\/, "\\\\");
    gsub(/"/, "\\\"");
    gsub(/\t/, "\\t");
    gsub(/\r/, "\\r");
    gsub(/\n/, "\\n");
    print;
  }'
}

json_string() {
  printf '%s' "$1" | json_escape
}

RELEASE_DIR=""
ASSET=""
PLATFORM_ARCH=""
BUILD_VARIANT=""
BUILD_PROFILE=""
VERSION=""
BUILD_STAMP=""
SOURCE_REVISION=""
SOURCE_REF=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release-dir)
      [ -n "${2:-}" ] && [[ "${2:-}" != --* ]] || fail "missing value for $1"
      RELEASE_DIR="$2"
      shift 2
      ;;
    --asset)
      [ -n "${2:-}" ] && [[ "${2:-}" != --* ]] || fail "missing value for $1"
      ASSET="$2"
      shift 2
      ;;
    --platform-arch)
      [ -n "${2:-}" ] && [[ "${2:-}" != --* ]] || fail "missing value for $1"
      PLATFORM_ARCH="$2"
      shift 2
      ;;
    --variant)
      [ -n "${2:-}" ] && [[ "${2:-}" != --* ]] || fail "missing value for $1"
      BUILD_VARIANT="$2"
      shift 2
      ;;
    --profile)
      [ -n "${2:-}" ] && [[ "${2:-}" != --* ]] || fail "missing value for $1"
      BUILD_PROFILE="$2"
      shift 2
      ;;
    --version)
      [ -n "${2:-}" ] && [[ "${2:-}" != --* ]] || fail "missing value for $1"
      VERSION="$2"
      shift 2
      ;;
    --build-stamp)
      [ -n "${2:-}" ] && [[ "${2:-}" != --* ]] || fail "missing value for $1"
      BUILD_STAMP="$2"
      shift 2
      ;;
    --source-revision)
      [ -n "${2:-}" ] && [[ "${2:-}" != --* ]] || fail "missing value for $1"
      SOURCE_REVISION="$2"
      shift 2
      ;;
    --source-ref)
      if [ -z "${2:-}" ] || [[ "${2:-}" == --* ]]; then
        fail "missing value for $1"
      fi
      SOURCE_REF="$2"
      shift 2
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

for command in awk basename date grep python3 shasum; do
  need "$command"
done

for required in \
  "release-dir:$RELEASE_DIR" \
  "asset:$ASSET" \
  "platform-arch:$PLATFORM_ARCH" \
  "variant:$BUILD_VARIANT" \
  "profile:$BUILD_PROFILE" \
  "version:$VERSION" \
  "build-stamp:$BUILD_STAMP" \
  "source-revision:$SOURCE_REVISION"
do
  name="${required%%:*}"
  value="${required#*:}"
  [ -n "$value" ] || fail "missing --$name"
done

case "$BUILD_VARIANT" in
  full | lite) ;;
  *) fail "invalid build variant: $BUILD_VARIANT" ;;
esac
case "$BUILD_PROFILE" in
  full | local) ;;
  *) fail "invalid build profile: $BUILD_PROFILE" ;;
esac
if ! printf '%s\n' "$SOURCE_REVISION" | grep -Eq '^[0-9a-fA-F]{40}$'; then
  fail "source revision must be a 40-character git sha: $SOURCE_REVISION"
fi

ASSET_PATH="$RELEASE_DIR/$ASSET"
[ -f "$ASSET_PATH" ] || fail "asset not found: $ASSET_PATH"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSET_SHA256="$(shasum -a 256 "$ASSET_PATH" | awk '{ print $1 }')"
CREATED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
PROVENANCE_PATH="$RELEASE_DIR/$ASSET.provenance.json"
SBOM_PATH="$RELEASE_DIR/$ASSET.sbom.spdx.json"
ASSET_BASENAME="$(basename "$ASSET")"

cat > "$PROVENANCE_PATH" <<JSON
{
  "schemaVersion": "https://aimux.app/schemas/release-provenance.v1.json",
  "package": "aimux",
  "version": "$(json_string "$VERSION")",
  "source": {
    "repository": "https://github.com/TraderSamwise/aimux",
    "revision": "$SOURCE_REVISION",
    "ref": "$(json_string "$SOURCE_REF")"
  },
  "build": {
    "profile": "$BUILD_PROFILE",
    "variant": "$BUILD_VARIANT",
    "platformArch": "$(json_string "$PLATFORM_ARCH")",
    "buildStamp": "$(json_string "$BUILD_STAMP")"
  },
  "artifact": {
    "name": "$(json_string "$ASSET_BASENAME")",
    "sha256": "$ASSET_SHA256",
    "buildProfile": "$BUILD_PROFILE",
    "buildVariant": "$BUILD_VARIANT",
    "platformArch": "$(json_string "$PLATFORM_ARCH")"
  },
  "gates": {
    "assetSet": "scripts/verify-release-asset-set.sh",
    "boundary": "scripts/check-lite-build-boundary.sh --variant $BUILD_VARIANT --archive release/$(json_string "$ASSET_BASENAME") --platform-arch $(json_string "$PLATFORM_ARCH")",
    "attestation": "gh attestation verify $(json_string "$ASSET_BASENAME") --repo TraderSamwise/aimux"
  },
  "generatedAt": "$CREATED_AT"
}
JSON

python3 "$ROOT_DIR/scripts/generate-cargo-sbom.py" \
  --manifest-path "$ROOT_DIR/native/Cargo.toml" \
  --asset "$ASSET_BASENAME" \
  --asset-sha256 "$ASSET_SHA256" \
  --version "$VERSION" \
  --source-revision "$SOURCE_REVISION" \
  --variant "$BUILD_VARIANT" \
  --platform-arch "$PLATFORM_ARCH" \
  --output "$SBOM_PATH"

printf 'Wrote %s\n' "$PROVENANCE_PATH"
