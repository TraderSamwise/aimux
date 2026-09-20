#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

function usage() {
  return `Usage: scripts/homebrew-bottle-metadata.mjs --formula NAME --output FILE bottle.json [...]

Extracts Homebrew bottle JSON into TSV rows:
  tag<TAB>cellar<TAB>sha256<TAB>filename<TAB>local_filename
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
  if (data?.formula?.name !== formula) {
    continue;
  }
  const bottle = data.bottle;
  if (!bottle || typeof bottle !== "object") {
    fail(`${input} does not contain a bottle object`);
  }
  const cellar = String(bottle.cellar ?? "");
  if (!cellar) fail(`${input} is missing bottle.cellar`);
  const tags = bottle.tags;
  if (!tags || typeof tags !== "object") {
    fail(`${input} is missing bottle tags`);
  }
  for (const [tag, spec] of Object.entries(tags)) {
    const sha = String(spec?.sha256 ?? "");
    const filename = String(spec?.filename ?? "");
    const localFilename = String(spec?.local_filename ?? "");
    if (!/^[A-Za-z0-9_]+$/.test(tag)) fail(`invalid bottle tag in ${input}: ${tag}`);
    if (!/^[a-fA-F0-9]{64}$/.test(sha)) fail(`invalid sha256 for ${formula} ${tag} in ${input}: ${sha}`);
    if (!filename || !localFilename) fail(`${input} is missing bottle filename for ${tag}`);
    rows.push([tag, cellar, sha.toLowerCase(), filename, localFilename]);
  }
}

if (rows.length === 0) {
  fail(`no bottle metadata for ${formula}`);
}

rows.sort((a, b) => a[0].localeCompare(b[0]));
writeFileSync(output, `${rows.map((row) => row.join("\t")).join("\n")}\n`);
