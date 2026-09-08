#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const failures = [];

const allowedSrcFiles = new Set([
  "src/agent-events-contract.ts",
  "src/agent-transcript-contract.ts",
  "src/attachment-text.ts",
  "src/core-command-contract.ts",
  "src/expose-preview-crop.ts",
  "src/multiplexer/dashboard-alert-flash.contract.v1.json",
  "src/multiplexer/dashboard-footer-hints.contract.v1.json",
  "src/multiplexer/dashboard-interaction.contract.v1.json",
  "src/multiplexer/dashboard-lifecycle.contract.v1.json",
  "src/multiplexer/dashboard-project-event-refresh.contract.v1.json",
  "src/multiplexer/dashboard-session-details.contract.v1.json",
  "src/multiplexer/dashboard-tui-visibility.contract.v1.json",
  "src/multiplexer/desktop-state-golden.fixture.json",
  "src/project-api-contract.ts",
  "src/relay-contract.ts",
  "src/tmux/statusline-script.contract.v1.json",
  "src/worktree-colors.ts",
]);

function fail(message) {
  failures.push(message);
}

function read(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

function walk(dir, visit) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, visit);
      continue;
    }
    visit(path);
  }
}

function assertNoPattern(path, pattern, description) {
  const text = read(path);
  if (pattern.test(text)) {
    fail(`${path} contains ${description}`);
  }
}

function checkSourceBoundary() {
  walk(join(repoRoot, "src"), (path) => {
    const rel = relative(repoRoot, path);
    if (!allowedSrcFiles.has(rel)) {
      fail(`retired source file is still present: ${rel}`);
    }
  });

  for (const path of allowedSrcFiles) {
    if (!existsSync(join(repoRoot, path))) {
      fail(`expected app contract file is missing: ${path}`);
    }
  }
}

function checkPackageBoundary() {
  const pkg = JSON.parse(read("package.json"));
  const packageFiles = pkg.files ?? [];
  for (const path of packageFiles) {
    if (path === "dist" || path.startsWith("dist/")) {
      fail(`package.json files includes retired runtime payload: ${path}`);
    }
  }
  if (pkg.main !== "bin/aimux") {
    fail(`package.json main must remain bin/aimux, got ${JSON.stringify(pkg.main)}`);
  }
  if (pkg.bin?.aimux !== "./bin/aimux") {
    fail(`package.json bin.aimux must remain ./bin/aimux, got ${JSON.stringify(pkg.bin?.aimux)}`);
  }
}

function checkRuntimeScripts() {
  assertNoPattern("bin/aimux", /\bnode\b|dist\/(?:launcher-bin|main)\.js/, "a Node runtime launcher");
  assertNoPattern(
    "scripts/install.sh",
    /\bnode\b|dist\/(?:launcher-bin|main)\.js|installed-aimux-shim\.sh/,
    "a retired Node install path",
  );
  assertNoPattern(
    "scripts/installed-aimux-shim.sh",
    /\bnode\b|dist\/(?:launcher-bin|main)\.js/,
    "a retired Node launcher",
  );
}

checkSourceBoundary();
checkPackageBoundary();
checkRuntimeScripts();

if (failures.length > 0) {
  console.error("Local build boundary check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Local build boundary check passed for native-first source and package boundaries");
