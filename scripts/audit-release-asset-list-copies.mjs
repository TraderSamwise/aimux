#!/usr/bin/env node
// The shipped platform set lives in the `release-assets` build matrix, and
// `scripts/release-asset-matrix.py` is how every checker reads it. Dropping
// Intel from the matrix left stale copies behind and each one failed a
// different release tag -- v0.1.59 died on a verifier still expecting
// darwin-x64 with nothing actually wrong.
//
// So: outside the matrix block itself, no asset name may be written down.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = join(ROOT, "scripts", "release-asset-name-allowlist.json");
// Every file that has to know what a complete release looks like. release.yml is
// the only one with the matrix in it; the two Homebrew scripts carry the same
// per-platform template bindings and are where the next stale copy would land.
const SCANNED = [
  ".github/workflows/release.yml",
  "scripts/render-homebrew-formulas.sh",
  "scripts/homebrew-release-dry-run.sh",
];
// Literal names, and the interpolated form that slipped past the first version
// of this audit: `aimux-darwin-${arch}` in a `for arch in arm64 x64` loop is the
// platform set written down just as much as the literal is, and that copy failed
// the npm publish on v0.1.61 after every asset was already published.
const ASSET_NAME = /\baimux(?:-local)?-(?:darwin|linux)-(?:arm64|x64|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*)/g;
const PLATFORM_LOOP = /\bfor\s+(?:arch|platform|variant)\s+in\s+\S/;

export function matrixBlockRange(lines) {
  const job = lines.findIndex((line) => line.startsWith("  release-assets:"));
  if (job < 0) throw new Error("release.yml has no release-assets job");
  const include = lines.findIndex((line, index) => index > job && line.trim() === "include:");
  if (include < 0) throw new Error("release-assets job has no matrix include block");
  let end = include + 1;
  while (end < lines.length && (lines[end].trim() === "" || /^ {10}/.test(lines[end]))) end += 1;
  return { end, start: include };
}

export function hardcodedAssetNames(text, allowed = new Set(), { hasMatrix = true } = {}) {
  const lines = text.split("\n");
  const { end, start } = hasMatrix ? matrixBlockRange(lines) : { end: -1, start: -1 };
  const found = [];
  lines.forEach((line, index) => {
    if (index >= start && index < end) return;
    // A matrix expression is the workflow reading the matrix, not a copy.
    if (line.includes("matrix.asset")) return;
    const trimmed = line.trim();
    if (allowed.has(trimmed)) return;
    // A comment naming the asset that broke a tag is documentation, not a copy.
    if (trimmed.startsWith("#")) return;
    if (PLATFORM_LOOP.test(line)) {
      found.push({ line: index + 1, name: "platform loop", text: trimmed });
      return;
    }
    for (const match of line.matchAll(ASSET_NAME)) {
      found.push({ line: index + 1, name: match[0], text: trimmed });
    }
  });
  return found;
}

// Lines recorded as known template bindings rather than completeness lists.
// A line that leaves the allowlist has to stop naming an asset, and a new copy
// is never allowed in without a reason written down beside it.
export function allowedLines(allowlistText) {
  const parsed = JSON.parse(allowlistText);
  if (typeof parsed.description !== "string" || parsed.description.trim().length === 0) {
    throw new Error("allowlist has no description saying why these copies stand");
  }
  if (!parsed.files || typeof parsed.files !== "object") {
    throw new Error("allowlist has no files map");
  }
  // Per file, so a line allowed in the formula template is not silently allowed
  // in the workflow as well.
  const byFile = new Map();
  for (const [path, lines] of Object.entries(parsed.files)) {
    if (!Array.isArray(lines)) throw new Error(`allowlist entry for ${path} is not an array`);
    byFile.set(path, new Set(lines));
  }
  return byFile;
}

function main() {
  const byFile = allowedLines(readFileSync(ALLOWLIST, "utf8"));
  const unknown = [...byFile.keys()].filter((path) => !SCANNED.includes(path));
  if (unknown.length > 0) {
    process.stderr.write(
      "scripts/release-asset-name-allowlist.json records files this audit does not " +
        "scan, so those entries guarantee nothing:\n",
    );
    for (const path of unknown) process.stderr.write(`  ${path}\n`);
    process.exit(1);
  }

  const problems = [];
  let recorded = 0;
  for (const path of SCANNED) {
    const text = readFileSync(join(ROOT, path), "utf8");
    const allowed = byFile.get(path) ?? new Set();
    recorded += allowed.size;
    for (const line of allowed) {
      if (!text.includes(line)) {
        problems.push(
          `${path}: allowlisted line is gone, remove it so the allowlist cannot hide a ` + `future copy: ${line}`,
        );
      }
    }
    const hasMatrix = path.endsWith("release.yml");
    for (const entry of hardcodedAssetNames(text, allowed, { hasMatrix })) {
      problems.push(`${path}:${entry.line}: ${entry.text}`);
    }
  }

  if (problems.length > 0) {
    process.stderr.write(
      "release assets are named outside the build matrix; read them from " +
        "scripts/release-asset-matrix.py instead, or record the binding with a reason:\n",
    );
    for (const problem of problems) process.stderr.write(`  ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `release asset list audit passed: ${SCANNED.length} file(s) scanned, ` +
      `${recorded} recorded template binding(s), no other copy of the asset set\n`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("audit-release-asset-list-copies.mjs")) main();
