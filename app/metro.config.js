const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

// Jotai's ESM files use import.meta.env which Metro's non-module web bundle can't run.
// Force jotai (and jotai-optics) to resolve to their CJS files on web by rewriting
// .mjs → .js paths. The /jotai prefix (no trailing slash) matches both
// node_modules/jotai/ and node_modules/jotai-optics/ entries.
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = originalResolveRequest || context.resolveRequest;
  const result = resolve(context, moduleName, platform);
  if (
    platform === "web" &&
    result?.type === "sourceFile" &&
    result.filePath.includes("/jotai") &&
    result.filePath.endsWith(".mjs")
  ) {
    const cjsPath = result.filePath.replace(/\/esm\/(.+)\.mjs$/, "/$1.js");
    try {
      require("fs").accessSync(cjsPath);
      return { ...result, filePath: cjsPath };
    } catch {}
  }
  return result;
};

module.exports = withNativeWind(config, { input: "./global.css" });
