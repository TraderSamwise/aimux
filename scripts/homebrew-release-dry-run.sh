#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/homebrew-release-dry-run.sh --release-dir DIR [options]

Stages Aimux Homebrew formulas against local release assets and exercises the
same Homebrew parse/fetch/checksum path used by the public tap. By default this
does not install anything into the live Homebrew prefix. It creates and removes
a temporary local Homebrew tap because Homebrew rejects loose formula files.

Options:
  --release-dir DIR       Directory containing release assets and .sha256 files
  --tag TAG               Staging tag used in generated formula metadata
  --version VERSION       Staging version used in generated formula metadata
  --staging-dir DIR       Directory for generated formulas and proof artifacts
  --staging-tap TAP       Temporary tap name, default aimux/dry-run-<pid>
  --host-only             Exercise only the current platform's full/local assets
  --live-install          Install/uninstall staged formulas in this Homebrew prefix
  --dependency-prep-only  Prepare formula dependencies, then exit before install
  --skip-dependency-prep  Do not prepare dependencies before live install
  --ignore-dependencies   Pass --ignore-dependencies to live Homebrew installs
  --skip-asset-verification
                          Trust staged assets and run only Formula/Homebrew checks
  --skip-doctor-proof     Do not run aimux doctor after local formula install
  --skip-bad-sha-proof    Skip the deliberate mismatched SHA fetch proof
  -h, --help              Show this help

Live install mode is intentionally opt-in and refuses to run if aimux or
aimux-local is already installed, so it cannot uninstall a user's real formula.
Use --ignore-dependencies only for isolated proof prefixes where dependencies
are already irrelevant to the launcher check.
USAGE
}

fail() {
  printf 'aimux Homebrew release dry-run failed: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) fail "unsupported platform for Homebrew dry-run: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x64' ;;
    arm64 | aarch64) printf 'arm64' ;;
    *) fail "unsupported architecture for Homebrew dry-run: $(uname -m)" ;;
  esac
}

sha_for() {
  local asset="$1"
  local path="$RELEASE_DIR/$asset.sha256"
  [ -r "$path" ] || fail "missing or unreadable checksum file: $path"
  awk '{ print $1; exit }' "$path"
}

sha_for_or_placeholder() {
  local asset="$1"
  local fallback_asset="$2"
  if [ -r "$RELEASE_DIR/$asset.sha256" ]; then
    sha_for "$asset"
  else
    sha_for "$fallback_asset"
  fi
}

ensure_asset_pair() {
  local asset="$1"
  [ -r "$RELEASE_DIR/$asset" ] || fail "missing or unreadable release asset: $RELEASE_DIR/$asset"
  [ -r "$RELEASE_DIR/$asset.sha256" ] || fail "missing or unreadable checksum file: $RELEASE_DIR/$asset.sha256"
}

run_and_capture() {
  local label="$1"
  local outfile="$2"
  shift 2
  printf 'Running %s: %s\n' "$label" "$*"
  set +e
  "$@" >"$outfile" 2>&1
  local status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    printf '%s passed\n' "$label"
    return 0
  fi
  printf '%s failed with exit %s\n' "$label" "$status" >&2
  sed 's/^/  /' "$outfile" >&2
  return "$status"
}

brew_install_formula() {
  if [ "$IGNORE_DEPENDENCIES" -eq 1 ]; then
    brew install --formula --ignore-dependencies "$@"
  else
    brew install --formula "$@"
  fi
}

dependency_problem() {
  local message="$1"
  printf '%s\n' "$message" >&2
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    printf '::warning::%s\n' "$message"
  fi
}

prepare_formula_dependencies() {
  local formula="$1"
  local label="$2"
  local deps_file="$LOG_DIR/deps-$label.txt"
  local dep
  local status
  local dep_log
  local saw_dependency=0

  if [ "$IGNORE_DEPENDENCIES" -eq 1 ]; then
    printf 'Homebrew dependency preparation skipped for %s because --ignore-dependencies is set\n' "$label"
    return 0
  fi

  printf 'Resolving Homebrew dependencies for %s formula: %s\n' "$label" "$formula"
  set +e
  brew deps --formula "$formula" >"$deps_file" 2>"$LOG_DIR/deps-$label.err"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    sed 's/^/  /' "$LOG_DIR/deps-$label.err" >&2
    fail "could not determine Homebrew dependencies for $label formula with exit $status"
  fi

  while IFS= read -r dep; do
    [ -n "$dep" ] || continue
    saw_dependency=1
    dep_log="$LOG_DIR/dependency-$label-${dep//[^A-Za-z0-9_.@-]/_}.log"
    if brew list --formula --versions "$dep" >/dev/null 2>&1; then
      printf 'Preparing Homebrew dependency for %s formula: brew upgrade %s\n' "$label" "$dep"
      set +e
      brew upgrade --formula "$dep" >"$dep_log" 2>&1
      status=$?
      set -e
    else
      printf 'Preparing Homebrew dependency for %s formula: brew install %s\n' "$label" "$dep"
      set +e
      brew install --formula "$dep" >"$dep_log" 2>&1
      status=$?
      set -e
    fi
    if [ "$status" -ne 0 ]; then
      sed 's/^/  /' "$dep_log" >&2
      if brew list --formula --versions "$dep" >/dev/null 2>&1; then
        dependency_problem "Homebrew dependency preparation failed for $dep needed by $label formula with exit $status after the dependency was installed; this is a Homebrew runner environment/dependency problem, not an aimux formula failure. Continuing to the aimux formula gate."
      else
        fail "Homebrew dependency preparation failed for $dep needed by $label formula with exit $status before the dependency was installed; this is a Homebrew runner environment/dependency problem, not an aimux formula failure."
      fi
    else
      printf 'Homebrew dependency preparation passed for %s needed by %s formula\n' "$dep" "$label"
    fi
    if ! brew list --formula --versions "$dep" >/dev/null 2>&1; then
      sed 's/^/  /' "$dep_log" >&2
      fail "Homebrew dependency preparation did not leave $dep installed for $label formula; this is a Homebrew runner environment/dependency problem, not an aimux formula failure."
    fi
  done < "$deps_file"

  if [ "$saw_dependency" -eq 0 ]; then
    printf 'Homebrew dependency preparation found no dependencies for %s formula\n' "$label"
  fi
}

install_formula_for_gate() {
  local formula="$1"
  local label="$2"
  local install_log="$LOG_DIR/install-$label.log"
  local status

  printf 'Running Homebrew gated install for %s formula: brew_install_formula %s\n' "$label" "$formula"
  set +e
  brew_install_formula "$formula" >"$install_log" 2>&1
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    printf 'Homebrew gated install for %s formula passed\n' "$label"
    return 0
  fi
  if brew list --formula --versions "$label" >/dev/null 2>&1; then
    sed 's/^/  /' "$install_log" >&2
    dependency_problem "Homebrew gated install for $label formula returned exit $status after the formula was installed; treating the nonzero exit as dependency/environment residue and continuing to the installed-command proof."
    return 0
  fi
  sed 's/^/  /' "$install_log" >&2
  fail "aimux formula gate failed: Homebrew did not install $label formula (exit $status)"
}

prove_installed_aimux_command() {
  local formula="$1"
  local label="$2"
  local command_path
  local formula_cellar
  local formula_prefix
  local expected_target
  local help_log
  local wrapper_target

  command_path="$(brew --prefix)/bin/aimux"
  formula_prefix="$(brew --prefix "$formula")"
  formula_cellar="$(brew --cellar "$formula")"
  expected_target="$formula_prefix/libexec/bin/aimux"
  help_log="$LOG_DIR/help-$formula.log"

  set +e
  "$command_path" --help >"$help_log" 2>&1
  local status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    sed 's/^/  /' "$help_log" >&2
    fail "aimux formula gate failed: installed $label command failed --help with exit $status"
  fi
  if ! grep -F "aimux" "$help_log" >/dev/null 2>&1; then
    sed 's/^/  /' "$help_log" >&2
    fail "aimux formula gate failed: installed $label command --help did not identify aimux"
  fi
  wrapper_target="$(sed -n 's/^[[:space:]]*exec "\([^"]*\)".*/\1/p' "$command_path" | sed -n '1p')"
  case "$wrapper_target" in
    /*) ;;
    "")
      sed 's/^/  /' "$command_path" >&2
      fail "aimux formula gate failed: Homebrew $label wrapper does not contain an exec target"
      ;;
    *)
      sed 's/^/  /' "$command_path" >&2
      fail "aimux formula gate failed: Homebrew $label wrapper target is not absolute: $wrapper_target"
      ;;
  esac
  if [ ! -x "$wrapper_target" ]; then
    sed 's/^/  /' "$command_path" >&2
    fail "aimux formula gate failed: Homebrew $label wrapper target is not executable: $wrapper_target"
  fi
  case "$wrapper_target" in
    "$expected_target" | "$formula_cellar"/*/libexec/bin/aimux) ;;
    *)
      sed 's/^/  /' "$command_path" >&2
      fail "aimux formula gate failed: Homebrew $label wrapper target is not the formula libexec aimux: $wrapper_target"
      ;;
  esac
  if ! grep -F "exec \"$wrapper_target\"" "$command_path" >/dev/null 2>&1; then
    sed 's/^/  /' "$command_path" >&2
    fail "aimux formula gate failed: Homebrew $label wrapper does not exec its parsed target: $wrapper_target"
  fi
  printf 'Homebrew %s installed command proof passed: %s --help\n' "$label" "$command_path"
  printf 'Homebrew %s wrapper target proof passed: %s\n' "$label" "$wrapper_target"
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR=""
TAG="v0.0.0-homebrew-dry-run"
VERSION="0.0.0"
STAGING_DIR=""
LIVE_INSTALL=0
DEPENDENCY_PREP_ONLY=0
SKIP_DEPENDENCY_PREP=0
IGNORE_DEPENDENCIES=0
BAD_SHA_PROOF=1
HOST_ONLY=0
STAGING_TAP="aimux/dry-run-$$"
SKIP_ASSET_VERIFICATION=0
SKIP_DOCTOR_PROOF=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release-dir)
      RELEASE_DIR="${2:-}"
      shift 2
      ;;
    --tag)
      TAG="${2:-}"
      shift 2
      ;;
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --staging-dir)
      STAGING_DIR="${2:-}"
      shift 2
      ;;
    --staging-tap)
      STAGING_TAP="${2:-}"
      shift 2
      ;;
    --host-only)
      HOST_ONLY=1
      shift
      ;;
    --live-install)
      LIVE_INSTALL=1
      shift
      ;;
    --dependency-prep-only)
      DEPENDENCY_PREP_ONLY=1
      LIVE_INSTALL=1
      shift
      ;;
    --skip-dependency-prep)
      SKIP_DEPENDENCY_PREP=1
      shift
      ;;
    --ignore-dependencies)
      IGNORE_DEPENDENCIES=1
      shift
      ;;
    --skip-asset-verification)
      SKIP_ASSET_VERIFICATION=1
      shift
      ;;
    --skip-doctor-proof)
      SKIP_DOCTOR_PROOF=1
      shift
      ;;
    --skip-bad-sha-proof)
      BAD_SHA_PROOF=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown argument: $1"
      ;;
  esac
done

[ -n "$RELEASE_DIR" ] || {
  usage >&2
  fail "--release-dir is required"
}
RELEASE_DIR="$(cd "$RELEASE_DIR" && pwd)"
[ -d "$RELEASE_DIR" ] || fail "release directory not found: $RELEASE_DIR"

for command in awk bash brew cp grep mkdir mktemp rm sed shasum tar uname; do
  need "$command"
done
if command -v ruby >/dev/null 2>&1; then
  RUBY_CMD=(ruby)
else
  RUBY_CMD=(brew ruby --)
fi
export HOMEBREW_NO_AUTO_UPDATE="${HOMEBREW_NO_AUTO_UPDATE:-1}"
export HOMEBREW_NO_INSTALL_CLEANUP="${HOMEBREW_NO_INSTALL_CLEANUP:-1}"

PLATFORM="$(detect_platform)"
ARCH="$(detect_arch)"
PLATFORM_ARCH="$PLATFORM-$ARCH"
HOST_FULL_ASSET="aimux-${PLATFORM_ARCH}.tar.gz"
HOST_LOCAL_ASSET="aimux-local-${PLATFORM_ARCH}.tar.gz"

if [ "$HOST_ONLY" -eq 1 ]; then
  ensure_asset_pair "$HOST_FULL_ASSET"
  ensure_asset_pair "$HOST_LOCAL_ASSET"
  if [ "$SKIP_ASSET_VERIFICATION" -eq 0 ]; then
    bash "$ROOT_DIR/scripts/verify-release-asset.sh" "$RELEASE_DIR/$HOST_FULL_ASSET" "$PLATFORM_ARCH"
    bash "$ROOT_DIR/scripts/verify-release-provenance.sh" "$RELEASE_DIR" "$HOST_FULL_ASSET" "$PLATFORM_ARCH" full
    bash "$ROOT_DIR/scripts/check-local-build-boundary.sh" \
      --variant full \
      --archive "$RELEASE_DIR/$HOST_FULL_ASSET" \
      --platform-arch "$PLATFORM_ARCH"
    bash "$ROOT_DIR/scripts/verify-release-asset.sh" "$RELEASE_DIR/$HOST_LOCAL_ASSET" "$PLATFORM_ARCH"
    bash "$ROOT_DIR/scripts/verify-release-provenance.sh" "$RELEASE_DIR" "$HOST_LOCAL_ASSET" "$PLATFORM_ARCH" local
    bash "$ROOT_DIR/scripts/check-local-build-boundary.sh" \
      --variant local \
      --archive "$RELEASE_DIR/$HOST_LOCAL_ASSET" \
      --platform-arch "$PLATFORM_ARCH"
  else
    printf 'Skipping release asset verification by explicit request\n'
  fi
else
  for platform in darwin linux; do
    for arch in arm64 x64; do
      ensure_asset_pair "aimux-${platform}-${arch}.tar.gz"
      ensure_asset_pair "aimux-local-${platform}-${arch}.tar.gz"
    done
  done
  if [ "$SKIP_ASSET_VERIFICATION" -eq 0 ]; then
    bash "$ROOT_DIR/scripts/verify-release-asset-set.sh" "$RELEASE_DIR"
  else
    printf 'Skipping release asset-set verification by explicit request\n'
  fi
fi

if [ -z "$STAGING_DIR" ]; then
  STAGING_DIR="$(mktemp -d)"
  CLEAN_STAGING=1
else
  mkdir -p "$STAGING_DIR"
  STAGING_DIR="$(cd "$STAGING_DIR" && pwd)"
  CLEAN_STAGING=0
fi

cleanup() {
  if [ "$LIVE_INSTALL" -eq 1 ] && [ "${INSTALLED_LOCAL:-0}" -eq 1 ]; then
    brew uninstall --formula aimux-local >/dev/null 2>&1 || true
  fi
  if [ "$LIVE_INSTALL" -eq 1 ] && [ "${INSTALLED_FULL:-0}" -eq 1 ]; then
    brew uninstall --formula aimux >/dev/null 2>&1 || true
  fi
  if [ "${CLEAN_STAGING:-0}" -eq 1 ]; then
    rm -rf "$STAGING_DIR"
  fi
  if [ "${CREATED_STAGING_TAP:-0}" -eq 1 ]; then
    brew untap "$STAGING_TAP" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

LOG_DIR="$STAGING_DIR/logs"
CACHE_DIR="$STAGING_DIR/brew-cache"
mkdir -p "$LOG_DIR" "$CACHE_DIR"

if brew tap | grep -Fx "$STAGING_TAP" >/dev/null 2>&1; then
  fail "temporary Homebrew tap already exists: $STAGING_TAP"
fi
run_and_capture "Homebrew staging tap creation" "$LOG_DIR/tap-new.log" \
  brew tap-new "$STAGING_TAP" --no-git
CREATED_STAGING_TAP=1
if brew help trust >/dev/null 2>&1; then
  run_and_capture "Homebrew staging tap trust" "$LOG_DIR/tap-trust.log" \
    brew trust "$STAGING_TAP"
fi
TAP_REPO="$(brew --repo "$STAGING_TAP")"
FORMULA_DIR="$TAP_REPO/Formula"

export AIMUX_HOMEBREW_FORMULA_DIR="$FORMULA_DIR"
export AIMUX_HOMEBREW_BASE_URL="file://$RELEASE_DIR"
export TAG VERSION
export DARWIN_ARM64="$(sha_for_or_placeholder aimux-darwin-arm64.tar.gz "$HOST_FULL_ASSET")"
export DARWIN_X64="$(sha_for_or_placeholder aimux-darwin-x64.tar.gz "$HOST_FULL_ASSET")"
export LINUX_ARM64="$(sha_for_or_placeholder aimux-linux-arm64.tar.gz "$HOST_FULL_ASSET")"
export LINUX_X64="$(sha_for_or_placeholder aimux-linux-x64.tar.gz "$HOST_FULL_ASSET")"
export LOCAL_DARWIN_ARM64="$(sha_for_or_placeholder aimux-local-darwin-arm64.tar.gz "$HOST_LOCAL_ASSET")"
export LOCAL_DARWIN_X64="$(sha_for_or_placeholder aimux-local-darwin-x64.tar.gz "$HOST_LOCAL_ASSET")"
export LOCAL_LINUX_ARM64="$(sha_for_or_placeholder aimux-local-linux-arm64.tar.gz "$HOST_LOCAL_ASSET")"
export LOCAL_LINUX_X64="$(sha_for_or_placeholder aimux-local-linux-x64.tar.gz "$HOST_LOCAL_ASSET")"

bash "$ROOT_DIR/scripts/render-homebrew-formulas.sh"

cp "$FORMULA_DIR/aimux.rb" "$STAGING_DIR/aimux.rb"
cp "$FORMULA_DIR/aimux-local.rb" "$STAGING_DIR/aimux-local.rb"

run_and_capture "Ruby parse for aimux formula" "$LOG_DIR/ruby-aimux.log" \
  "${RUBY_CMD[@]}" -c "$FORMULA_DIR/aimux.rb"
run_and_capture "Ruby parse for aimux-local formula" "$LOG_DIR/ruby-aimux-local.log" \
  "${RUBY_CMD[@]}" -c "$FORMULA_DIR/aimux-local.rb"

export HOMEBREW_CACHE="$CACHE_DIR"
run_and_capture "Homebrew fetch for aimux $PLATFORM_ARCH" "$LOG_DIR/fetch-aimux.log" \
  brew fetch --formula "$STAGING_TAP/aimux" --force
run_and_capture "Homebrew fetch for aimux-local $PLATFORM_ARCH" "$LOG_DIR/fetch-aimux-local.log" \
  brew fetch --formula "$STAGING_TAP/aimux-local" --force

if [ "$BAD_SHA_PROOF" -eq 1 ]; then
  BAD_FORMULA="$FORMULA_DIR/aimux-local.rb"
  awk '
    replaced == 0 && $1 == "sha256" {
      sub(/sha256 "[^"]+"/, "sha256 \"0000000000000000000000000000000000000000000000000000000000000000\"")
      replaced = 1
    }
    { print }
  ' "$STAGING_DIR/aimux-local.rb" > "$BAD_FORMULA"
  export HOMEBREW_CACHE="$CACHE_DIR/bad-sha"
  if brew fetch --formula "$STAGING_TAP/aimux-local" --force >"$LOG_DIR/fetch-bad-sha.log" 2>&1; then
    sed 's/^/  /' "$LOG_DIR/fetch-bad-sha.log" >&2
    fail "Homebrew accepted aimux-local formula with mismatched sha256"
  fi
  if ! grep -E "SHA256|sha256|checksum|does not match|mismatch" "$LOG_DIR/fetch-bad-sha.log" >/dev/null 2>&1; then
    sed 's/^/  /' "$LOG_DIR/fetch-bad-sha.log" >&2
    fail "bad-sha proof failed, but output did not name a checksum/SHA comparison"
  fi
  printf 'Homebrew bad-sha proof passed\n'
  cp "$STAGING_DIR/aimux-local.rb" "$FORMULA_DIR/aimux-local.rb"
  export HOMEBREW_CACHE="$CACHE_DIR"
fi

if [ "$LIVE_INSTALL" -eq 1 ]; then
  if brew list --formula --versions aimux >/dev/null 2>&1; then
    fail "--live-install refused: aimux is already installed by Homebrew"
  fi
  if brew list --formula --versions aimux-local >/dev/null 2>&1; then
    fail "--live-install refused: aimux-local is already installed by Homebrew"
  fi
  if [ "$SKIP_DEPENDENCY_PREP" -eq 0 ]; then
    prepare_formula_dependencies "$STAGING_TAP/aimux" aimux
    prepare_formula_dependencies "$STAGING_TAP/aimux-local" aimux-local
  else
    printf 'Homebrew dependency preparation skipped by explicit request\n'
  fi

  if [ "$DEPENDENCY_PREP_ONLY" -eq 1 ]; then
    cat <<EOF
Aimux Homebrew dependency preparation finished:
  formulas: $FORMULA_DIR
  staging tap: $STAGING_TAP
  logs: $LOG_DIR
  current platform: $PLATFORM_ARCH
EOF
    exit 0
  fi

  export HOMEBREW_CACHE="$CACHE_DIR/live"
  install_formula_for_gate "$STAGING_TAP/aimux" aimux
  INSTALLED_FULL=1
  if [ ! -x "$(brew --prefix)/bin/aimux" ]; then
    fail "Homebrew full install did not create executable command: $(brew --prefix)/bin/aimux"
  fi
  printf 'Homebrew full formula installed command: %s\n' "$(brew --prefix)/bin/aimux"
  prove_installed_aimux_command aimux full

  if brew_install_formula "$STAGING_TAP/aimux-local" >"$LOG_DIR/conflict-local-while-full.log" 2>&1; then
    fail "Homebrew allowed aimux-local to install while aimux was installed"
  fi
  if ! grep -E "conflict|Formulae found in multiple taps" "$LOG_DIR/conflict-local-while-full.log" >/dev/null 2>&1; then
    sed 's/^/  /' "$LOG_DIR/conflict-local-while-full.log" >&2
    fail "aimux-local conflict refusal did not name the conflict"
  fi
  if brew list --formula --versions aimux-local >/dev/null 2>&1; then
    brew uninstall --formula aimux-local
  fi
  printf 'Homebrew conflict proof passed: aimux blocks aimux-local\n'

  brew uninstall --formula aimux
  INSTALLED_FULL=0

  export HOMEBREW_CACHE="$CACHE_DIR/live"
  install_formula_for_gate "$STAGING_TAP/aimux-local" aimux-local
  INSTALLED_LOCAL=1
  if [ ! -x "$(brew --prefix)/bin/aimux" ]; then
    fail "Homebrew local install did not create executable command: $(brew --prefix)/bin/aimux"
  fi
  printf 'Homebrew local formula installed command: %s\n' "$(brew --prefix)/bin/aimux"
  prove_installed_aimux_command aimux-local local

  if [ "$SKIP_DOCTOR_PROOF" -eq 0 ]; then
    DOCTOR_LOG="$LOG_DIR/doctor-versions-local.log"
    AIMUX_HOME="$STAGING_DIR/aimux-home" \
      AIMUX_DAEMON_PORT=0 \
      AIMUX_SKIP_DAEMON_START=1 \
      "$(brew --prefix)/bin/aimux" doctor versions >"$DOCTOR_LOG" 2>&1 || {
        status=$?
        sed 's/^/  /' "$DOCTOR_LOG" >&2
        fail "aimux doctor versions failed after Homebrew local install with exit $status"
      }
    if ! grep -E "buildVariant[[:space:]:=]+local|build variant[[:space:]:=]+local|BUILD_VARIANT[[:space:]:=]+local" "$DOCTOR_LOG" >/dev/null 2>&1; then
      sed 's/^/  /' "$DOCTOR_LOG" >&2
      fail "aimux doctor versions did not report local build variant after Homebrew local install"
    fi
    printf 'Homebrew local doctor variant proof passed\n'
  else
    printf 'Homebrew local doctor variant proof skipped by explicit request\n'
  fi

  if brew_install_formula "$STAGING_TAP/aimux" >"$LOG_DIR/conflict-full-while-local.log" 2>&1; then
    fail "Homebrew allowed aimux to install while aimux-local was installed"
  fi
  if ! grep -E "conflict|Formulae found in multiple taps" "$LOG_DIR/conflict-full-while-local.log" >/dev/null 2>&1; then
    sed 's/^/  /' "$LOG_DIR/conflict-full-while-local.log" >&2
    fail "aimux conflict refusal did not name the conflict"
  fi
  if brew list --formula --versions aimux >/dev/null 2>&1; then
    brew uninstall --formula aimux
  fi
  printf 'Homebrew conflict proof passed: aimux-local blocks aimux\n'

  brew uninstall --formula aimux-local
  INSTALLED_LOCAL=0
fi

cat <<EOF
Aimux Homebrew release dry-run passed:
  formulas: $FORMULA_DIR
  staging tap: $STAGING_TAP
  logs: $LOG_DIR
  current platform: $PLATFORM_ARCH
  host-only: $HOST_ONLY
  live install: $LIVE_INSTALL
  dependency prep only: $DEPENDENCY_PREP_ONLY
  dependency prep skipped: $SKIP_DEPENDENCY_PREP
  ignore dependencies: $IGNORE_DEPENDENCIES
  asset verification skipped: $SKIP_ASSET_VERIFICATION
  doctor proof skipped: $SKIP_DOCTOR_PROOF
EOF
