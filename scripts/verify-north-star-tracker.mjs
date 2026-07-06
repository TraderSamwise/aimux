#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const failures = [];

function readProjectFile(path) {
  return readFileSync(join(root, path), "utf8");
}

function fail(message) {
  failures.push(message);
}

function expectIncludes(file, needle, label = needle) {
  const text = readProjectFile(file);
  if (!text.includes(needle)) {
    fail(`${file} is missing ${label}`);
  }
}

function expectPackageScript(name, expected) {
  const packageJson = JSON.parse(readProjectFile("package.json"));
  const actual = packageJson.scripts?.[name];
  if (actual !== expected) {
    fail(`package.json script ${name} should be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const tracker = "docs/north-star-completion-tracker.md";

expectIncludes("docs/core-sidecar-north-star.md", "[north-star-completion-tracker.md](north-star-completion-tracker.md)", "tracker link");
expectIncludes(tracker, "[release-readiness-gate.md](release-readiness-gate.md)", "release readiness gate link");
expectIncludes("docs/release-readiness-gate.md", "yarn release:readiness", "automated readiness command");
expectIncludes("docs/release-readiness-gate.md", "app verification", "app verification scope");
expectIncludes("docs/release-readiness-gate.md", "aimux doctor versions", "version coherence check");
expectIncludes("docs/release-readiness-gate.md", "aimux restart", "single recovery command");
expectIncludes("docs/command-ownership-inventory.md", "No commands currently live in this category.", "empty shim gap marker");
expectIncludes("docs/runtime-authority-dead-paths.md", "## Completion Gate", "runtime authority completion gate");
expectIncludes(".github/workflows/release.yml", "yarn release:readiness", "release workflow readiness gate");

for (const epic of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]) {
  expectIncludes(tracker, `### Epic ${epic}:`, `Epic ${epic}`);
}

for (const area of [
  "Command no-spawn healthy paths",
  "Daemon/project-service ownership",
  "TUI shared state API boundary",
  "TUI transition stability",
  "Web/mobile resource lifecycle",
  "Project-service events parity",
  "Runtime topology authority",
  "Runtime exchange authority",
  "tmux boundary",
  "Upgrade/restart coherence",
  "Dead-code/dead-path deletion",
  "Regression smoke coverage",
]) {
  expectIncludes(tracker, `| ${area} |`, `Executive Snapshot row: ${area}`);
}

expectPackageScript("verify:north-star", "./scripts/verify-north-star-tracker.mjs");
expectPackageScript("verify:app", "yarn --cwd app typecheck && yarn --cwd app lint && yarn --cwd app test");
expectPackageScript("release:readiness", "yarn verify && yarn verify:app && yarn verify:north-star");

if (failures.length > 0) {
  console.error("North-star tracker verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("North-star tracker verification passed.");
