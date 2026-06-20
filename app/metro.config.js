const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("path");

const config = getDefaultConfig(__dirname);

config.watchFolders = Array.from(new Set([...(config.watchFolders ?? []), path.resolve(__dirname, "..")]));

// Jotai's ESM files use import.meta.env which Metro's non-module web bundle can't run.
// Force jotai (and jotai-optics) to resolve to their CJS files on web by rewriting
// .mjs → .js paths. The /jotai prefix matches both node_modules/jotai/ and
// node_modules/jotai-optics/. Patterns accept either path separator so the rewrite
// fires on Windows hosts too.
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = originalResolveRequest || context.resolveRequest;
  const result = resolve(context, moduleName, platform);
  if (
    platform === "web" &&
    result?.type === "sourceFile" &&
    /[\\/]jotai/.test(result.filePath) &&
    result.filePath.endsWith(".mjs")
  ) {
    const cjsPath = result.filePath.replace(/[\\/]esm[\\/]([^\\/]+)\.mjs$/, (_, name) => {
      const sep = result.filePath.includes("\\") ? "\\" : "/";
      return `${sep}${name}.js`;
    });
    try {
      require("fs").accessSync(cjsPath);
      return { ...result, filePath: cjsPath };
    } catch {}
  }
  return result;
};

module.exports = withNativeWind(config, { input: "./global.css" });
