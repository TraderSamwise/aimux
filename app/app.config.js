const { APP_VERSION } = require("./lib/version.ts");

// EAS project ID is set by `eas init` (or passed at build time via env).
// Without a real ID, OTA updates can't function — keep them disabled
// instead of pointing at a placeholder UUID that 404s on every launch.
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID || "f617e4a4-cc8d-4fee-b69c-a2211c5e15c1";
const HAS_REAL_EAS_PROJECT = Boolean(EAS_PROJECT_ID);

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
      bundleIdentifier: "app.aimux.mobile",
      buildNumber: String(APP_VERSION.buildNumber),
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: "./assets/images/adaptive-icon.png",
        backgroundColor: "#0a0a0c",
      },
      versionCode: APP_VERSION.buildNumber,
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
    },
    web: {
      bundler: "metro",
      output: "single",
      favicon: "./assets/images/favicon.png",
    },
    // OTA updates must stay on the same runtime for a given native build.
    // The generated version file changes on every OTA bump, so fingerprint
    // runtime versions would make each OTA target a runtime no installed app has.
    runtimeVersion: `${APP_VERSION.version}-${APP_VERSION.buildNumber}`,
    updates: {
      url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
      enabled: HAS_REAL_EAS_PROJECT,
      checkAutomatically: "ON_LOAD",
      fallbackToCacheTimeout: 30000,
    },
    plugins: [
      "expo-router",
      [
        "expo-splash-screen",
        {
          image: "./assets/images/icon.png",
          imageWidth: 180,
          backgroundColor: "#0a0a0c",
          resizeMode: "contain",
        },
      ],
      [
        "expo-notifications",
        {
          icon: "./assets/images/icon.png",
          color: "#0a0a0c",
        },
      ],
      ...(HAS_REAL_EAS_PROJECT ? ["expo-updates"] : []),
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      router: {},
      ...(HAS_REAL_EAS_PROJECT ? { eas: { projectId: EAS_PROJECT_ID } } : {}),
    },
    owner: "tradersamwise",
  },
};
