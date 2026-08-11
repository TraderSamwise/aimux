// Auto-generated version file - DO NOT EDIT MANUALLY
// Use release scripts for new native builds or OTA updates

export const APP_VERSION = {
  version: "1.0.0", // Marketing version for app stores
  buildNumber: 13, // Native build number (increments only for native builds)
  otaVersion: 12, // OTA update version (increments for JS updates)
  timestamp: "2026-08-11T01:48:28Z", // Last update timestamp
  channel: "testflight", // Release channel
};

export const getVersionString = () => {
  const { buildNumber, otaVersion } = APP_VERSION;
  const versionStr = `${APP_VERSION.version} (${buildNumber}.${otaVersion})`;
  return versionStr;
};

export const getVersionCode = () => {
  return `${APP_VERSION.buildNumber}.${APP_VERSION.otaVersion}`;
};
