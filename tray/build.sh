#!/bin/bash
# Build the aimux tray app
set -e
cd "$(dirname "$0")"

echo "Building AimuxTray..."
swiftc -O \
  -framework AppKit \
  -o AimuxTray \
  AimuxTray.swift

echo "Built: $(pwd)/AimuxTray"
echo ""
echo "To run:  ./AimuxTray &"
echo "To install as login item, add to System Settings > General > Login Items"
