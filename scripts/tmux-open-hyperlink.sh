#!/bin/sh
set -eu

url="${AIMUX_HYPERLINK-}"
[ -n "$url" ] || exit 0

if command -v open >/dev/null 2>&1; then
  exec open "$url"
fi

if command -v xdg-open >/dev/null 2>&1; then
  exec xdg-open "$url"
fi

exit 0
