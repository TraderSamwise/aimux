#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s must be run with bash\n' "$0" >&2
  exit 2
fi
set -euo pipefail

scripts/run-yarn verify:push

while read -r local_ref local_sha remote_ref remote_sha; do
  if [ -z "${local_ref:-}" ] || [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi

  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    # A new branch has no remote sha to diff against, and a BARE sha is not the
    # answer: `git rev-list <sha>` walks the whole ancestry, so every
    # new-branch push re-checked all 6546 commits and ran
    # `verify-commit-tree-clean.sh` for each one predating the commit-msg hook.
    # Measured on this repo: 6546 commits visited to push 3.
    #
    # `--not --remotes=origin` is the set this push actually adds -- reachable
    # from the new branch and from no origin ref. Coverage of NEW commits is
    # unchanged; what stops is re-verifying history that is already on the
    # remote and was checked when it got there. A repo with no origin refs
    # yet excludes nothing and walks everything, exactly as before.
    bash scripts/check-commit-hook-attestations.sh "$local_sha" --not --remotes=origin
  else
    bash scripts/check-commit-hook-attestations.sh "$remote_sha..$local_sha"
  fi
done
