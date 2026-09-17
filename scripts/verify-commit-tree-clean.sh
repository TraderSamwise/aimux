#!/usr/bin/env bash
# Verify a commit's tree satisfies the invariant the pre-commit hook protects,
# for commits created by paths that cannot run the hook (git revert,
# git cherry-pick, external release tooling committing directly).
#
# This is deliberately stronger than trusting a trailer: it checks the tree
# itself rather than asserting that someone ran something. A --no-verify commit
# whose tree is dirty still fails here.
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

COMMIT="${1:?commit is required}"

CHANGED="$(git diff-tree --no-commit-id --name-only -r "$COMMIT")"
[ -n "$CHANGED" ] || exit 0

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/aimux-attest-XXXXXX")"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

status=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  git cat-file -e "$COMMIT:$path" 2>/dev/null || continue

  case "$path" in
    *.rs)
      mkdir -p "$WORKDIR/$(dirname "$path")"
      git show "$COMMIT:$path" > "$WORKDIR/$path"
      if ! rustfmt --edition 2024 --check "$WORKDIR/$path" >/dev/null 2>&1; then
        printf 'aimux: %s is not rustfmt-clean at %s\n' "$path" "$COMMIT" >&2
        status=1
      fi
      ;;
  esac
done <<< "$CHANGED"

exit "$status"
