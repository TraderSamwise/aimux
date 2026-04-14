#!/bin/sh
set -eu

resolve_pr_url() {
  [ -n "${AIMUX_PROJECT_STATE_DIR-}" ] || return 1
  [ -n "${AIMUX_PROJECT_STATE_DIR-}" ] || return 1
  [ -n "${AIMUX_CURRENT_WINDOW_ID-}" ] || return 1
  node - <<'NODE'
const fs = require("fs");
const path = require("path");
const stateDir = process.env.AIMUX_PROJECT_STATE_DIR;
const windowId = process.env.AIMUX_CURRENT_WINDOW_ID;
try {
  const file = path.join(stateDir, "statusline.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const session of data.sessions || []) {
    if (session.tmuxWindowId !== windowId) continue;
    const pr = data.metadata?.[session.id]?.context?.pr;
    if (pr?.url) {
      process.stdout.write(pr.url);
      process.exit(0);
    }
  }
} catch {}
process.exit(1);
NODE
}

extract_from_text() {
  python3 - <<'PY'
import os, re
for key in ("AIMUX_HYPERLINK", "AIMUX_MOUSE_WORD", "AIMUX_MOUSE_LINE"):
    value = os.environ.get(key, "")
    if not value:
        continue
    if key in ("AIMUX_HYPERLINK", "AIMUX_MOUSE_WORD"):
        value = re.sub(r'^[<\(\["\']+', '', value)
        value = re.sub(r'[>\)\],.;:!?"\']+$', '', value)
    match = re.search(r'https?://[^\s<>"\')\]]+', value)
    if match:
        print(match.group(0), end="")
        raise SystemExit(0)
raise SystemExit(1)
PY
}

url="${AIMUX_HYPERLINK-}"

if [ -z "$url" ]; then
  if ! url="$(resolve_pr_url 2>/dev/null)"; then
    url=""
  fi
fi

if [ -z "$url" ]; then
  if ! url="$(extract_from_text 2>/dev/null)"; then
    exit 1
  fi
fi

[ -n "$url" ] || exit 1

if command -v open >/dev/null 2>&1; then
  exec open "$url"
fi

if command -v xdg-open >/dev/null 2>&1; then
  exec xdg-open "$url"
fi

exit 1
