#!/bin/bash

# Version Manager Script
# Usage:
#   ./scripts/version-manager.sh bump-build [channel]  # Increment build number (for native builds)
#   ./scripts/version-manager.sh bump-ota              # Increment OTA version
#   ./scripts/version-manager.sh rollback              # Restore from backup
#   ./scripts/version-manager.sh current               # Show current version
#   ./scripts/version-manager.sh set BUILD.OTA [chan]   # Set specific version

set -e

VERSION_FILE="lib/version.ts"
INFO_PLIST="ios/aimux/Info.plist"
PBXPROJ="ios/aimux.xcodeproj/project.pbxproj"

read_current_version() {
    if [ ! -f "$VERSION_FILE" ]; then
        echo "Error: Version file not found"
        exit 1
    fi

    CURRENT_BUILD=$(grep -o 'buildNumber: [0-9]*' "$VERSION_FILE" | grep -o '[0-9]*')
    CURRENT_OTA=$(grep -o 'otaVersion: [0-9]*' "$VERSION_FILE" | grep -o '[0-9]*')

    if [ -z "$CURRENT_BUILD" ] || [ -z "$CURRENT_OTA" ]; then
        echo "Error: Could not read version from $VERSION_FILE"
        exit 1
    fi
}

create_backups() {
    echo "📦 Creating version backup..."
    cp "$VERSION_FILE" "$VERSION_FILE.backup"
    [ -f "$INFO_PLIST" ] && cp "$INFO_PLIST" "$INFO_PLIST.backup"
    [ -f "$PBXPROJ" ] && cp "$PBXPROJ" "$PBXPROJ.backup"
}

update_versions() {
    local new_build=$1
    local new_ota=$2
    local channel=${3:-"testflight"}
    local current_date=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    echo "✏️  Updating version file..."
    cat > "$VERSION_FILE" << EOF
// Auto-generated version file - DO NOT EDIT MANUALLY
// Use 'yarn build:testflight' for new native builds or 'yarn update' for OTA updates

export const APP_VERSION = {
  version: "1.0.0", // Marketing version for app stores
  buildNumber: $new_build, // Native build number (increments only for native builds)
  otaVersion: $new_ota, // OTA update version (increments for JS updates)
  timestamp: "$current_date", // Last update timestamp
  channel: "$channel", // 'testflight' for TestFlight or 'production' for App Store
};

export const getVersionString = () => {
  const { buildNumber, otaVersion } = APP_VERSION;
  const versionStr = \`\${APP_VERSION.version} (\${buildNumber}.\${otaVersion})\`;
  return versionStr;
};

export const getVersionCode = () => {
  return \`\${APP_VERSION.buildNumber}.\${APP_VERSION.otaVersion}\`;
};
EOF

    echo "✅ Version updated!"
    echo "   Version: 1.0.0"
    echo "   Build: $new_build"
    echo "   OTA: $new_ota"
    echo "   Channel: $channel"
}

update_native_versions() {
    local new_build=$1

    # Update iOS Info.plist CFBundleVersion
    if [ -f "$INFO_PLIST" ]; then
        echo "📱 Updating Info.plist CFBundleVersion → $new_build..."
        /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $new_build" "$INFO_PLIST"
    fi

    # Update iOS CURRENT_PROJECT_VERSION in pbxproj (same as tealstreet-mobile)
    if [ -f "$PBXPROJ" ]; then
        echo "📱 Updating iOS CURRENT_PROJECT_VERSION → $new_build..."
        sed -i '' "s/CURRENT_PROJECT_VERSION = [0-9]*;/CURRENT_PROJECT_VERSION = $new_build;/g" "$PBXPROJ"
    fi
}

rollback_versions() {
    echo "⏪ Rolling back version..."
    if [ -f "$VERSION_FILE.backup" ]; then
        cp "$VERSION_FILE.backup" "$VERSION_FILE"
        rm "$VERSION_FILE.backup"
        echo "✅ Rolled back $VERSION_FILE"
    else
        echo "⚠️  No backup found"
    fi
    if [ -f "$INFO_PLIST.backup" ]; then
        cp "$INFO_PLIST.backup" "$INFO_PLIST"
        rm "$INFO_PLIST.backup"
        echo "✅ Rolled back $INFO_PLIST"
    fi
    if [ -f "$PBXPROJ.backup" ]; then
        cp "$PBXPROJ.backup" "$PBXPROJ"
        rm "$PBXPROJ.backup"
        echo "✅ Rolled back $PBXPROJ"
    fi
}

cleanup_backups() {
    rm -f "$VERSION_FILE.backup" "$INFO_PLIST.backup" "$PBXPROJ.backup"
}

commit_version() {
    local message=$1
    echo "📝 Committing version changes..."
    # Commit only version files — don't pick up unrelated staged changes
    local files=("$VERSION_FILE")
    [ -f "$INFO_PLIST" ] && files+=("$INFO_PLIST")
    [ -f "$PBXPROJ" ] && files+=("$PBXPROJ")
    git commit -m "$message" --no-verify -- "${files[@]}" || {
        echo "⚠️  No changes to commit or commit failed"
        return 1
    }
    echo "✅ Version changes committed"
}

case "${1:-}" in
    "bump-build")
        CHANNEL="${2:-testflight}"
        read_current_version
        NEW_BUILD=$((CURRENT_BUILD + 1))
        NEW_OTA=0

        echo "📊 Current version: Build $CURRENT_BUILD.$CURRENT_OTA"
        echo "📈 New version: Build $NEW_BUILD.$NEW_OTA ($CHANNEL)"

        create_backups
        update_versions $NEW_BUILD $NEW_OTA $CHANNEL
        update_native_versions $NEW_BUILD
        commit_version "chore: release Build $NEW_BUILD ($CHANNEL)"
        cleanup_backups
        ;;

    "bump-ota")
        CHANNEL=${2:-"testflight"}
        read_current_version
        NEW_BUILD=$CURRENT_BUILD
        NEW_OTA=$((CURRENT_OTA + 1))

        echo "📊 Current version: Build $CURRENT_BUILD.$CURRENT_OTA"
        echo "📈 New version: Build $NEW_BUILD.$NEW_OTA"

        create_backups
        update_versions $NEW_BUILD $NEW_OTA $CHANNEL
        commit_version "chore: OTA update v$NEW_OTA for Build $NEW_BUILD"
        cleanup_backups
        ;;

    "rollback")
        rollback_versions
        ;;

    "current")
        read_current_version
        echo "📊 Current version:"
        echo "   Marketing Version: 1.0.0"
        echo "   Build Number: $CURRENT_BUILD"
        echo "   OTA Version: $CURRENT_OTA"
        echo "   Display: 1.0.0 ($CURRENT_BUILD.$CURRENT_OTA)"
        ;;

    "set")
        if [ -z "${2:-}" ]; then
            echo "Error: Version format required (e.g., 1.0)"
            echo "Usage: $0 set BUILD.OTA [channel]"
            exit 1
        fi

        VERSION_INPUT="$2"
        if [[ ! "$VERSION_INPUT" =~ ^[0-9]+\.[0-9]+$ ]]; then
            echo "Error: Invalid version format. Use BUILD.OTA (e.g., 2.5)"
            exit 1
        fi

        NEW_BUILD=$(echo "$VERSION_INPUT" | cut -d'.' -f1)
        NEW_OTA=$(echo "$VERSION_INPUT" | cut -d'.' -f2)
        CHANNEL="${3:-testflight}"

        read_current_version
        echo "📊 Current version: Build $CURRENT_BUILD.$CURRENT_OTA"
        echo "📝 Setting version to: Build $NEW_BUILD.$NEW_OTA ($CHANNEL)"

        create_backups
        update_versions $NEW_BUILD $NEW_OTA $CHANNEL
        update_native_versions $NEW_BUILD
        commit_version "chore: set version to Build $NEW_BUILD.$NEW_OTA ($CHANNEL)"
        cleanup_backups
        ;;

    *)
        echo "Usage: $0 {bump-build|bump-ota|rollback|current|set}"
        echo ""
        echo "Commands:"
        echo "  bump-build [channel]  - Increment build number (default: testflight)"
        echo "  bump-ota             - Increment OTA version"
        echo "  rollback             - Restore from backup"
        echo "  current              - Show current version"
        echo "  set BUILD.OTA [chan] - Set specific version (e.g., 2.5)"
        exit 1
        ;;
esac
