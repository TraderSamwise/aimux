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

node <<'NODE'
const fs = require("fs");
const path = require("path");

const indexPath = path.join(process.cwd(), "dist", "index.html");
let html = fs.readFileSync(indexPath, "utf8");
const script = '<script src="/aimux-local-config.js"></script>';
if (!html.includes("/aimux-local-config.js")) {
  html = html.replace("</head>", `  ${script}\n</head>`);
}
fs.writeFileSync(indexPath, html);
NODE

cd "$ROOT_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp -R "$APP_DIST"/. "$OUT_DIR"/

printf 'Built local UI in %s\n' "$OUT_DIR"
