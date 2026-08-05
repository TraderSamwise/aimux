#!/usr/bin/env bash
#
# Reverse install.sh. Run as root, on the box.
#
# The order here is the point. Undoing this by hand once produced a box that
# briefly could not resolve anything, because the resolv.conf symlink went back
# before systemd-resolved was running to answer through it. DNS is restored
# last, and the static file keeps working right up until it is.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="${SANDBOX_CONF:-$HERE/sandbox.conf}"

STATE_DIR=/etc/aimux/sandbox
LIB_DIR=/usr/local/lib/aimux-sandbox
NFT_DIR=/etc/nftables.d
BACKUP_DIR="$STATE_DIR/backup"
MARKER_BEGIN="# BEGIN aimux sandbox"
MARKER_END="# END aimux sandbox"

say() { printf '\n== %s\n' "$*"; }

[ "$(id -u)" = "0" ] || { echo "run as root" >&2; exit 1; }
[ -r "$CONF" ] || { echo "no config at $CONF" >&2; exit 1; }
# shellcheck source=/dev/null
. "$CONF"
SANDBOX_AIMUX_UNIT="${SANDBOX_AIMUX_UNIT:-aimux.service}"

if [ "${1:-}" != "--yes" ]; then
  echo "This removes the egress policy and restores host DNS. Re-run with --yes." >&2
  exit 1
fi

say "units"
systemctl disable --now aimux-egress-resolve.timer >/dev/null 2>&1 || true
systemctl disable --now aimux-egress.service >/dev/null 2>&1 || true

# Explicit, because the unit deliberately does not flush on stop — stopping it
# should never be a quiet way to unfilter a running agent.
nft delete table inet aimux_egress >/dev/null 2>&1 || true

rm -f "/etc/systemd/system/${SANDBOX_AIMUX_UNIT}.d/10-sandbox.conf"
rmdir "/etc/systemd/system/${SANDBOX_AIMUX_UNIT}.d" 2>/dev/null || true
rm -f /etc/systemd/system/aimux-egress.service \
  /etc/systemd/system/aimux-egress-resolve.service \
  /etc/systemd/system/aimux-egress-resolve.timer
systemctl daemon-reload

say "proxy"
if [ -e "$BACKUP_DIR/tinyproxy.conf" ]; then
  cp -a "$BACKUP_DIR/tinyproxy.conf" /etc/tinyproxy/tinyproxy.conf
  systemctl restart tinyproxy >/dev/null 2>&1 || true
else
  # No backup means this profile installed the only config there ever was.
  systemctl disable --now tinyproxy >/dev/null 2>&1 || true
fi

say "dns"
systemctl unmask systemd-resolved >/dev/null 2>&1 || true
systemctl enable --now systemd-resolved >/dev/null 2>&1 || true

if [ -e "$BACKUP_DIR/nsswitch.conf" ]; then
  cp -a "$BACKUP_DIR/nsswitch.conf" /etc/nsswitch.conf
fi

# Last, and only now that resolved is up to answer through it.
if [ -r "$BACKUP_DIR/resolv.conf.state" ]; then
  read -r kind target < "$BACKUP_DIR/resolv.conf.state" || true
  if [ "$kind" = "symlink" ] && [ -n "${target:-}" ]; then
    rm -f /etc/resolv.conf
    ln -s "$target" /etc/resolv.conf
  elif [ -e "$BACKUP_DIR/resolv.conf" ]; then
    cp -a "$BACKUP_DIR/resolv.conf" /etc/resolv.conf
  fi
fi

say "leftovers"
sed -i "/^${MARKER_BEGIN}$/,/^${MARKER_END}$/d" /etc/hosts
rm -f "$NFT_DIR/aimux-egress.nft" "$NFT_DIR/aimux-egress-vars.nft"
rm -rf "$LIB_DIR"

cat <<DONE

Removed. $STATE_DIR is left in place — it holds your allowlist, your pinned
hosts, and the backups this script just restored from.

  systemctl restart $SANDBOX_AIMUX_UNIT

That drops the proxy variables from agent panes. Until it runs they still point
at 127.0.0.1:8888, where nothing is listening.

DONE
