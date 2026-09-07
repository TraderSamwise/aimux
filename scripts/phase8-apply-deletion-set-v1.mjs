#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DELETION_SET = join(ROOT, "docs/rust-translation/phase8-deletion-set-v3.md");
const EXPECTED_SRC_COUNT = 527;
const EXPECTED_SUPPORT_COUNT = 276;
const VALID_ARGS = new Set(["--src", "--support", "--all", "--apply", "--list"]);

const args = process.argv.slice(2);
for (const arg of args) {
  if (!VALID_ARGS.has(arg)) {
    usage(`unknown argument: ${arg}`);
  }
}

const argSet = new Set(args);
const explicitSubset =
  argSet.has("--src") || argSet.has("--support") || argSet.has("--all");
const includeSrc = argSet.has("--all") || argSet.has("--src") || !explicitSubset;
const includeSupport =
  argSet.has("--all") || argSet.has("--support") || !explicitSubset;
const apply = argSet.has("--apply");
const list = argSet.has("--list");

function usage(reason) {
  if (reason) console.error(reason);
  console.error(
    [
      "usage: node scripts/phase8-apply-deletion-set-v1.mjs [--src|--support|--all] [--apply] [--list]",
      "",
      "Defaults to a dry-run over both deletion sets. --apply is required to remove files.",
    ].join("\n"),
  );
  process.exit(2);
}

function srcDeletionPaths() {
  const text = readFileSync(DELETION_SET, "utf8");
  const paths = [];
  let inDelete = false;

  for (const line of text.split("\n")) {
    if (line.trim() === "## DELETE") {
      inDelete = true;
      continue;
    }
    if (inDelete && line.startsWith("## ")) break;
    if (!inDelete || !line.startsWith("| `src/")) continue;

    const path = line.split("`")[1];
    if (!path) continue;
    if (!path.startsWith("src/") || !path.endsWith(".ts")) {
      throw new Error(`unexpected source deletion path: ${path}`);
    }
    paths.push(path);
  }

  return paths;
}

function supportDeletionPaths() {
  const paths = ["scripts/audit-agent-output-parser.mjs"];
  for (const entry of readdirSync(join(ROOT, "scripts"), { withFileTypes: true })) {
    if (entry.isFile() && /^capture-.*[.]mjs$/.test(entry.name)) {
      paths.push(`scripts/${entry.name}`);
    }
  }
  return paths.sort();
}

function validate(label, paths, expectedCount) {
  const deduped = [...new Set(paths)].sort();
  if (deduped.length !== paths.length) {
    throw new Error(`${label} contains duplicate paths`);
  }
  if (deduped.length !== expectedCount) {
    throw new Error(
      `${label} count mismatch: expected ${expectedCount}, got ${deduped.length}`,
    );
  }

  const missing = deduped.filter((path) => !existsSync(join(ROOT, path)));
  const directories = deduped.filter((path) => {
    const absolute = join(ROOT, path);
    return existsSync(absolute) && !statSync(absolute).isFile();
  });
  if (directories.length > 0) {
    throw new Error(`${label} includes non-file paths:\n${directories.join("\n")}`);
  }
  if (apply && missing.length > 0) {
    throw new Error(`${label} missing paths while applying:\n${missing.join("\n")}`);
  }

  return { paths: deduped, missing };
}

function removePaths(paths) {
  for (const path of paths) {
    rmSync(join(ROOT, path), { force: true });
  }
}

const src = includeSrc
  ? validate("src deletion set", srcDeletionPaths(), EXPECTED_SRC_COUNT)
  : null;
const support = includeSupport
  ? validate("support deletion set", supportDeletionPaths(), EXPECTED_SUPPORT_COUNT)
  : null;
const paths = [...(src?.paths ?? []), ...(support?.paths ?? [])].sort();

if (list) {
  for (const path of paths) console.log(path);
}

if (apply) {
  removePaths(paths);
}

console.error(
  JSON.stringify(
    {
      mode: apply ? "applied" : "dry-run",
      root: ROOT,
      src: src && { count: src.paths.length, missing: src.missing.length },
      support: support && {
        count: support.paths.length,
        missing: support.missing.length,
      },
      total: paths.length,
    },
    null,
    2,
  ),
);
