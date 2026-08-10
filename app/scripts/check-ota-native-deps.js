#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const packageJsonPath = path.join(root, "package.json");
const yarnLockPath = path.join(root, "yarn.lock");
const versionPath = path.join(root, "lib", "version.ts");
const nativeRuntimeBaselinePath = path.join(root, "native-runtime-baseline.json");

const nativeDeps = [
  {
    packageName: "react-native-svg",
  },
  {
    packageName: "react-native-keyboard-controller",
  },
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lockVersionFor(lockfile, packageName) {
  const packagePattern = escapeRegExp(packageName);
  const blockPattern = new RegExp(`(^|\\n)${packagePattern}@[^\\n]*:\\n(?:  .+\\n)+`, "g");
  const versions = [];
  let match;
  while ((match = blockPattern.exec(lockfile))) {
    const versionMatch = match[0].match(/\n  version "([^"]+)"/);
    if (versionMatch) versions.push(versionMatch[1]);
  }
  return versions;
}

function fail(errors) {
  console.error("OTA native dependency check failed");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

function readAppVersion(filePath) {
  const contents = fs.readFileSync(filePath, "utf8");
  const buildNumber = contents.match(/buildNumber:\s*(\d+)/)?.[1];
  const otaVersion = contents.match(/otaVersion:\s*(\d+)/)?.[1];
  if (!buildNumber || !otaVersion) {
    fail([`Could not read buildNumber/otaVersion from ${path.relative(root, filePath)}`]);
  }
  return {
    buildNumber: Number(buildNumber),
    otaVersion: Number(otaVersion),
  };
}

const packageJson = readJson(packageJsonPath);
const appVersion = readAppVersion(versionPath);
const nativeRuntimeBaseline = readJson(nativeRuntimeBaselinePath);
const yarnLock = fs.readFileSync(yarnLockPath, "utf8");
const errors = [];

if (nativeRuntimeBaseline.buildNumber !== appVersion.buildNumber) {
  errors.push(
    `native-runtime-baseline.json is for build ${nativeRuntimeBaseline.buildNumber}; current app build is ${appVersion.buildNumber}. Update it only after the native build is submitted.`,
  );
}

for (const dep of nativeDeps) {
  const expected = nativeRuntimeBaseline.nativeDependencies?.[dep.packageName];
  const declared = packageJson.dependencies?.[dep.packageName];

  if (!expected) {
    if (declared) {
      errors.push(
        `${dep.packageName}@${declared} is declared but is not in native-runtime-baseline.json for build ${nativeRuntimeBaseline.buildNumber}`,
      );
    }
    continue;
  }

  if (declared !== expected) {
    errors.push(
      `${dep.packageName} must be pinned to ${expected} for OTA; package.json declares ${declared ?? "missing"}`,
    );
  }

  const lockVersions = lockVersionFor(yarnLock, dep.packageName);
  const unexpectedLockVersions = lockVersions.filter((version) => version !== expected);
  if (!lockVersions.includes(expected)) {
    errors.push(`${dep.packageName}@${expected} is missing from yarn.lock`);
  }
  for (const version of unexpectedLockVersions) {
    errors.push(`${dep.packageName}@${version} is still present in yarn.lock`);
  }

  const installedPackageJsonPath = path.join(root, "node_modules", dep.packageName, "package.json");
  if (fs.existsSync(installedPackageJsonPath)) {
    const installed = readJson(installedPackageJsonPath).version;
    if (installed !== expected) {
      errors.push(`${dep.packageName} installed version is ${installed}; expected ${expected}`);
    }
  }
}

if (errors.length) fail(errors);

console.log("OTA native dependency check passed");
