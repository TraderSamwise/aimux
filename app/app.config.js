const { APP_VERSION } = require("./lib/version.ts");

// EAS project ID is set by `eas init` (or passed at build time via env).
// Without a real ID, OTA updates can't function — keep them disabled
// instead of pointing at a placeholder UUID that 404s on every launch.
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID || "00000000-0000-0000-0000-000000000000";
const HAS_REAL_EAS_PROJECT = EAS_PROJECT_ID !== "00000000-0000-0000-0000-000000000000";

module.exports = {
  expo: {
    name: "aimux",
    slug: "aimux",
    version: APP_VERSION.version || "1.0.0",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: "aimux",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.tradersamwise.aimux",
      buildNumber: String(APP_VERSION.buildNumber),
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSPhotoLibraryUsageDescription:
          "Allow $(PRODUCT_NAME) to access your photo library for attaching images.",
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: "./assets/images/adaptive-icon.png",
        backgroundColor: "#ffffff",
      },
      versionCode: APP_VERSION.buildNumber,
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
    },
    web: {
      bundler: "metro",
      output: "single",
    },
    runtimeVersion: { policy: "fingerprint" },
    updates: {
      url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
      enabled: HAS_REAL_EAS_PROJECT,
      checkAutomatically: "ON_LOAD",
      fallbackToCacheTimeout: 30000,
    },
    plugins: HAS_REAL_EAS_PROJECT
      ? ["expo-router", "expo-updates", "expo-image-picker"]
      : ["expo-router", "expo-image-picker"],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      router: {},
      eas: {
        projectId: EAS_PROJECT_ID,
      },
    },
    owner: "tradersamwise",
  },
};
