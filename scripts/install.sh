#!/usr/bin/env sh
set -eu

REPO="${AIMUX_REPO:-TraderSamwise/aimux}"
VERSION="${AIMUX_VERSION:-latest}"
INSTALL_ROOT="${AIMUX_INSTALL_ROOT:-$HOME/.aimux/native}"
BIN_DIR="${AIMUX_BIN_DIR:-$HOME/.local/bin}"

fail() {
  printf 'aimux install failed: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) fail "unsupported platform: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x64' ;;
    arm64 | aarch64) printf 'arm64' ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
}

download() {
  url="$1"
  out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$out" "$url"
  else
    fail "missing curl or wget"
  fi
}

download_optional() {
  url="$1"
  out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out" >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$out" "$url" >/dev/null 2>&1
  else
    return 1
  fi
}

need node
need tar

node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 18 ? 0 : 1)' \
  || fail "Node.js >= 18 is required"

PLATFORM="$(detect_platform)"
ARCH="$(detect_arch)"
ASSET="aimux-${PLATFORM}-${ARCH}.tar.gz"

case "$VERSION" in
  latest)
    BASE_URL="https://github.com/$REPO/releases/latest/download"
    VERSION_LABEL="latest"
    ;;
  v*)
    BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
    VERSION_LABEL="$VERSION"
    ;;
  *)
    BASE_URL="https://github.com/$REPO/releases/download/v$VERSION"
    VERSION_LABEL="v$VERSION"
    ;;
esac

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

ARCHIVE="$TMP_DIR/$ASSET"
CHECKSUM="$TMP_DIR/$ASSET.sha256"

printf 'Downloading aimux %s for %s-%s...\n' "$VERSION_LABEL" "$PLATFORM" "$ARCH"
download "$BASE_URL/$ASSET" "$ARCHIVE"

if download_optional "$BASE_URL/$ASSET.sha256" "$CHECKSUM"; then
  if command -v shasum >/dev/null 2>&1; then
    (cd "$TMP_DIR" && shasum -a 256 -c "$ASSET.sha256" >/dev/null)
  else
    printf 'Skipping checksum verification: shasum not found.\n' >&2
  fi
fi

tar -xzf "$ARCHIVE" -C "$TMP_DIR"
[ -d "$TMP_DIR/aimux" ] || fail "release archive did not contain aimux/"

INSTALLED_VERSION="$(cat "$TMP_DIR/aimux/VERSION" 2>/dev/null || printf '%s' "$VERSION_LABEL")"
DEST="$INSTALL_ROOT/$INSTALLED_VERSION"

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
rm -rf "$DEST"
mv "$TMP_DIR/aimux" "$DEST"
chmod +x "$DEST/bin/aimux"
ln -sfn "$DEST/bin/aimux" "$BIN_DIR/aimux"

printf 'Installed aimux %s to %s\n' "$INSTALLED_VERSION" "$DEST"
printf 'Linked %s/aimux\n' "$BIN_DIR"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'Add %s to PATH to run aimux from any shell.\n' "$BIN_DIR" ;;
esac
