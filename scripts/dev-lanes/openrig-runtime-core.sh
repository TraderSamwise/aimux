#!/usr/bin/env bash
set -euo pipefail

export AIMUX_HOME="${AIMUX_HOME:-$HOME/.aimux-dev-openrig-runtime-core}"
export AIMUX_DAEMON_PORT="${AIMUX_DAEMON_PORT:-43192}"
export AIMUX_ENV="${AIMUX_ENV:-development}"
export AIMUX_WEB_APP_URL="${AIMUX_WEB_APP_URL:-http://localhost:8082}"

exec node bin/aimux-dev "$@"
