// Auto-generated version file - DO NOT EDIT MANUALLY
// Use 'yarn build:testflight' for new native builds or 'yarn update' for OTA updates

export const APP_VERSION = {
  version: "1.0.0", // Marketing version for app stores
  buildNumber: 2, // Native build number (increments only for native builds)
  otaVersion: 2, // OTA update version (increments for JS updates)
  timestamp: "2026-05-30T23:25:53Z", // Last update timestamp
  channel: "testflight", // 'testflight' for TestFlight or 'production' for App Store
};

export const getVersionString = () => {
  const { buildNumber, otaVersion } = APP_VERSION;
  const versionStr = `${APP_VERSION.version} (${buildNumber}.${otaVersion})`;
  return versionStr;
};

export const getVersionCode = () => {
  return `${APP_VERSION.buildNumber}.${APP_VERSION.otaVersion}`;
};
