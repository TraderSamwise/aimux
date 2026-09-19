#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/render-homebrew-formulas.sh

Renders Formula/aimux.rb and Formula/aimux-local.rb from release metadata.

Required environment:
  TAG, VERSION
  DARWIN_ARM64, DARWIN_X64, LINUX_ARM64, LINUX_X64
  LOCAL_DARWIN_ARM64, LOCAL_DARWIN_X64, LOCAL_LINUX_ARM64, LOCAL_LINUX_X64

Optional environment:
  AIMUX_HOMEBREW_FORMULA_DIR  Output directory, default tap/Formula
  AIMUX_HOMEBREW_BASE_URL     URL prefix for assets, default GitHub release URL
USAGE
}

fail() {
  printf 'aimux Homebrew formula render failed: %s\n' "$*" >&2
  exit 1
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi
if [ "$#" -ne 0 ]; then
  usage >&2
  fail "unexpected argument: $1"
fi

need_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail "missing required environment variable: $name"
  fi
}

for name in \
  TAG VERSION \
  DARWIN_ARM64 DARWIN_X64 LINUX_ARM64 LINUX_X64 \
  LOCAL_DARWIN_ARM64 LOCAL_DARWIN_X64 LOCAL_LINUX_ARM64 LOCAL_LINUX_X64
do
  need_env "$name"
done

FORMULA_DIR="${AIMUX_HOMEBREW_FORMULA_DIR:-tap/Formula}"
BASE_URL="${AIMUX_HOMEBREW_BASE_URL:-"https://github.com/TraderSamwise/aimux/releases/download/$TAG"}"
BASE_URL="${BASE_URL%/}"

mkdir -p "$FORMULA_DIR"

cat > "$FORMULA_DIR/aimux.rb" <<EOF
class Aimux < Formula
  desc "Local agent multiplexer for AI coding tools with native TUIs"
  homepage "https://aimux.app"
  version "${VERSION}"
  license "MIT"

  on_macos do
    on_arm do
      url "${BASE_URL}/aimux-darwin-arm64.tar.gz"
      sha256 "${DARWIN_ARM64}"
    end
    on_intel do
      url "${BASE_URL}/aimux-darwin-x64.tar.gz"
      sha256 "${DARWIN_X64}"
    end
  end

  on_linux do
    on_arm do
      url "${BASE_URL}/aimux-linux-arm64.tar.gz"
      sha256 "${LINUX_ARM64}"
    end
    on_intel do
      url "${BASE_URL}/aimux-linux-x64.tar.gz"
      sha256 "${LINUX_X64}"
    end
  end

  depends_on "tmux"
  depends_on "openssl@3"
  depends_on "jemalloc"

  def install
    libexec.install Dir["*"]
    (bin/"aimux").write_env_script libexec/"bin/aimux", {}
  end

  test do
    assert_match "aimux", shell_output("#{bin}/aimux --help 2>&1", 0)
  end
end
EOF

cat > "$FORMULA_DIR/aimux-local.rb" <<EOF
class AimuxLocal < Formula
  desc "Local agent multiplexer for AI coding tools without remote control"
  homepage "https://aimux.app"
  version "${VERSION}"
  license "MIT"

  on_macos do
    on_arm do
      url "${BASE_URL}/aimux-local-darwin-arm64.tar.gz"
      sha256 "${LOCAL_DARWIN_ARM64}"
    end
    on_intel do
      url "${BASE_URL}/aimux-local-darwin-x64.tar.gz"
      sha256 "${LOCAL_DARWIN_X64}"
    end
  end

  on_linux do
    on_arm do
      url "${BASE_URL}/aimux-local-linux-arm64.tar.gz"
      sha256 "${LOCAL_LINUX_ARM64}"
    end
    on_intel do
      url "${BASE_URL}/aimux-local-linux-x64.tar.gz"
      sha256 "${LOCAL_LINUX_X64}"
    end
  end

  depends_on "tmux"
  conflicts_with "aimux", because: "both install the aimux command"

  def install
    libexec.install Dir["*"]
    (bin/"aimux").write_env_script libexec/"bin/aimux", {}
  end

  test do
    assert_match "aimux", shell_output("#{bin}/aimux --help 2>&1", 0)
  end
end
EOF

printf 'Rendered Homebrew formulas in %s\n' "$FORMULA_DIR"
