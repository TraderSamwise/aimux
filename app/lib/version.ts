// Auto-generated version file - DO NOT EDIT MANUALLY
// Use release scripts for new native builds or OTA updates

export const APP_VERSION = {
  version: "1.0.0", // Marketing version for app stores
  buildNumber: 25, // Native build number (increments only for native builds)
  otaVersion: 0, // OTA update version (increments for JS updates)
  timestamp: "2026-09-07T13:45:13Z", // Last update timestamp
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
