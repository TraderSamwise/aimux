#!/usr/bin/env bash
#
# Refresh the addresses the agent runtime uid may reach directly.
#
# The known weak point of this design, stated plainly: a managed endpoint's
# addresses are not contractually stable, and a protocol that is not HTTP cannot
# go through the domain-allowlisting proxy that everything else does. That
# leaves an IP rule, and an IP rule goes stale.
#
# Two consequences are designed for:
#
#   - The nft set entries carry a timeout, so an address that stops being
#     re-confirmed ages out instead of staying open forever after the endpoint
#     moves.
#   - This exits non-zero when it cannot resolve a configured host, so a stale
#     rule surfaces as a failed unit rather than as the agent mysteriously
#     losing its database days later.
#
# /etc/hosts is written too, because the agent has no DNS at all by design.
set -euo pipefail

# Serialized against itself. The egress unit's reload and the timer can fire at
# the same moment, and both rewrite /etc/hosts.
LOCK=/run/lock/aimux-egress-resolve.lock
if [ "${AIMUX_EGRESS_LOCKED:-}" != "1" ]; then
  export AIMUX_EGRESS_LOCKED=1
  exec flock -w 60 "$LOCK" "$0" "$@"
fi

HOSTS_FILE="${HOSTS_FILE:-/etc/aimux/sandbox/pinned-hosts}"
TABLE="inet aimux_egress"
MARKER_BEGIN="# BEGIN aimux sandbox"
MARKER_END="# END aimux sandbox"
ENTRY_TIMEOUT="2h"

failed=0
declare -A ports_for=()
host_order=()

# `|| [ -n "$line" ]`: read returns non-zero on a last line with no trailing
# newline, and a plain `while read` would skip that entry entirely — adding
# nothing, reporting success, and producing exactly the silent stale rule this
# script exists to prevent.
#
# Not an early exit when the file is empty, either: the /etc/hosts rewrite below
# is what removes the pin for a host that is no longer configured.
while read -r host port _rest || [ -n "$host" ]; do
  [ -n "$host" ] || continue
  case "$host" in \#*) continue ;; esac

  # Hostnames only. This file is root-owned, but the values end up inside an
  # `nft` command, and a hostname is never a place a shell metacharacter belongs.
  if ! printf '%s' "$host" | grep -qE '^[A-Za-z0-9][A-Za-z0-9.-]*$'; then
    echo "REFUSING to resolve a name that is not a hostname: $host" >&2
    failed=1
    continue
  fi

  # A missing port is rejected rather than defaulted. Guessing 5432 here would
  # open a port the operator never wrote down.
  if ! printf '%s' "$port" | grep -qE '^[0-9]{1,5}$' || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "REFUSING $host: '$port' is not a port (expected '<hostname> <port>')" >&2
    failed=1
    continue
  fi

  if [ -z "${ports_for[$host]+set}" ]; then
    host_order+=("$host")
    ports_for[$host]="$port"
  else
    ports_for[$host]="${ports_for[$host]} $port"
  fi
done < "$HOSTS_FILE"

elems_v4=()
elems_v6=()
hosts_block="$MARKER_BEGIN"

for host in "${host_order[@]}"; do
  # +short on A/AAAA rather than getent: this box's nsswitch is `files dns`, and
  # /etc/hosts is what this script writes — getent would read back its own
  # previous answer and call a dead endpoint healthy. The greps also drop the
  # CNAME lines +short emits above the addresses.
  v4="$(dig +short +timeout=5 A "$host" | grep -E '^[0-9]+(\.[0-9]+){3}$' || true)"
  v6="$(dig +short +timeout=5 AAAA "$host" | grep -E '^[0-9a-fA-F:]+$' || true)"

  if [ -z "$v4" ] && [ -z "$v6" ]; then
    echo "FAILED to resolve $host" >&2
    failed=1
    continue
  fi

  for port in ${ports_for[$host]}; do
    for addr in $v4; do elems_v4+=("$addr . $port"); done
    for addr in $v6; do elems_v6+=("$addr . $port"); done
  done

  # One /etc/hosts line per address, regardless of how many ports the name was
  # listed with. glibc reads the first match; the rest are there so a rotation
  # between published addresses does not need a re-resolve to keep working.
  for addr in $v4; do
    hosts_block="$hosts_block
$addr	$host"
  done

  echo "$host [${ports_for[$host]}] -> $(echo "$v4 $v6" | tr '\n' ' ')"
done

hosts_block="$hosts_block
$MARKER_END"

# Nothing is replaced unless EVERY host resolved.
#
# Flushing is what makes a removed host lose its rule promptly, but flushing on
# a partial result would turn a momentary DNS blip into an immediate outage — and
# the entry timeout, which exists to age out a stale address, could never soften
# it. On failure the previous entries stand and the unit goes red.
if [ "$failed" -eq 0 ]; then
  nft flush set $TABLE pinned_v4
  nft flush set $TABLE pinned_v6
  for elem in "${elems_v4[@]}"; do
    nft add element $TABLE pinned_v4 "{ $elem timeout $ENTRY_TIMEOUT }"
  done
  for elem in "${elems_v6[@]}"; do
    nft add element $TABLE pinned_v6 "{ $elem timeout $ENTRY_TIMEOUT }"
  done

  # Written to a temp file in the same directory and renamed, under a lock:
  # `install` truncates in place, so a concurrent run — the timer firing during a
  # `systemctl reload aimux-egress` — can read a half-empty file and lose the
  # localhost line permanently.
  tmp=/etc/hosts.aimux.tmp
  sed "/^${MARKER_BEGIN}$/,/^${MARKER_END}$/d" /etc/hosts > "$tmp"
  printf '%s\n' "$hosts_block" >> "$tmp"
  chown root:root "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" /etc/hosts
fi

exit "$failed"
