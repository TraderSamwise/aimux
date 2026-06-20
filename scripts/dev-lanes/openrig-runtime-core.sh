#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

export AIMUX_HOME="${AIMUX_HOME:-$HOME/.aimux-openrig-runtime-core}"
export AIMUX_DAEMON_PORT="${AIMUX_DAEMON_PORT:-43192}"
export AIMUX_ENV="${AIMUX_ENV:-development}"
export AIMUX_WEB_APP_URL="${AIMUX_WEB_APP_URL:-http://localhost:8082}"

exec node "${REPO_ROOT}/bin/aimux" "$@"
