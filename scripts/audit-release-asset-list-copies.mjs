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
const WORKFLOW = join(ROOT, ".github", "workflows", "release.yml");
const ALLOWLIST = join(ROOT, "scripts", "release-asset-name-allowlist.json");
const ASSET_NAME = /\baimux(?:-local)?-(?:darwin|linux)-(?:arm64|x64)\b/g;

export function matrixBlockRange(lines) {
  const job = lines.findIndex((line) => line.startsWith("  release-assets:"));
  if (job < 0) throw new Error("release.yml has no release-assets job");
  const include = lines.findIndex((line, index) => index > job && line.trim() === "include:");
  if (include < 0) throw new Error("release-assets job has no matrix include block");
  let end = include + 1;
  while (end < lines.length && (lines[end].trim() === "" || /^ {10}/.test(lines[end]))) end += 1;
  return { end, start: include };
}

export function hardcodedAssetNames(text, allowed = new Set()) {
  const lines = text.split("\n");
  const { end, start } = matrixBlockRange(lines);
  const found = [];
  lines.forEach((line, index) => {
    if (index >= start && index < end) return;
    // A matrix expression is the workflow reading the matrix, not a copy.
    if (line.includes("matrix.asset")) return;
    const trimmed = line.trim();
    if (allowed.has(trimmed)) return;
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
  if (!Array.isArray(parsed.lines)) throw new Error("allowlist has no lines array");
  if (typeof parsed.description !== "string" || parsed.description.trim().length === 0) {
    throw new Error("allowlist has no description saying why these copies stand");
  }
  return new Set(parsed.lines);
}

function main() {
  const allowed = allowedLines(readFileSync(ALLOWLIST, "utf8"));
  const workflow = readFileSync(WORKFLOW, "utf8");
  const stale = [...allowed].filter((line) => !workflow.includes(line));
  if (stale.length > 0) {
    process.stderr.write(
      "scripts/release-asset-name-allowlist.json names lines release.yml no longer has; " +
        "remove them so the allowlist cannot hide a future copy:\n",
    );
    for (const line of stale) process.stderr.write(`  ${line}\n`);
    process.exit(1);
  }
  const found = hardcodedAssetNames(workflow, allowed);
  if (found.length > 0) {
    process.stderr.write(
      "release.yml names release assets outside the build matrix; read them from " +
        "scripts/release-asset-matrix.py instead:\n",
    );
    for (const entry of found) {
      process.stderr.write(`  release.yml:${entry.line}: ${entry.text}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(
    `release asset list audit passed: ${allowed.size} recorded template binding(s), ` +
      "no other copy of the asset set\n",
  );
}

if (process.argv[1] && process.argv[1].endsWith("audit-release-asset-list-copies.mjs")) main();
