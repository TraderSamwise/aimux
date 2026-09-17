#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=()

fail_later() {
  FAILURES+=("$1")
}

require_file() {
  local path="$1"
  local description="$2"
  if [ ! -f "$ROOT_DIR/$path" ]; then
    fail_later "missing $description: $path"
  fi
}

require_contains() {
  local path="$1"
  local needle="$2"
  local description="$3"
  if ! grep -F "$needle" "$ROOT_DIR/$path" >/dev/null 2>&1; then
    fail_later "$path is missing $description: $needle"
  fi
}

require_job_needs() {
  local job="$1"
  local dependency="$2"
  local workflow="$ROOT_DIR/.github/workflows/release.yml"
  if ! awk -v job="$job" -v dep="$dependency" '
    $0 == "  " job ":" { in_job = 1; next }
    in_job && $0 ~ /^  [A-Za-z0-9_-]+:/ { in_job = 0 }
    in_job && index($0, "needs: " dep) { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$workflow"; then
    fail_later ".github/workflows/release.yml job $job is missing needs: $dependency"
  fi
}

check_local_boundary() {
  local path="scripts/check-local-build-boundary.sh"
  for dependency in tokio-tungstenite tungstenite ureq reqwest hyper h2 native-tls openssl curl; do
    require_contains "$path" "$dependency" "local remote/network dependency denylist entry $dependency"
  done
  for identity in \
    AIMUX_RELAY_URL \
    'relay[.]aimux[.]app' \
    'wss://' \
    'ws://' \
    hosted_server \
    hosted_cli \
    remote_login \
    remote_security_devices \
    maybe_host_published_attachment \
    'attachments/hosted'
  do
    require_contains "$path" "$identity" "local remote identity denylist entry $identity"
  done
  require_contains "$path" "Full cargo tree is missing remote-control dependencies" "full-variant presence gate"
}

check_release_provenance_gate() {
  require_file "scripts/write-release-provenance.sh" "release provenance generator"
  require_file "scripts/verify-release-provenance.sh" "release provenance verifier"
  require_file "scripts/generate-cargo-sbom.py" "Cargo SPDX SBOM generator"
  require_file "scripts/build-release-from-source.sh" "source release build verifier"
  require_file "scripts/build-local-release-from-source.sh" "local source release wrapper"
  require_contains "scripts/build-release-asset.sh" "write-release-provenance.sh" "per-asset provenance/SBOM generation"
  require_contains "scripts/verify-release-provenance.sh" "generate-cargo-sbom.py" "regenerated SBOM dependency-set verification"
  require_contains "scripts/generate-cargo-sbom.py" "SBOM dependency set mismatch" "loud SBOM dependency mismatch error"
  require_contains "scripts/generate-cargo-sbom.py" "no-default-features" "local SBOM feature-set separation"
  require_contains "scripts/verify-release-asset-set.sh" "missing release SBOM file" "distinct missing SBOM error"
  require_contains "scripts/verify-release-asset-set.sh" "missing release provenance file" "distinct missing provenance error"
  require_contains "scripts/build-release-from-source.sh" "AIMUX_BUILD_VARIANT" "source build variant selection"
  require_contains "scripts/build-release-from-source.sh" "verify-release-provenance.sh" "source build provenance verification"
  require_contains "scripts/build-release-from-source.sh" "check-local-build-boundary.sh" "source build boundary verification"
  require_contains "scripts/build-release-from-source.sh" "AIMUX_SKIP_POST_INSTALL_RESTART=1" "isolated source-build install smoke"

  local workflow=".github/workflows/release.yml"
  require_contains "$workflow" "Verify release provenance and SBOM" "per-asset provenance/SBOM matrix verification step"
  require_contains "$workflow" "scripts/verify-release-provenance.sh" "per-asset provenance/SBOM verifier"
  require_contains "$workflow" "actions/attest-build-provenance@v2" "GitHub artifact attestation step"
  require_contains "$workflow" "gh attestation verify" "artifact attestation verification step"
  require_contains "$workflow" 'release/${{ matrix.asset }}.tar.gz.provenance.json' "provenance asset upload"
  require_contains "$workflow" 'release/${{ matrix.asset }}.tar.gz.sbom.spdx.json' "SBOM asset upload"
  require_job_needs "verify-release-assets" "release-assets"
  require_job_needs "publish-npm" "verify-release-assets"
  require_job_needs "update-homebrew-tap" "verify-release-assets"
}

check_source_local_only_gates() {
  require_contains "scripts/check-local-build-boundary.mjs" "attachments/" "project .aimux attachments ignore check"
  require_contains "scripts/check-local-build-boundary.mjs" "graveyard/" "project .aimux graveyard ignore check"
  require_contains "native/crates/aimux/src/config.rs" "attachments/" "project .aimux attachments ignore template"
  require_contains "native/crates/aimux/src/config.rs" "graveyard/" "project .aimux graveyard ignore template"
  require_contains "native/crates/aimux/tests/daemon_state.rs" "reject non-loopback" "daemon host loopback inverse test"
  require_contains "native/crates/aimux/src/project_service/process.rs" 'StdTcpListener::bind(("127.0.0.1"' "project service loopback bind"
}

check_local_boundary
check_release_provenance_gate
check_source_local_only_gates

if [ "${#FAILURES[@]}" -gt 0 ]; then
  printf 'Local-only release gate failed:\n' >&2
  for failure in "${FAILURES[@]}"; do
    printf -- '- %s\n' "$failure" >&2
  done
  exit 1
fi

printf 'Local-only release gate passed\n'
