#!/bin/bash

# Build Script - Creates native builds
# Usage:
#   yarn build:testflight   # Build for TestFlight (default)
#   yarn build:production   # Build for App Store
#   yarn build --android
#   yarn build --platform all
#   yarn build --clear-cache
#   yarn build:testflight --clear-cache
#   yarn build:production --clear-cache

set -e

CHANNEL="testflight"
PLATFORM="ios"
EXTRA_ARGS=()

while [ $# -gt 0 ]; do
  arg="$1"
  case $arg in
    --production)
      CHANNEL="production"
      ;;
    --testflight)
      CHANNEL="testflight"
      ;;
    --ios)
      PLATFORM="ios"
      ;;
    --android)
      PLATFORM="android"
      ;;
    --all)
      PLATFORM="all"
      ;;
    --platform)
      if [ -z "${2:-}" ]; then
        echo "Missing value for --platform"
        exit 1
      fi
      PLATFORM="$2"
      shift
      ;;
    *)
      EXTRA_ARGS+=("$arg")
      ;;
  esac
  shift
done

case "$PLATFORM" in
  ios|android|all)
    ;;
  *)
    echo "Invalid platform '$PLATFORM'. Use ios, android, or all."
    exit 1
    ;;
esac

if [ "$CHANNEL" = "production" ]; then
  EAS_PROFILE="production"
  CHANNEL_NAME="Production (App Store)"
else
  EAS_PROFILE="testflight"
  CHANNEL_NAME="TestFlight"
fi

echo "🚀 Starting $CHANNEL_NAME build for $PLATFORM..."

echo ""
./scripts/version-manager.sh current
echo ""

node scripts/check-release-env.js "$CHANNEL"

echo "🏗️  Starting EAS build ($CHANNEL_NAME)..."
eas build --platform "$PLATFORM" --profile "$EAS_PROFILE" --auto-submit "${EXTRA_ARGS[@]}"

echo ""
echo "✅ Build process complete!"
echo ""
./scripts/version-manager.sh current
echo ""
echo "Monitor progress at: https://expo.dev/accounts/tradersamwise/projects/aimux/builds"
echo ""
echo "🎉 Build initiated successfully!"
