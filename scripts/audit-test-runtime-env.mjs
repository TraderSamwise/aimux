#!/usr/bin/env node
// Which runtime a test talks to is decided by AIMUX_HOME and the daemon
// coordinates beside it. Setting one of those process-wide inside a test
// binary changes that answer for every sibling test running in parallel, and
// the sibling never took a lock because it only ever *read* the value. That
// race failed the v0.1.58 release tag.
//
// So these variables are stated, not exported: a test passes its home through
// an explicit seam (PathResolver::new, TmuxRuntimeConfig, a child process env)
// and leaves the process alone. The few places that genuinely cannot are
// classified, with a reason, in the allowlist beside this file.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const allowlistPath = resolve(repoRoot, "scripts/test-runtime-env-allowlist.json");

const SCAN_ROOTS = ["native/crates/aimux/src", "native/crates/aimux/tests"];
const SKIP_DIRECTORIES = new Set(["node_modules", "target", ".git"]);

// The variables that decide which runtime, home, and daemon a process talks to.
const RUNTIME_IDENTITY_VARS = [
  "AIMUX_HOME",
  "AIMUX_DAEMON_HOST",
  "AIMUX_DAEMON_PORT",
  "AIMUX_TMUX_SOCKET_PATH",
  "HOME",
];

const ENV_MUTATION = /env::(set_var|remove_var)\s*\(\s*([^,)]+)/g;

function listFiles(directory) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = resolve(directory, entry);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      found.push(...listFiles(full));
      continue;
    }
    if (entry.endsWith(".rs")) found.push(full);
  }
  return found;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function enclosingFunction(source, index) {
  let name = "";
  for (const match of source.slice(0, index).matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    name = match[1];
  }
  return name;
}

// `set_var("AIMUX_HOME", ..)` names the variable outright. `set_var(key, ..)`
// does not, so the surrounding function is read for the literal it was handed.
function mutatedVariables(argument, source, index) {
  const literal = /"([A-Z_][A-Z0-9_]*)"/.exec(argument);
  if (literal) return RUNTIME_IDENTITY_VARS.filter((name) => name === literal[1]);
  const body = source.slice(Math.max(0, index - 2000), index + 2000);
  return RUNTIME_IDENTITY_VARS.filter((name) => body.includes(`"${name}"`));
}

export function scanSource(relativePath, source) {
  const hits = [];
  for (const match of source.matchAll(ENV_MUTATION)) {
    const variables = mutatedVariables(match[2], source, match.index);
    if (variables.length === 0) continue;
    hits.push({
      file: relativePath,
      function: enclosingFunction(source, match.index),
      line: lineOf(source, match.index),
      variables,
    });
  }
  return hits;
}

const keyOf = (file, functionName) => `${file}#${functionName}`;

function loadAllowlist() {
  const parsed = JSON.parse(readFileSync(allowlistPath, "utf8"));
  const byKey = new Map();
  for (const entry of parsed.entries) {
    if (!entry.function) {
      throw new Error(
        `test-runtime-env allowlist entry for ${entry.file} names no function; a whole file is too coarse to exempt`,
      );
    }
    if (!entry.reason || entry.reason.trim().length === 0) {
      throw new Error(`test-runtime-env allowlist entry for ${entry.file} has no reason`);
    }
    byKey.set(keyOf(entry.file, entry.function), entry);
  }
  return byKey;
}

function main() {
  const json = process.argv.includes("--json");
  const allowlist = loadAllowlist();
  const hits = [];
  for (const root of SCAN_ROOTS) {
    for (const file of listFiles(resolve(repoRoot, root))) {
      const relativePath = relative(repoRoot, file);
      hits.push(...scanSource(relativePath, readFileSync(file, "utf8")));
    }
  }

  const unclassified = hits.filter((hit) => !allowlist.has(keyOf(hit.file, hit.function)));
  const staleAllowlist = [...allowlist.keys()].filter(
    (key) => !hits.some((hit) => keyOf(hit.file, hit.function) === key),
  );

  if (json) {
    process.stdout.write(`${JSON.stringify({ hits, unclassified, staleAllowlist }, null, 2)}\n`);
    return;
  }

  for (const hit of unclassified) {
    process.stderr.write(
      `${hit.file}:${hit.line} (${hit.function}): sets ${hit.variables.join(", ")} process-wide.\n` +
        `  Sibling tests in the same binary read this without a lock. State the home through an\n` +
        `  explicit seam instead, or add {"file": "${hit.file}", "function": "${hit.function}",\n` +
        `  "reason": "..."} to scripts/test-runtime-env-allowlist.json.\n`,
    );
  }
  for (const key of staleAllowlist) {
    process.stderr.write(
      `${key}: allowlisted for runtime env mutation but no longer mutates one. Remove the entry.\n`,
    );
  }
  if (unclassified.length > 0 || staleAllowlist.length > 0) process.exit(1);
  process.stdout.write(
    `test runtime env: ${hits.length} mutations, ${allowlist.size} classified\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
