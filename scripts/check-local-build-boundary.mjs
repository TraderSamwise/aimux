#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2] || "dist";
const failures = [];

function walk(dir, visit) {
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

if (!existsSync(root)) {
  console.error(`Local build boundary check failed: missing ${root}`);
  process.exit(1);
}

if (existsSync(join(root, "full"))) {
  failures.push("dist/full is present in the local build");
}

const fullImportPattern = /(?:from\s+["']|import\(\s*["'])(?:\.\.?\/)*full\//;
walk(root, (path) => {
  if (!/\.(?:js|d\.ts)$/.test(path)) return;
  const text = readFileSync(path, "utf8");
  if (fullImportPattern.test(text)) {
    failures.push(`${relative(root, path)} imports src/full output`);
  }
});

if (failures.length > 0) {
  console.error("Local build boundary check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Local build boundary check passed for ${root}`);
