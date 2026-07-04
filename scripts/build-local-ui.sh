#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/app"
APP_DIST="$APP_DIR/dist"
OUT_DIR="$ROOT_DIR/dist-ui"

cd "$APP_DIR"
rm -rf "$APP_DIST"
EXPO_PUBLIC_AIMUX_CONNECTION_MODE=local \
  EXPO_PUBLIC_AIMUX_DAEMON_URL=http://localhost:43190 \
  yarn export:web

INDEX_HTML="$APP_DIST/index.html"
LOCAL_CONFIG_SCRIPT='<script src="/aimux-local-config.js"></script>'
if ! grep -Fq "/aimux-local-config.js" "$INDEX_HTML"; then
  tmp_html="$(mktemp)"
  awk -v script="$LOCAL_CONFIG_SCRIPT" '
    /<\/head>/ && !inserted {
      print "  " script
      inserted = 1
    }
    { print }
  ' "$INDEX_HTML" > "$tmp_html"
  mv "$tmp_html" "$INDEX_HTML"
fi

cd "$ROOT_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp -R "$APP_DIST"/. "$OUT_DIR"/

printf 'Built local UI in %s\n' "$OUT_DIR"
