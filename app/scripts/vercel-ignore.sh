#!/usr/bin/env bash
# Vercel Ignored Build Step for aimux.app.
# Exit 1 = build; exit 0 = skip.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

case "${VERCEL_GIT_COMMIT_REF:-}" in
  release)
    ;;
  *)
    echo "Branch ${VERCEL_GIT_COMMIT_REF:-unknown} is not the Aimux web release lane; skipping build."
    exit 0
    ;;
esac

to_sha="${VERCEL_GIT_COMMIT_SHA:-HEAD}"
if ! git rev-parse --verify --quiet "${to_sha}^{commit}" >/dev/null; then
  to_sha="HEAD"
fi

from_sha="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -n "$from_sha" ] && ! git rev-parse --verify --quiet "${from_sha}^{commit}" >/dev/null; then
  echo "Previous commit $from_sha is not present locally; attempting a shallow fetch."
  git fetch --no-tags --depth=1 origin "$from_sha" >/dev/null 2>&1 || true
fi

if [ -z "$from_sha" ] || ! git rev-parse --verify --quiet "${from_sha}^{commit}" >/dev/null; then
  echo "No usable previous commit is available; building Aimux web."
  exit 1
fi

echo "Checking Aimux web changes from $from_sha to $to_sha"

if git diff --name-only "$from_sha" "$to_sha" \
  | grep -E '^(app/(app|assets|components|lib|stores|plugins)/|app/(app\.config\.js|babel\.config\.js|environment\.d\.ts|eslint\.config\.mjs|expo-env\.d\.ts|global\.css|index\.js|metro\.config\.js|nativewind-env\.d\.ts|package\.json|tailwind\.config\.js|tsconfig\.json|vercel\.json|vitest\.config\.ts|yarn\.lock)$|app/scripts/vercel-ignore\.sh$)' \
  | grep -Ev '^(app/(dist|ios|android|\.expo|\.vercel|node_modules)/|app/(README\.md|CLAUDE\.md|AGENTS\.md|\.env\.example|\.gitignore|\.prettierrc|eas-release\.config\.json|eas\.json|native-runtime-baseline\.json)$)' \
  >/dev/null; then
  echo "Aimux web source, dependency, or build configuration changed; building."
  exit 1
fi

echo "No Aimux web-relevant changes; skipping build."
exit 0
