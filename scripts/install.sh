#!/usr/bin/env sh
set -eu

REPO="${AIMUX_REPO:-TraderSamwise/aimux}"
VERSION="${AIMUX_VERSION:-latest}"
INSTALL_ROOT="${AIMUX_INSTALL_ROOT:-$HOME/.aimux/native}"
BIN_DIR="${AIMUX_BIN_DIR:-$HOME/.local/bin}"
LOCAL_ARCHIVE="${AIMUX_ARCHIVE:-${1:-}}"
HAD_EXISTING_INSTALL=0
INSTALL_VARIANT="${AIMUX_INSTALL_VARIANT:-full}"
case "$INSTALL_VARIANT" in
  full | local) ;;
  *) printf 'aimux install failed: unsupported AIMUX_INSTALL_VARIANT: %s\n' "$INSTALL_VARIANT" >&2; exit 1 ;;
esac

append_standard_path_dirs() {
  current_path="${PATH:-}"
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

append_standard_path_dirs
need tar

if [ -e "$BIN_DIR/aimux" ] || [ -L "$BIN_DIR/aimux" ]; then
  HAD_EXISTING_INSTALL=1
elif [ -d "$INSTALL_ROOT" ]; then
  for existing_install in "$INSTALL_ROOT"/*; do
    if [ -e "$existing_install" ]; then
      HAD_EXISTING_INSTALL=1
      break
    fi
  done
fi

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

PLATFORM="$(detect_platform)"
ARCH="$(detect_arch)"
if [ "$INSTALL_VARIANT" = "local" ]; then
  ASSET="aimux-local-${PLATFORM}-${ARCH}.tar.gz"
else
  ASSET="aimux-${PLATFORM}-${ARCH}.tar.gz"
fi

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
SCRIPT_COMPLETED=0
cleanup() {
  cleanup_status=$?
  set +e
  if [ "$cleanup_status" -eq 0 ] && [ "${SCRIPT_COMPLETED:-0}" -ne 1 ]; then
    cleanup_status=1
  fi
  rm -rf "$TMP_DIR"
  exit "$cleanup_status"
}
trap cleanup EXIT
if [ "${AIMUX_TRAP_STATUS_PROOF:-}" = "scripts/install.sh" ]; then
  : "${AIMUX_TRAP_STATUS_PROOF_UNSET}"
fi

ARCHIVE="$TMP_DIR/$ASSET"
CHECKSUM="$TMP_DIR/$ASSET.sha256"

if [ -n "$LOCAL_ARCHIVE" ]; then
  [ -f "$LOCAL_ARCHIVE" ] || fail "local archive not found: $LOCAL_ARCHIVE"
  printf 'Installing aimux from local archive %s...\n' "$LOCAL_ARCHIVE"
  cp "$LOCAL_ARCHIVE" "$ARCHIVE"
else
  printf 'Downloading aimux %s for %s-%s...\n' "$VERSION_LABEL" "$PLATFORM" "$ARCH"
  download "$BASE_URL/$ASSET" "$ARCHIVE"

  if download_optional "$BASE_URL/$ASSET.sha256" "$CHECKSUM"; then
    if command -v shasum >/dev/null 2>&1; then
      (cd "$TMP_DIR" && shasum -a 256 -c "$ASSET.sha256" >/dev/null)
    else
      printf 'Skipping checksum verification: shasum not found.\n' >&2
    fi
  fi
fi

tar -xzf "$ARCHIVE" -C "$TMP_DIR"
[ -d "$TMP_DIR/aimux" ] || fail "release archive did not contain aimux/"
[ -f "$TMP_DIR/aimux/BUILD_STAMP" ] || fail "release archive is missing BUILD_STAMP; install a current aimux release"
[ -f "$TMP_DIR/aimux/BUILD_VARIANT" ] || fail "release archive is missing BUILD_VARIANT; install a current aimux release"
ARCHIVE_VARIANT="$(sed -n '1{s/[[:space:]]*$//;p;}' "$TMP_DIR/aimux/BUILD_VARIANT")"
case "$ARCHIVE_VARIANT" in
  full | local) ;;
  *) fail "release archive has invalid BUILD_VARIANT: $ARCHIVE_VARIANT" ;;
esac
if [ "$ARCHIVE_VARIANT" != "$INSTALL_VARIANT" ]; then
  fail "release archive BUILD_VARIANT mismatch: expected $INSTALL_VARIANT, got $ARCHIVE_VARIANT"
fi

INSTALLED_VERSION="$(cat "$TMP_DIR/aimux/VERSION" 2>/dev/null || printf '%s' "$VERSION_LABEL")"
DEST="$INSTALL_ROOT/$INSTALLED_VERSION"
NATIVE_PAYLOAD="$TMP_DIR/aimux/native/$PLATFORM-$ARCH/aimux"
[ -f "$NATIVE_PAYLOAD" ] || fail "release archive is missing native aimux binary for $PLATFORM-$ARCH"
chmod +x "$NATIVE_PAYLOAD" 2>/dev/null || true
[ -x "$NATIVE_PAYLOAD" ] || fail "native aimux binary is not executable for $PLATFORM-$ARCH"

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
rm -rf "$DEST"
mv "$TMP_DIR/aimux" "$DEST"
mkdir -p "$DEST/bin"
DEST_QUOTED="$(shell_quote "$DEST")"
BIN_SHIM_QUOTED="$(shell_quote "$BIN_DIR/aimux")"
INSTALL_ROOT_QUOTED="$(shell_quote "$INSTALL_ROOT")"
NATIVE_BIN_QUOTED="$(shell_quote "$DEST/native/$PLATFORM-$ARCH/aimux")"
cat > "$DEST/bin/aimux" <<EOF
#!/usr/bin/env sh
set -eu

AIMUX_ROOT=$DEST_QUOTED
AIMUX_NATIVE_BIN=$NATIVE_BIN_QUOTED

if [ -z "\${AIMUX_CLI_BIN:-}" ]; then AIMUX_CLI_BIN=$BIN_SHIM_QUOTED; export AIMUX_CLI_BIN; fi
if [ -z "\${AIMUX_INSTALL_ROOT:-}" ]; then AIMUX_INSTALL_ROOT=$INSTALL_ROOT_QUOTED; export AIMUX_INSTALL_ROOT; fi
if [ -z "\${AIMUX_HOME:-}" ]; then AIMUX_HOME="\$HOME/.aimux"; export AIMUX_HOME; fi
if [ -z "\${AIMUX_DAEMON_PORT:-}" ]; then AIMUX_DAEMON_PORT="43190"; export AIMUX_DAEMON_PORT; fi
if [ -z "\${AIMUX_ENV:-}" ]; then AIMUX_ENV="production"; export AIMUX_ENV; fi
if [ -z "\${AIMUX_WEB_APP_URL:-}" ]; then AIMUX_WEB_APP_URL="https://aimux.app"; export AIMUX_WEB_APP_URL; fi
export AIMUX_ROOT AIMUX_NATIVE_BIN

if [ -x "\$AIMUX_NATIVE_BIN" ]; then
  exec "\$AIMUX_NATIVE_BIN" "\$@"
fi
printf 'aimux: native binary not found or not executable: %s\n' "\$AIMUX_NATIVE_BIN" >&2
exit 127
EOF
chmod +x "$DEST/bin/aimux"
ln -sfn "$DEST/bin/aimux" "$BIN_DIR/aimux"

printf 'Installed aimux %s to %s\n' "$INSTALLED_VERSION" "$DEST"
printf 'Linked %s/aimux\n' "$BIN_DIR"

if [ "$HAD_EXISTING_INSTALL" = "1" ]; then
  if [ "${AIMUX_SKIP_POST_INSTALL_RESTART:-}" = "1" ]; then
    printf 'Skipped post-install aimux restart because AIMUX_SKIP_POST_INSTALL_RESTART=1\n'
  else
    printf 'Repairing running aimux control plane...\n'
    RESTART_OUTPUT="$(mktemp "${TMPDIR:-/tmp}/aimux-post-install-restart.XXXXXX")"
    if "$BIN_DIR/aimux" restart --all >"$RESTART_OUTPUT" 2>&1; then
      cat "$RESTART_OUTPUT"
      rm -f "$RESTART_OUTPUT"
      printf 'Aimux control plane repaired.\n'
    else
      RESTART_STATUS=$?
      cat "$RESTART_OUTPUT" >&2
      RESTART_FAILURE_SUMMARY=$(awk '
        /^Project: / {
          project = $0
          sub(/^Project: /, "", project)
          next
        }
        /^[[:space:]]+dashboard: failed/ {
          dashboard = $0
          sub(/^[[:space:]]+dashboard: /, "", dashboard)
          if (project != "") {
            print project " dashboard " dashboard
          } else {
            print dashboard
          }
          found = 1
          exit
        }
        /^[[:space:]]+failures: / {
          failures = $0
          sub(/^[[:space:]]+/, "", failures)
        }
        END {
          if (!found && failures != "") {
            print failures
          }
        }
      ' "$RESTART_OUTPUT")
      rm -f "$RESTART_OUTPUT"
      if [ -n "$RESTART_FAILURE_SUMMARY" ]; then
        printf 'Installed aimux, but post-install restart failed (exit %s): %s. Run: %s/aimux restart --all\n' "$RESTART_STATUS" "$RESTART_FAILURE_SUMMARY" "$BIN_DIR" >&2
      else
        printf 'Installed aimux, but post-install restart failed (exit %s). Run: %s/aimux restart --all\n' "$RESTART_STATUS" "$BIN_DIR" >&2
      fi
      exit 75
    fi
  fi
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'Add %s to PATH to run aimux from any shell.\n' "$BIN_DIR" ;;
esac
SCRIPT_COMPLETED=1
