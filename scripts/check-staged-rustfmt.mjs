#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

const rustfmtVersion = run("rustfmt", ["--version"]);
if (rustfmtVersion.status !== 0) {
  console.error("rustfmt is required to check staged Rust files.");
  process.exit(1);
}

const diff = run(
  "git",
  ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z", "--", "*.rs"],
  { encoding: "buffer" },
);

if (diff.status !== 0) {
  process.stderr.write(diff.stderr);
  process.exit(diff.status ?? 1);
}

const files = diff.stdout.toString("utf8").split("\0").filter(Boolean);
if (files.length === 0) {
  process.exit(0);
}

const tempRoot = mkdtempSync(join(tmpdir(), "aimux-staged-rustfmt-"));
let failed = false;

try {
  for (const file of files) {
    const blob = run("git", ["show", `:${file}`], { encoding: "buffer" });
    if (blob.status !== 0) {
      process.stderr.write(blob.stderr);
      failed = true;
      continue;
    }

    const tempFile = join(tempRoot, file);
    mkdirSync(dirname(tempFile), { recursive: true });
    writeFileSync(tempFile, blob.stdout);

    const check = run("rustfmt", ["--edition", "2024", "--check", tempFile]);
    if (check.status !== 0) {
      console.error(`staged Rust file is not rustfmt-clean: ${file}`);
      process.stdout.write(check.stdout);
      process.stderr.write(check.stderr);
      failed = true;
    }
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

if (failed) {
  console.error("Run rustfmt on the staged Rust files before committing.");
  process.exit(1);
}
