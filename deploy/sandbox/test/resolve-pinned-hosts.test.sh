#!/usr/bin/env bash
#
# Exercise resolve-pinned-hosts.sh against real nftables.
#
# Must run as root on a Linux box with nft and dig, and it needs working DNS —
# so run it BEFORE install.sh, or from a box that is not sandboxed. It is safe
# on a live host: the table it creates has the sets but NO chain, so it hooks
# nothing and filters nothing, and /etc/hosts is backed up and restored around
# the run.
#
#   sudo deploy/sandbox/test/resolve-pinned-hosts.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT:-$HERE/../resolve-pinned-hosts.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "  ok    $1"
  else echo "  FAIL  $1: got '$2' want '$3'"; fails=$((fails + 1)); fi
}

# Element values only. `nft list set` prints a live expiry countdown, so two
# reads of an unchanged set never compare equal. The JSON carries spaces and the
# port as a number, neither of which is obvious until a grep silently matches
# nothing.
elems() {
  nft -j list set inet aimux_egress "$1" | tr -d ' ' | grep -o '"concat":\[[^]]*\]' | sort
}

[ "$(id -u)" = "0" ] || { echo "run as root" >&2; exit 1; }

cp -a /etc/hosts "$TMP/hosts.before"
nft delete table inet aimux_egress >/dev/null 2>&1
nft -f - <<'NFT'
table inet aimux_egress {
    set pinned_v4 {
        type ipv4_addr . inet_service
        flags timeout
        timeout 2h
    }
    set pinned_v6 {
        type ipv6_addr . inet_service
        flags timeout
        timeout 2h
    }
}
NFT

echo "== two ports on one host, plus a second host"
cat > "$TMP/pinned" <<'EOF'
# a comment
one.one.one.one 5432

one.one.one.one 6379
dns.google 443
EOF
HOSTS_FILE="$TMP/pinned" "$SCRIPT" > "$TMP/out" 2>&1
check "exit 0" "$?" "0"
sed 's/^/    /' "$TMP/out"

v4="$(elems pinned_v4)"
echo "$v4" | grep -q '"1.1.1.1",5432' && r=y || r=n; check "1.1.1.1 . 5432 pinned" "$r" "y"
echo "$v4" | grep -q '"1.1.1.1",6379' && r=y || r=n; check "1.1.1.1 . 6379 pinned" "$r" "y"
elems pinned_v6 | grep -qi '2606:4700' && r=y || r=n; check "v6 address pinned" "$r" "y"
grep -q "^# BEGIN aimux sandbox" /etc/hosts && r=y || r=n; check "/etc/hosts block written" "$r" "y"
grep -qE "^127\.0\.0\.1[[:space:]]+localhost" /etc/hosts && r=y || r=n; check "localhost line survived" "$r" "y"

echo "== a host that cannot resolve fails the unit and changes nothing"
# The all-or-nothing guard. Flushing on a partial result would turn a momentary
# DNS blip into an immediate outage, and the entry timeout could never soften it.
before="$(elems pinned_v4)"
printf 'no-such-host.invalid 5432\n' > "$TMP/pinned"
HOSTS_FILE="$TMP/pinned" "$SCRIPT" >/dev/null 2>&1
check "exit 1" "$?" "1"
[ "$before" = "$(elems pinned_v4)" ] && r=y || r=n; check "previous entries stand" "$r" "y"

echo "== a missing port is refused rather than defaulted"
printf 'one.one.one.one\n' > "$TMP/pinned"
HOSTS_FILE="$TMP/pinned" "$SCRIPT" >"$TMP/out3" 2>&1
check "exit 1" "$?" "1"
grep -q "is not a port" "$TMP/out3" && r=y || r=n; check "says why" "$r" "y"

echo "== a final line with no trailing newline is not skipped"
# `read` returns non-zero at EOF, so a plain `while read` drops this host —
# adding nothing, reporting success, and producing exactly the silent stale rule
# the script exists to prevent.
printf 'dns.google 853' > "$TMP/pinned"
HOSTS_FILE="$TMP/pinned" "$SCRIPT" >/dev/null 2>&1
check "exit 0" "$?" "0"
elems pinned_v4 | grep -q '853' && r=y || r=n; check "last line was read" "$r" "y"

nft delete table inet aimux_egress
cp -a "$TMP/hosts.before" /etc/hosts
diff -q "$TMP/hosts.before" /etc/hosts >/dev/null && r=y || r=n; check "/etc/hosts restored" "$r" "y"

echo
printf '%s failing\n' "$fails"
exit "$fails"
