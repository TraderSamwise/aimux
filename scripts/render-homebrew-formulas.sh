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
  DARWIN_ARM64, LINUX_ARM64, LINUX_X64
  LOCAL_DARWIN_ARM64, LOCAL_LINUX_ARM64, LOCAL_LINUX_X64

Optional environment:
  AIMUX_HOMEBREW_FORMULA_DIR  Output directory, default tap/Formula
  AIMUX_HOMEBREW_BASE_URL     URL prefix for assets, default GitHub release URL
  AIMUX_HOMEBREW_BOTTLE_DIR   Directory containing aimux.bottles.tsv files
  AIMUX_HOMEBREW_BOTTLE_ROOT_URL
                               URL prefix for bottles, default AIMUX_HOMEBREW_BASE_URL
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
  DARWIN_ARM64 LINUX_ARM64 LINUX_X64 \
  LOCAL_DARWIN_ARM64 LOCAL_LINUX_ARM64 LOCAL_LINUX_X64
do
  need_env "$name"
done

FORMULA_DIR="${AIMUX_HOMEBREW_FORMULA_DIR:-tap/Formula}"
BASE_URL="${AIMUX_HOMEBREW_BASE_URL:-"https://github.com/TraderSamwise/aimux/releases/download/$TAG"}"
BASE_URL="${BASE_URL%/}"
BOTTLE_ROOT_URL="${AIMUX_HOMEBREW_BOTTLE_ROOT_URL:-"$BASE_URL"}"
BOTTLE_ROOT_URL="${BOTTLE_ROOT_URL%/}"

mkdir -p "$FORMULA_DIR"

render_ruby_cellar() {
  local cellar="$1"
  case "$cellar" in
    any | :any)
      printf ':any'
      ;;
    any_skip_relocation | :any_skip_relocation)
      printf ':any_skip_relocation'
      ;;
    /*)
      printf '"%s"' "$cellar"
      ;;
    *)
      fail "unsupported bottle cellar value: $cellar"
      ;;
  esac
}

render_bottle_block() {
  local formula="$1"
  local bottle_dir="${AIMUX_HOMEBREW_BOTTLE_DIR:-}"
  local metadata_file count line tag cellar sha filename local_filename row_formula ruby_cellar seen_tags
  if [ -z "$bottle_dir" ]; then
    return 0
  fi
  metadata_file="$bottle_dir/$formula.bottles.tsv"
  if [ ! -f "$metadata_file" ]; then
    fail "missing Homebrew bottle metadata for $formula: $metadata_file"
  fi
  count=0
  seen_tags="|"
  printf '\n  bottle do\n'
  printf '    root_url "%s"\n' "$BOTTLE_ROOT_URL"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '' | '#'*)
        continue
        ;;
    esac
    IFS="$(printf '\t')" read -r tag cellar sha filename local_filename row_formula <<EOF
$line
EOF
    if [ "$row_formula" != "$formula" ]; then
      fail "wrong formula in Homebrew bottle metadata for $formula $tag: ${row_formula:-<missing>}"
    fi
    case "$seen_tags" in
      *"|$tag|"*)
        fail "duplicate Homebrew bottle tag for $formula: $tag"
        ;;
    esac
    seen_tags="${seen_tags}${tag}|"
    if ! printf '%s\n' "$tag" | grep -Eq '^[A-Za-z0-9_]+$'; then
      fail "invalid bottle tag for $formula: $tag"
    fi
    if ! printf '%s\n' "$sha" | grep -Eq '^[a-fA-F0-9]{64}$'; then
      fail "invalid bottle sha256 for $formula $tag: $sha"
    fi
    ruby_cellar="$(render_ruby_cellar "$cellar")"
    printf '    sha256 cellar: %s, %s: "%s"\n' "$ruby_cellar" "$tag" "$sha"
    count=$((count + 1))
  done < "$metadata_file"
  if [ "$count" -eq 0 ]; then
    fail "empty Homebrew bottle metadata for $formula: $metadata_file"
  fi
  printf '  end\n'
}

AIMUX_BOTTLE_BLOCK="$(render_bottle_block aimux)" || exit $?
AIMUX_LOCAL_BOTTLE_BLOCK="$(render_bottle_block aimux-local)" || exit $?

cat > "$FORMULA_DIR/aimux.rb" <<EOF
class Aimux < Formula
  desc "Local agent multiplexer for AI coding tools with native TUIs"
  homepage "https://aimux.app"
  version "${VERSION}"
  license "MIT"
${AIMUX_BOTTLE_BLOCK}

  on_macos do
    on_arm do
      url "${BASE_URL}/aimux-darwin-arm64.tar.gz"
      sha256 "${DARWIN_ARM64}"
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
${AIMUX_LOCAL_BOTTLE_BLOCK}

  on_macos do
    on_arm do
      url "${BASE_URL}/aimux-local-darwin-arm64.tar.gz"
      sha256 "${LOCAL_DARWIN_ARM64}"
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
