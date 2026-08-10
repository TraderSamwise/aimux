#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const packageJsonPath = path.join(root, "package.json");
const yarnLockPath = path.join(root, "yarn.lock");
const bundledNativeModulesPath = path.join(
  root,
  "node_modules",
  "expo",
  "bundledNativeModules.json",
);
const podfileLockPath = path.join(root, "ios", "Podfile.lock");

const nativeDeps = [
  {
    packageName: "react-native-svg",
    podName: "RNSVG",
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

const packageJson = readJson(packageJsonPath);
const bundledNativeModules = readJson(bundledNativeModulesPath);
const yarnLock = fs.readFileSync(yarnLockPath, "utf8");
const podfileLock = fs.existsSync(podfileLockPath) ? fs.readFileSync(podfileLockPath, "utf8") : "";
const errors = [];

for (const dep of nativeDeps) {
  const expected = bundledNativeModules[dep.packageName];
  const declared = packageJson.dependencies?.[dep.packageName];

  if (!expected) {
    errors.push(`${dep.packageName} is missing from Expo bundledNativeModules.json`);
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

  if (podfileLock && !podfileLock.includes(`- ${dep.podName} (${expected})`)) {
    errors.push(`${dep.podName} pod is not locked to ${expected} in ios/Podfile.lock`);
  }
}

if (errors.length) fail(errors);

console.log("OTA native dependency check passed");
