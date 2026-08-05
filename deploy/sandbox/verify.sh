#!/usr/bin/env bash
#
# Prove the egress policy from the sandboxed uid, rather than from the ruleset.
#
# This exists because reading the rules is not evidence. On the box this profile
# came from, the ruleset said DNS was blocked and it was not: glibc's `resolve`
# NSS module and `resolvectl` both reach systemd-resolved over a local socket,
# and resolved makes the lookup as its own uid — so a filter that looks airtight
# on paper still let a name out. Only running it as the agent found that.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="${SANDBOX_CONF:-$HERE/sandbox.conf}"
ALLOWLIST=/etc/aimux/sandbox/allowlist.txt
PINNED=/etc/aimux/sandbox/pinned-hosts
PROXY=http://127.0.0.1:8888

[ "$(id -u)" = "0" ] || { echo "run as root" >&2; exit 1; }
[ -r "$CONF" ] || { echo "no config at $CONF" >&2; exit 1; }
# shellcheck source=/dev/null
. "$CONF"
: "${SANDBOX_USER:?set SANDBOX_USER in $CONF}"

uid="$(id -u "$SANDBOX_USER")"
gid="$(id -g "$SANDBOX_USER")"
as_agent() { setpriv --reuid="$uid" --regid="$gid" --clear-groups -- "$@"; }

pass=0
fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }

# The probe host is taken from the operator's own allowlist rather than
# hardcoded, so this tests the policy that is actually installed.
allowed_host="$(grep -E '^\^[A-Za-z0-9\\.-]+\$$' "$ALLOWLIST" 2>/dev/null |
  head -1 | sed -e 's/^\^//' -e 's/\$$//' -e 's/\\//g')"
[ -n "$allowed_host" ] || { echo "no anchored hostname found in $ALLOWLIST" >&2; exit 1; }

denied_host=example.com
if grep -qxF -e '^example\.com$' -e '^example.com$' "$ALLOWLIST" 2>/dev/null; then
  echo "$denied_host is allowlisted; the deny probe needs a name that is not" >&2
  exit 1
fi

# `%{http_connect}` and not `%{http_code}`: for a tunnelled request the latter
# reads 000 whether the proxy refused with 403 or was not listening at all, so a
# dead proxy would score as a working denial. The trailing newline matters too —
# a `read` on output without one returns non-zero and takes `set -e` with it.
connect_code() {
  as_agent curl -s -o /dev/null --max-time 15 -w '%{http_connect}\n' \
    --proxy "$PROXY" "https://$1/" 2>/dev/null || echo "000"
}

echo "aimux egress sandbox — probing as $SANDBOX_USER (uid $uid)"

echo
echo "proxy"
code="$(connect_code "$allowed_host")"
[ "$code" = "200" ] && ok "allowlisted $allowed_host connects" ||
  bad "allowlisted $allowed_host returned CONNECT $code (expected 200)"

code="$(connect_code "$denied_host")"
[ "$code" = "403" ] && ok "unlisted $denied_host is refused by the proxy" ||
  bad "unlisted $denied_host returned CONNECT $code (expected 403)"

echo
echo "bypass"
# Straight at the internet with no proxy. The nft table is the only thing
# stopping this, so a success here means the proxy is decoration.
if as_agent curl -s -o /dev/null --max-time 8 "https://$allowed_host/" 2>/dev/null; then
  bad "reached $allowed_host directly, bypassing the proxy"
else
  ok "direct connection to $allowed_host is dropped"
fi

echo
echo "dns"
if as_agent dig +short +timeout=3 +tries=1 "$denied_host" 2>/dev/null | grep -qE '[0-9]'; then
  bad "dig resolved $denied_host — UDP 53 is reaching a resolver"
else
  ok "dig cannot resolve"
fi

# The NSS path. Blocked by `hosts: files dns` in nsswitch plus the packet
# filter; with the `resolve` module present this succeeds while dig fails.
if as_agent getent hosts "$denied_host" >/dev/null 2>&1; then
  bad "getent resolved $denied_host — check 'hosts:' in /etc/nsswitch.conf"
else
  ok "getent cannot resolve"
fi

# The D-Bus path. Only masking resolved closes this one.
if command -v resolvectl >/dev/null 2>&1; then
  if as_agent resolvectl query "$denied_host" >/dev/null 2>&1; then
    bad "resolvectl resolved $denied_host — systemd-resolved is not masked"
  else
    ok "resolvectl cannot resolve"
  fi
fi

if [ -s "$PINNED" ] && grep -qvE '^\s*(#|$)' "$PINNED" 2>/dev/null; then
  echo
  echo "pinned endpoints"
  while read -r host port _rest || [ -n "$host" ]; do
    [ -n "$host" ] || continue
    case "$host" in \#*) continue ;; esac
    if as_agent timeout 8 bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null; then
      ok "$host:$port reachable"
    else
      bad "$host:$port unreachable"
    fi
    # The set is address-and-port, so a pinned host must not be wide open.
    #
    # Judged on TIME, not on failure. A closed port fails either way — nft
    # dropped the packet, or it left the box and the far end refused it — and
    # only the first is the policy working. A silent drop blocks until the
    # timeout; a refusal comes back in milliseconds. So a fast failure here
    # means traffic reached the internet.
    other=$(( port == 22 ? 23 : 22 ))
    started=$SECONDS
    as_agent timeout 6 bash -c "exec 3<>/dev/tcp/$host/$other" 2>/dev/null && reached=y || reached=n
    elapsed=$(( SECONDS - started ))
    if [ "$reached" = "y" ]; then
      bad "$host:$other reachable — the pin is opening the host, not the port"
    elif [ "$elapsed" -lt 3 ]; then
      bad "$host:$other refused in ${elapsed}s — that packet left the box"
    else
      ok "$host:$other is dropped"
    fi
  done < "$PINNED"
fi

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
