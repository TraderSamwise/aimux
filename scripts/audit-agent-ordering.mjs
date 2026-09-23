#!/usr/bin/env node
// Agents sit in one place on every surface, and the rule that decides it is
// team_contract::compare_agent_canonical_order. This gate finds every sort of
// a collection keyed on an agent-ordering field and requires it to either use
// that comparator or be classified, with a reason, in the allowlist beside it.
//
// The classification is the point. A ban on field names cannot tell an agent
// list from a worktree list, and it cannot see a sort whose comparator is a
// named function -- which is how every agent sort in this repo is written. So
// the gate resolves one level of named comparator and then makes every hit a
// decision somebody wrote down.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const allowlistPath = resolve(repoRoot, "scripts/agent-ordering-allowlist.json");
const CANONICAL_COMPARATOR = "compare_agent_canonical_order";

const SCAN_ROOTS = ["native/crates/aimux/src", "app", "src", "relay/src"];
const SKIP_DIRECTORIES = new Set(["node_modules", "target", ".git", "dist", "build", ".expo"]);
const SCAN_EXTENSIONS = [".rs", ".ts", ".tsx", ".mjs"];

// Fields that only ever decide where an agent sits relative to another agent.
const ORDERING_FIELDS = [
  "createdAt",
  "created_at",
  "lastUsedAt",
  "last_used_at",
  "tmuxWindowIndex",
  "tmux_window_index",
  "windowIndex",
  "window_index",
  "exposeOrder",
  "expose_order",
  "displayOrder",
  "display_order",
  "recentRank",
  "recent_rank",
  "recencyAt",
  "recency_at",
  "attention",
  "team.order",
];

const SORT_CALL = /\.(sort_by_key|sort_by|sort_unstable_by_key|sort_unstable_by|sort_unstable|toSorted|sort)\s*\(/g;

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
    if (SCAN_EXTENSIONS.some((extension) => entry.endsWith(extension))) found.push(full);
  }
  return found;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

// The text a sort actually decides with: the call's own arguments, plus the
// body of any same-file named comparator it hands off to. Without the second
// half, `agents.sort_by(compare_recency_or_created)` looks inert.
function comparatorText(relativePath, source, callIndex) {
  const open = source.indexOf("(", callIndex);
  if (open === -1) return "";
  let depth = 0;
  let close = open;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  const args = source.slice(open + 1, close);
  let text = args;
  for (const name of args.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
    text += `\n${namedFunctionBody(relativePath, source, name[1])}`;
  }
  return text;
}

// Rust writes `fn name`, TypeScript writes `function name` or `const name =`.
// Matching only the first left every TS comparator unresolved, which is the
// same blind spot as not resolving comparators at all -- but applying the TS
// forms to Rust resolves ordinary `let` bindings and drags in unrelated bodies.
function namedFunctionBody(relativePath, source, name) {
  const escaped = name.replace(/\$/g, "\\$");
  const declaration = (
    relativePath.endsWith(".rs")
      ? new RegExp(`\\bfn\\s+${escaped}\\s*[(<]`)
      : new RegExp(`\\bfunction\\s+${escaped}\\s*\\(|\\b(?:const|let)\\s+${escaped}\\s*=`)
  ).exec(source);
  if (!declaration) return "";
  const brace = source.indexOf("{", declaration.index);
  if (brace === -1) return "";
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(brace, index + 1);
    }
  }
  return "";
}

// The nearest declaration above the sort. A whole file is too coarse to exempt:
// the five files that build agent lists all contain a legitimate worktree-group
// or alternate-mode sort, and exempting the file would wave through the next
// agent sort added beside it.
function enclosingFunction(relativePath, source, index) {
  // `let index = ...` above a sort is a binding, not a scope, so Rust looks
  // only for `fn`. TypeScript has no single spelling, hence the second form.
  const declaration = relativePath.endsWith(".rs")
    ? /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g
    : /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)|\b(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\(|function)/g;
  let name = "";
  for (const match of source.slice(0, index).matchAll(declaration)) {
    name = match[1] ?? match[2] ?? name;
  }
  return name;
}

export function scanSource(relativePath, source) {
  const hits = [];
  for (const match of source.matchAll(SORT_CALL)) {
    const decidingText = comparatorText(relativePath, source, match.index + match[0].length - 1);
    const fields = ORDERING_FIELDS.filter((field) => decidingText.includes(field));
    if (fields.length === 0) continue;
    hits.push({
      file: relativePath,
      function: enclosingFunction(relativePath, source, match.index),
      line: lineOf(source, match.index),
      canonical: decidingText.includes(CANONICAL_COMPARATOR),
      fields,
    });
  }
  return hits;
}

const keyOf = (file, functionName) => `${file}#${functionName}`;

function loadAllowlist() {
  const parsed = JSON.parse(readFileSync(allowlistPath, "utf8"));
  const byKey = new Map();
  for (const entry of parsed.entries) {
    if (!entry.reason || entry.reason.trim().length === 0) {
      throw new Error(`agent-ordering allowlist entry for ${entry.file} has no reason`);
    }
    if (!entry.function) {
      throw new Error(
        `agent-ordering allowlist entry for ${entry.file} names no function; a whole file is too coarse to exempt`,
      );
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

  const unclassified = hits.filter(
    (hit) => !hit.canonical && !allowlist.has(keyOf(hit.file, hit.function)),
  );
  const staleAllowlist = [...allowlist.keys()].filter(
    (key) => !hits.some((hit) => !hit.canonical && keyOf(hit.file, hit.function) === key),
  );

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ hits, unclassified, staleAllowlist }, null, 2)}\n`,
    );
    return;
  }

  for (const hit of unclassified) {
    process.stderr.write(
      `${hit.file}:${hit.line} (${hit.function}): sorts on ${hit.fields.join(", ")} without ${CANONICAL_COMPARATOR}.\n` +
        `  Agents sit in one place on every surface. Use the canonical comparator, or add\n` +
        `  {"file": "${hit.file}", "function": "${hit.function}", "reason": "..."} to\n` +
        `  scripts/agent-ordering-allowlist.json saying what it really sorts.\n`,
    );
  }
  for (const key of staleAllowlist) {
    process.stderr.write(
      `${key}: allowlisted for agent ordering but no longer sorts on an ordering field. Remove the entry.\n`,
    );
  }
  if (unclassified.length > 0 || staleAllowlist.length > 0) process.exit(1);
  process.stdout.write(
    `agent ordering: ${hits.length} ordering sorts, ${hits.filter((hit) => hit.canonical).length} canonical, ${allowlist.size} classified\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
