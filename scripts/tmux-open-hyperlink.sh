#!/bin/sh
set -eu

resolve_pr_url() {
  [ -n "${AIMUX_PROJECT_STATE_DIR-}" ] || return 1
  [ -n "${AIMUX_CURRENT_WINDOW_ID-}" ] || return 1
  python3 - <<'PY'
import json, os, pathlib

state_dir = os.environ.get("AIMUX_PROJECT_STATE_DIR", "")
window_id = os.environ.get("AIMUX_CURRENT_WINDOW_ID", "")
try:
    data = json.loads((pathlib.Path(state_dir) / "statusline.json").read_text())
    for session in data.get("sessions") or []:
        if session.get("tmuxWindowId") != window_id:
            continue
        metadata = (data.get("metadata") or {}).get(session.get("id")) or {}
        pr = (metadata.get("context") or {}).get("pr") or {}
        url = pr.get("url")
        if url:
            print(url, end="")
            raise SystemExit(0)
except Exception:
    pass
raise SystemExit(1)
PY
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
