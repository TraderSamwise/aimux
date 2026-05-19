const { APP_VERSION } = require("./lib/version.ts");

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
      favicon: "./assets/images/favicon.png",
    },
    runtimeVersion: "1.0.0",
    updates: {
      url: "https://u.expo.dev/00000000-0000-0000-0000-000000000000",
      enabled: true,
      checkAutomatically: "ON_LOAD",
      fallbackToCacheTimeout: 30000,
    },
    plugins: ["expo-router", "expo-updates", "expo-image-picker"],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      router: {},
      eas: {
        projectId: "00000000-0000-0000-0000-000000000000",
      },
    },
    owner: "tradersamwise",
  },
};
