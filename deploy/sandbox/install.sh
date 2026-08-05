#!/usr/bin/env bash
#
# Install the aimux egress sandbox on this host. Run as root, on the box.
#
# This is invasive by nature: it takes over the host's DNS configuration, masks
# systemd-resolved, replaces the tinyproxy config, and default-denies outbound
# for one uid. Read docs/egress-sandbox.md before running it, and `uninstall.sh`
# reverses every step in the right order if you decide against it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="${SANDBOX_CONF:-$HERE/sandbox.conf}"

STATE_DIR=/etc/aimux/sandbox
LIB_DIR=/usr/local/lib/aimux-sandbox
NFT_DIR=/etc/nftables.d
BACKUP_DIR="$STATE_DIR/backup"

say() { printf '\n== %s\n' "$*"; }
die() { printf 'aimux-sandbox: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "this profile is Linux + systemd + nftables only"
[ "$(id -u)" = "0" ] || die "run as root"
[ -r "$CONF" ] || die "no config at $CONF (copy sandbox.conf.example and edit it)"

# shellcheck source=/dev/null
. "$CONF"
: "${SANDBOX_USER:?set SANDBOX_USER in $CONF}"
: "${SANDBOX_AIMUX_UNIT:?set SANDBOX_AIMUX_UNIT in $CONF}"
SANDBOX_UPSTREAM_DNS="${SANDBOX_UPSTREAM_DNS:-}"

SANDBOX_UID="$(id -u "$SANDBOX_USER" 2>/dev/null)" || die "no such user: $SANDBOX_USER"
[ "$SANDBOX_UID" != "0" ] && [ "$SANDBOX_UID" -ge 1000 ] ||
  die "refusing to sandbox uid $SANDBOX_UID — that is a system account, not an agent runtime"

for bin in nft dig flock tinyproxy systemctl; do
  command -v "$bin" >/dev/null 2>&1 ||
    die "missing $bin — install the prerequisites first (see docs/egress-sandbox.md)"
done

# The upstream resolvers are read before anything is changed, because
# /run/systemd/resolve/resolv.conf stops being meaningful once resolved is
# masked. No fallback to a public resolver: silently routing a host's DNS
# somewhere it did not choose is not this script's decision to make.
upstream="$SANDBOX_UPSTREAM_DNS"
if [ -z "$upstream" ] && [ -r /run/systemd/resolve/resolv.conf ]; then
  # Deduplicated. resolved lists a server once per link, so a box with three
  # interfaces on one network yields the same address three times — and glibc
  # honours only the first three `nameserver` lines, so the duplicates would
  # crowd out a genuinely different resolver behind them.
  upstream="$(awk '/^nameserver /&&!seen[$2]++{print $2}' /run/systemd/resolve/resolv.conf | tr '\n' ' ')"
fi
[ -n "${upstream// /}" ] ||
  die "could not determine upstream nameservers — set SANDBOX_UPSTREAM_DNS in $CONF"

# Said out loud rather than silently truncated: glibc reads at most MAXNS=3, so
# anything past the third is configuration that looks applied and is not.
# shellcheck disable=SC2086
[ "$(set -- $upstream; echo $#)" -le 3 ] ||
  echo "warning: more than 3 nameservers — glibc will ignore the rest" >&2

cat <<PLAN

aimux egress sandbox
  runtime user      $SANDBOX_USER (uid $SANDBOX_UID)
  aimux unit        $SANDBOX_AIMUX_UNIT
  upstream DNS      $upstream

This will:
  * default-deny outbound for uid $SANDBOX_UID, allowing only loopback, the
    proxy's own traffic, and the host:port pairs in $STATE_DIR/pinned-hosts
  * route that uid's HTTPS through tinyproxy on 127.0.0.1:8888, which denies
    every hostname not in $STATE_DIR/allowlist.txt
  * write a static /etc/resolv.conf, set /etc/nsswitch.conf hosts to 'files dns'
    and MASK systemd-resolved — host-wide, not just for that uid, and required:
    with resolved running, the DNS block is decorative

PLAN

if [ "${1:-}" != "--yes" ]; then
  die "re-run with --yes to proceed"
fi

install -d -m 0755 "$STATE_DIR" "$LIB_DIR" "$NFT_DIR" "$BACKUP_DIR"

backup_once() {
  local src="$1" name="$2"
  [ -e "$BACKUP_DIR/$name" ] && return 0
  [ -e "$src" ] || return 0
  cp -a "$src" "$BACKUP_DIR/$name"
}

say "policy files"
# Numeric uid rather than a name: nft resolves a username at load time, and this
# table loads before network-pre.target, when name resolution is not something
# to depend on.
printf 'define aimux_uid = %s\n' "$SANDBOX_UID" > "$NFT_DIR/aimux-egress-vars.nft"
chmod 0644 "$NFT_DIR/aimux-egress-vars.nft"
install -m 0644 "$HERE/aimux-egress.nft" "$NFT_DIR/aimux-egress.nft"
install -m 0755 "$HERE/resolve-pinned-hosts.sh" "$LIB_DIR/resolve-pinned-hosts.sh"

# The ruleset is parsed before anything is loaded. A typo here would otherwise
# surface at the next boot as a box with no policy and a failed unit.
nft -c -f "$NFT_DIR/aimux-egress.nft" || die "the ruleset does not parse — nothing was applied"

say "operator-owned config"
# Installed only when absent. These two files ARE the policy, so an upgrade that
# quietly reset them to the shipped defaults would silently widen or narrow what
# the agent can reach.
for pair in "allowlist.txt:allowlist.txt" "pinned-hosts.example:pinned-hosts"; do
  src="${pair%%:*}"; dst="${pair##*:}"
  if [ -e "$STATE_DIR/$dst" ]; then
    echo "  keeping existing $STATE_DIR/$dst"
  else
    install -m 0644 "$HERE/$src" "$STATE_DIR/$dst"
    echo "  installed $STATE_DIR/$dst"
  fi
done

say "proxy"
backup_once /etc/tinyproxy/tinyproxy.conf tinyproxy.conf
install -d -m 0755 /etc/tinyproxy
install -m 0644 "$HERE/tinyproxy.conf" /etc/tinyproxy/tinyproxy.conf

say "dns"
backup_once /etc/nsswitch.conf nsswitch.conf
# The `resolve` NSS module reaches systemd-resolved over a UNIX socket, where
# resolved makes the lookup as ITS uid — a path no packet filter can see. This
# line is what closes it.
sed -i -E 's/^(hosts:).*/\1 files dns/' /etc/nsswitch.conf

# Written BEFORE resolved is stopped, so the box is never without a resolver.
# How resolv.conf looked is recorded, symlink and all, because uninstall has to
# put back what was there rather than a plausible equivalent.
if [ ! -e "$BACKUP_DIR/resolv.conf.state" ]; then
  if [ -L /etc/resolv.conf ]; then
    printf 'symlink %s\n' "$(readlink /etc/resolv.conf)" > "$BACKUP_DIR/resolv.conf.state"
  else
    printf 'regular\n' > "$BACKUP_DIR/resolv.conf.state"
    backup_once /etc/resolv.conf resolv.conf
  fi
fi
rm -f /etc/resolv.conf
{
  echo "# Written by the aimux egress sandbox. systemd-resolved is masked."
  for ns in $upstream; do echo "nameserver $ns"; done
} > /etc/resolv.conf
chmod 0644 /etc/resolv.conf

# Only masking closes the D-Bus path: `resolvectl query` reaches resolved
# directly, and resolved then queries upstream as root. Disabling alone leaves a
# socket-activated unit that comes straight back.
systemctl disable --now systemd-resolved >/dev/null 2>&1 || true
systemctl mask systemd-resolved >/dev/null 2>&1 || true

say "units"
install -m 0644 "$HERE"/systemd/aimux-egress.service \
  "$HERE"/systemd/aimux-egress-resolve.service \
  "$HERE"/systemd/aimux-egress-resolve.timer /etc/systemd/system/
install -d -m 0755 "/etc/systemd/system/${SANDBOX_AIMUX_UNIT}.d"
install -m 0644 "$HERE/systemd/aimux.service.d/10-sandbox.conf" \
  "/etc/systemd/system/${SANDBOX_AIMUX_UNIT}.d/10-sandbox.conf"

systemctl daemon-reload
systemctl enable --now aimux-egress.service
systemctl restart tinyproxy
systemctl enable --now aimux-egress-resolve.timer
# The table loads with empty sets, and the timer's first run is 45s away. Doing
# it now means the pinned endpoints work before anyone tries them.
"$LIB_DIR/resolve-pinned-hosts.sh" || die "pinned hosts did not resolve — the policy is loaded but incomplete"

cat <<DONE

Installed. Two things left, both yours:

  1. systemctl restart $SANDBOX_AIMUX_UNIT
     The drop-in is in place but does not reach a running daemon. Until this,
     agents launch without the proxy variables and every outbound call is
     dropped rather than proxied.

  2. $HERE/verify.sh
     Proves the policy from the sandboxed uid instead of from the ruleset:
     an allowlisted host connects, an unlisted one is refused, bypassing the
     proxy gets nothing, and DNS is dead.

DONE
