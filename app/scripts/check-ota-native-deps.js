#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const appRoot = path.join(__dirname, "..");
const versionCandidates = ["lib/version.ts", "src/mobile/config/version.ts"];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function fail(lines) {
  console.error("OTA native dependency check FAILED\n");
  for (const line of lines) console.error(`  ${line}`);
  process.exit(1);
}

function git(args, cwd = appRoot) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function findUp(relativePath) {
  let current = appRoot;
  for (;;) {
    const candidate = path.join(current, relativePath);
    if (fs.existsSync(candidate)) return candidate;
    const next = path.dirname(current);
    if (next === current) return null;
    current = next;
  }
}

function lockVersions(lockfile) {
  const versions = new Map();
  const blocks = lockfile.split(/\n(?=\S)/);
  for (const block of blocks) {
    const header = block.split("\n")[0];
    const version = block.match(/\n {2}version "([^"]+)"/);
    if (!version) continue;
    for (const spec of header.split(",")) {
      const name = spec
        .trim()
        .replace(/^"/, "")
        .replace(/@[^@]*:?$/, "");
      if (!name) continue;
      if (!versions.has(name)) versions.set(name, new Set());
      versions.get(name).add(version[1]);
    }
  }
  return versions;
}

function packageDir(name) {
  return findUp(path.join("node_modules", name));
}

function isNativePackage(name) {
  const dir = packageDir(name);
  if (!dir) return false;
  if (fs.existsSync(path.join(dir, "expo-module.config.json"))) return true;
  try {
    return fs.readdirSync(dir).some((entry) => entry.endsWith(".podspec"));
  } catch {
    return false;
  }
}

const gitRoot = git(["rev-parse", "--show-toplevel"]);
const yarnLockPath = findUp("yarn.lock");
if (!yarnLockPath) fail(["Missing yarn.lock"]);

const versionPath = versionCandidates.map((candidate) => path.join(appRoot, candidate)).find(fs.existsSync);
if (!versionPath) fail([`Could not find version file (${versionCandidates.join(", ")})`]);

const versionRel = path.relative(gitRoot, versionPath).replace(/\\/g, "/");
const yarnLockRel = path.relative(gitRoot, yarnLockPath).replace(/\\/g, "/");
const versionSource = fs.readFileSync(versionPath, "utf8");
const buildNumber = Number(versionSource.match(/buildNumber:\s*(\d+)/)?.[1]);
if (!Number.isFinite(buildNumber)) fail([`Could not read buildNumber from ${versionRel}`]);

let releaseCommit;
try {
  const commits = git(
    ["log", "-S", `buildNumber: ${buildNumber},`, "--format=%H", "--", versionRel],
    gitRoot,
  )
    .split("\n")
    .filter(Boolean);
  releaseCommit = commits[commits.length - 1];
} catch {
  /* handled below */
}

if (!releaseCommit) {
  fail([
    `No commit sets \`buildNumber: ${buildNumber}\` in ${versionRel}.`,
    "An OTA can only be verified against a build that was cut from a commit.",
    "Cut the native build first, or correct the version file.",
  ]);
}

const buildLock = lockVersions(git(["show", `${releaseCommit}:${yarnLockRel}`], gitRoot));
const packageJson = readJson(path.join(appRoot, "package.json"));
const drift = [];

for (const name of Object.keys(packageJson.dependencies ?? {})) {
  if (!isNativePackage(name)) continue;
  const installedPath = path.join(packageDir(name), "package.json");
  if (!fs.existsSync(installedPath)) continue;
  const installed = readJson(installedPath).version;
  const inBuild = buildLock.get(name);
  if (!inBuild) {
    drift.push(`${name}: not present in build ${buildNumber} - it has no native code on the device`);
    continue;
  }
  if (!inBuild.has(installed)) {
    drift.push(`${name}: build ${buildNumber} has ${[...inBuild].join(", ")}, about to ship ${installed}`);
  }
}

if (drift.length) {
  fail([
    `JS about to be shipped does not match the native code in build ${buildNumber}`,
    `(build commit ${releaseCommit.slice(0, 8)}):`,
    "",
    ...drift,
    "",
    "An OTA cannot carry native code. Restore these to the build's versions,",
    "or cut a new native build so the two sides match.",
  ]);
}

console.log(
  `OTA native dependency check passed - native modules match build ${buildNumber} (${releaseCommit.slice(0, 8)})`,
);
