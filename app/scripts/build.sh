#!/bin/bash

# Build Script - Creates native builds
# Usage:
#   yarn build:testflight   # Build for TestFlight (default)
#   yarn build:production   # Build for App Store
#   yarn build --clear-cache
#   yarn build:testflight --clear-cache
#   yarn build:production --clear-cache

set -e

CHANNEL="testflight"
EXTRA_ARGS=()

for arg in "$@"; do
  case $arg in
    --production)
      CHANNEL="production"
      ;;
    --testflight)
      CHANNEL="testflight"
      ;;
    *)
      EXTRA_ARGS+=("$arg")
      ;;
  esac
done

if [ "$CHANNEL" = "production" ]; then
  EAS_PROFILE="production"
  CHANNEL_NAME="Production (App Store)"
else
  EAS_PROFILE="testflight"
  CHANNEL_NAME="TestFlight"
fi

echo "🚀 Starting $CHANNEL_NAME build for iOS..."

echo ""
./scripts/version-manager.sh current
echo ""

node scripts/check-release-env.js "$CHANNEL"

echo "🏗️  Starting EAS build ($CHANNEL_NAME)..."
eas build --platform ios --profile "$EAS_PROFILE" --auto-submit "${EXTRA_ARGS[@]}"

echo ""
echo "✅ Build process complete!"
echo ""
./scripts/version-manager.sh current
echo ""
echo "Monitor progress at: https://expo.dev/accounts/tradersamwise/projects/aimux/builds"
echo ""
echo "🎉 Build initiated successfully!"
