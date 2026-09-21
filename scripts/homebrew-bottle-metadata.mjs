#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

function usage() {
  return `Usage: scripts/homebrew-bottle-metadata.mjs --formula NAME --output FILE bottle.json [...]

Extracts Homebrew bottle JSON into TSV rows:
  tag<TAB>cellar<TAB>sha256<TAB>filename<TAB>local_filename<TAB>formula
`;
}

function fail(message) {
  console.error(`aimux Homebrew bottle metadata failed: ${message}`);
  process.exit(1);
}

let formula = "";
let output = "";
const inputs = [];
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (arg === "--formula") {
    formula = process.argv[++index] ?? "";
    continue;
  }
  if (arg === "--output") {
    output = process.argv[++index] ?? "";
    continue;
  }
  if (arg.startsWith("-")) {
    fail(`unexpected argument: ${arg}`);
  }
  inputs.push(arg);
}

if (!formula) fail("missing --formula");
if (!output) fail("missing --output");
if (inputs.length === 0) fail("missing bottle JSON input");

const rows = [];
for (const input of inputs) {
  const data = JSON.parse(readFileSync(input, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail(`${input} does not contain a Homebrew bottle metadata object`);
  }
  for (const [fullName, entry] of Object.entries(data)) {
    if (entry?.formula?.name !== formula) {
      continue;
    }
    const bottle = entry.bottle;
    if (!bottle || typeof bottle !== "object" || Array.isArray(bottle)) {
      fail(`${input} entry ${fullName} does not contain a bottle object`);
    }
    const cellar = String(bottle.cellar ?? "");
    if (!cellar) fail(`${input} entry ${fullName} is missing bottle.cellar`);
    const tags = bottle.tags;
    if (!tags || typeof tags !== "object" || Array.isArray(tags)) {
      fail(`${input} entry ${fullName} is missing bottle tags`);
    }
    for (const [tag, spec] of Object.entries(tags)) {
      const sha = String(spec?.sha256 ?? "");
      const filename = String(spec?.filename ?? "");
      const localFilename = String(spec?.local_filename ?? "");
      if (!/^[A-Za-z0-9_]+$/.test(tag)) fail(`invalid bottle tag in ${input}: ${tag}`);
      if (!/^[a-fA-F0-9]{64}$/.test(sha)) fail(`invalid sha256 for ${formula} ${tag} in ${input}: ${sha}`);
      if (!filename || !localFilename) fail(`${input} entry ${fullName} is missing bottle filename for ${tag}`);
      rows.push([tag, cellar, sha.toLowerCase(), filename, localFilename, formula]);
    }
  }
}

if (rows.length === 0) {
  fail(`no bottle metadata for ${formula}`);
}

rows.sort((a, b) => a[0].localeCompare(b[0]));
writeFileSync(output, `${rows.map((row) => row.join("\t")).join("\n")}\n`);
