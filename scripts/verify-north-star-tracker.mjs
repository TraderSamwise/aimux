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
const overview = "docs/core-sidecar-north-star.md";
const trackerText = readProjectFile(tracker);
const overviewText = readProjectFile(overview);

expectIncludes(overview, "[north-star-completion-tracker.md](north-star-completion-tracker.md)", "tracker link");
expectIncludes(overview, "## Completion State", "completion-state section");
expectIncludes(overview, "## Completed Architecture", "completed architecture section");
expectIncludes(tracker, "[release-readiness-gate.md](release-readiness-gate.md)", "release readiness gate link");
expectIncludes("docs/release-readiness-gate.md", "yarn release:readiness", "automated readiness command");
expectIncludes("docs/release-readiness-gate.md", "app verification", "app verification scope");
expectIncludes("docs/release-readiness-gate.md", "aimux doctor versions", "version coherence check");
expectIncludes("docs/release-readiness-gate.md", "aimux restart", "single recovery command");
expectIncludes("docs/command-ownership-inventory.md", "No commands currently live in this category.", "empty shim gap marker");
expectIncludes("docs/runtime-authority-dead-paths.md", "## Completion Gate", "runtime authority completion gate");
expectIncludes(".github/workflows/release.yml", "yarn release:readiness", "release workflow readiness gate");

const expectedEpics = [
  ["A", "Release Coherence Gate"],
  ["B", "Healthy CLI No-Spawn Purity"],
  ["C", "One TUI Connection Contract"],
  ["D", "Lifecycle Transition Contract"],
  ["E", "App/Web/Mobile Resource Contract"],
  ["F", "Project-Service Events Parity"],
  ["G", "Runtime Topology Authority"],
  ["H", "Runtime Exchange Authority"],
  ["I", "Tmux Boundary And Remote Equivalents"],
  ["J", "Diagnostics, Debug, And Dead-Path Deletion"],
];
for (const [epic, title] of expectedEpics) {
  expectIncludes(tracker, `### Epic ${epic}: ${title}`, `Epic ${epic}: ${title}`);
}

if (trackerText.includes("- [ ]")) {
  fail(`${tracker} still has unchecked north-star completion items`);
}

for (const stalePhrase of ["## Current Focus", "## Current Progress", "The remaining work is"]) {
  if (overviewText.includes(stalePhrase)) {
    fail(`${overview} still contains stale migration wording: ${stalePhrase}`);
  }
}

const epicHeadings = [...trackerText.matchAll(/^### Epic ([A-J]): (.+)$/gm)].map((match) => ({
  epic: match[1],
  title: match[2],
  offset: match.index ?? 0,
}));
if (epicHeadings.length !== expectedEpics.length) {
  fail(`${tracker} should have ${expectedEpics.length} epic headings, got ${epicHeadings.length}`);
}
for (const [index, [expectedEpic, expectedTitle]] of expectedEpics.entries()) {
  const heading = epicHeadings[index];
  if (!heading || heading.epic !== expectedEpic || heading.title !== expectedTitle) {
    fail(`${tracker} epic ${index + 1} should be Epic ${expectedEpic}: ${expectedTitle}`);
    continue;
  }
  const nextHeading = epicHeadings[index + 1];
  const section = trackerText.slice(heading.offset, nextHeading?.offset ?? trackerText.length);
  const status = section.match(/^Status: `([^`]+)`$/m)?.[1] ?? "";
  if (status !== "Done") {
    fail(`${tracker} Epic ${expectedEpic} should be Done, got ${status || "<missing>"}`);
  }
}

const expectedSnapshotAreas = [
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
];
for (const area of expectedSnapshotAreas) {
  expectIncludes(tracker, `| ${area} |`, `Executive Snapshot row: ${area}`);
}

const snapshotStart = trackerText.indexOf("## Executive Snapshot");
const epicsStart = trackerText.indexOf("## Completion Epics");
if (snapshotStart === -1 || epicsStart === -1 || epicsStart <= snapshotStart) {
  fail(`${tracker} should contain Executive Snapshot before Completion Epics`);
} else {
  const snapshotRows = trackerText
    .slice(snapshotStart, epicsStart)
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.includes("---") && !line.includes("| Area |"));
  if (snapshotRows.length !== expectedSnapshotAreas.length) {
    fail(`${tracker} should have ${expectedSnapshotAreas.length} Executive Snapshot rows, got ${snapshotRows.length}`);
  }
  for (const [index, row] of snapshotRows.entries()) {
    const columns = row.split("|").map((column) => column.trim());
    const area = columns[1];
    if (area !== expectedSnapshotAreas[index]) {
      fail(`${tracker} Executive Snapshot row ${index + 1} should be ${expectedSnapshotAreas[index]}, got ${area}`);
    }
    if (columns[2] !== "Done") {
      fail(`${tracker} Executive Snapshot row should be Done: ${row}`);
    }
  }
}

expectPackageScript("verify:north-star", "./scripts/verify-north-star-tracker.mjs");
expectPackageScript("verify:app", "yarn --cwd app typecheck && yarn --cwd app lint --max-warnings=0 && yarn --cwd app test");
expectPackageScript("release:readiness", "yarn verify && yarn verify:app && yarn verify:north-star");

if (failures.length > 0) {
  console.error("North-star tracker verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("North-star tracker verification passed.");
