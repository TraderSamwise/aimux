#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const envProductionPath = path.join(root, ".env.production");
const envPath = path.join(root, ".env");
const easJsonPath = path.join(root, "eas.json");
const envTypesPath = path.join(root, "environment.d.ts");
const envRuntimePath = path.join(root, "lib", "envRuntime.ts");
const { requiredReleaseEnvKeys, allKnownEnvKeys } = require("../lib/envContract");

const target = process.argv[2] || "production";
const allowedProfiles = new Set(["production", "testflight"]);
if (!allowedProfiles.has(target)) {
  console.error(`Invalid release profile '${target}'. Use 'production' or 'testflight'.`);
  process.exit(1);
}
const profile = target;

function parseEnvFile(content) {
  const values = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    values[line.slice(0, eqIndex).trim()] = line.slice(eqIndex + 1).trim();
  }
  return values;
}

function collectFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectSourceFiles() {
  const roots = ["app", "components", "db", "lib", "packages", "scripts"].map((item) =>
    path.join(root, item),
  );
  return roots.flatMap(collectFiles).filter((file) => !file.endsWith("envContract.js"));
}

function isTestFile(file) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path.basename(file));
}

function findUsedPublicEnvKeys() {
  const keys = new Set();
  const pattern = /process\.env\.(EXPO_PUBLIC_[A-Z0-9_]+)/g;

  for (const file of collectSourceFiles()) {
    const content = fs.readFileSync(file, "utf8");
    let match;
    while ((match = pattern.exec(content))) keys.add(match[1]);
  }

  return [...keys].sort();
}

function findDisallowedDirectEnvReads() {
  const directReads = [];
  const pattern = /process\.env\.(EXPO_PUBLIC_[A-Z0-9_]+)/g;

  for (const file of collectSourceFiles()) {
    if (file === envRuntimePath) continue;
    if (isTestFile(file)) continue;
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          directReads.push(`${path.relative(root, file)}:${index + 1}`);
        }
      });
  }

  return directReads;
}

function findDeclaredPublicEnvKeys() {
  if (!fs.existsSync(envTypesPath)) return [];
  const keys = new Set();
  const pattern = /\b(EXPO_PUBLIC_[A-Z0-9_]+)\??:/g;
  const content = fs.readFileSync(envTypesPath, "utf8");
  let match;
  while ((match = pattern.exec(content))) keys.add(match[1]);
  return [...keys].sort();
}

function readReleaseEnv(profile) {
  const envFilePath = profile === "production" ? envProductionPath : envPath;
  if (!fs.existsSync(envFilePath)) return { envFilePath, values: {} };
  return {
    envFilePath,
    values: parseEnvFile(fs.readFileSync(envFilePath, "utf8")),
  };
}

if (!fs.existsSync(easJsonPath)) {
  console.error("Missing eas.json");
  process.exit(1);
}

const { envFilePath, values: releaseEnv } = readReleaseEnv(profile);
const easJson = JSON.parse(fs.readFileSync(easJsonPath, "utf8"));
const easEnv = easJson?.build?.[profile]?.env || {};
const usedKeys = findUsedPublicEnvKeys();
const declaredKeys = findDeclaredPublicEnvKeys();
const releaseFileKeys = Object.keys(releaseEnv).filter((key) => key.startsWith("EXPO_PUBLIC_"));
const easPublicKeys = Object.keys(easEnv).filter((key) => key.startsWith("EXPO_PUBLIC_"));
const knownKeys = new Set(allKnownEnvKeys);
const errors = [];

for (const key of [...usedKeys, ...declaredKeys, ...releaseFileKeys, ...easPublicKeys]) {
  if (!knownKeys.has(key)) {
    errors.push(
      `${key} is used, declared, or present in release env but missing from lib/envContract.js`,
    );
  }
}

for (const key of allKnownEnvKeys) {
  if (!declaredKeys.includes(key)) {
    errors.push(`${key} is classified in envContract.js but missing from environment.d.ts`);
  }
}

for (const location of findDisallowedDirectEnvReads()) {
  errors.push(`${location} reads process.env.EXPO_PUBLIC_* directly; use lib/env.ts instead`);
}

for (const key of requiredReleaseEnvKeys) {
  if (!releaseEnv[key]) {
    errors.push(`${path.relative(root, envFilePath)} missing ${key}`);
  }
}

for (const key of easPublicKeys) {
  if (releaseEnv[key] && releaseEnv[key] !== easEnv[key]) {
    errors.push(
      `${key} differs between ${path.relative(root, envFilePath)} and eas.json build.${profile}.env`,
    );
  }
}

if (errors.length) {
  console.error(`Release env check failed for profile '${profile}'`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`Release env check passed for profile '${profile}'`);
