#!/bin/bash

# OTA Update Script - Publishes JavaScript updates to existing apps
# Usage:
#   yarn update                # Update testflight channel
#   yarn update:production     # Update production channel

set -e

CHANNEL="testflight"

for arg in "$@"; do
  case $arg in
    --testflight)
      CHANNEL="testflight"
      shift
      ;;
    --production)
      CHANNEL="production"
      shift
      ;;
  esac
done

if [ "$CHANNEL" = "testflight" ]; then
  CHANNEL_NAME="TestFlight"
else
  CHANNEL_NAME="Production"
fi

# Block if dict version is out of sync
./scripts/check-dict-version.sh --strict
node scripts/check-release-env.js "$CHANNEL"

echo "📤 Starting OTA update ($CHANNEL_NAME channel)..."

echo ""
./scripts/version-manager.sh current
echo ""

VERSION_FILE="lib/version.ts"
CURRENT_BUILD=$(grep -o 'buildNumber: [0-9]*' "$VERSION_FILE" | grep -o '[0-9]*')
CURRENT_OTA=$(grep -o 'otaVersion: [0-9]*' "$VERSION_FILE" | grep -o '[0-9]*')

echo "📤 Publishing OTA update..."
eas update --platform ios --branch "$CHANNEL" --message "OTA Update v$CURRENT_OTA for Build $CURRENT_BUILD ($CHANNEL_NAME)"

echo ""
echo "✅ OTA update published!"
echo ""
./scripts/version-manager.sh current
echo ""
echo "Users will receive the update on next app launch."
echo ""
echo "Monitor at: https://expo.dev/accounts/tradersamwise/projects/aimux/updates"
echo ""
echo "🎉 OTA update published successfully!"
