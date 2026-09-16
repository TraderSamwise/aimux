#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function fail(message) {
  console.error(`release provenance verification failed: ${message}`);
  process.exit(1);
}

const [releaseDirRaw, asset, platformArch, expectedVariant] = process.argv.slice(2);
if (!releaseDirRaw || !asset || !platformArch || !expectedVariant) {
  fail("usage: scripts/verify-release-provenance.mjs <release-dir> <asset> <platform-arch> <full|lite>");
}
if (!["full", "lite"].includes(expectedVariant)) fail(`invalid expected variant: ${expectedVariant}`);

const releaseDir = resolve(releaseDirRaw);
const assetPath = join(releaseDir, asset);
const shaPath = join(releaseDir, `${asset}.sha256`);
const provenancePath = join(releaseDir, `${asset}.provenance.json`);
const sbomPath = join(releaseDir, `${asset}.sbom.spdx.json`);

for (const [label, path] of [
  ["asset", assetPath],
  ["checksum", shaPath],
  ["provenance", provenancePath],
  ["SBOM", sbomPath],
]) {
  if (!existsSync(path)) fail(`${label} file is missing for ${asset}: ${path}`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} JSON is invalid for ${asset}: ${error.message}`);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const checksumLine = readFileSync(shaPath, "utf8").trim();
const [expectedSha, namedAsset] = checksumLine.split(/\s+/, 2);
if (!/^[0-9a-f]{64}$/i.test(expectedSha || "")) {
  fail(`checksum file does not contain a sha256 digest for ${asset}: ${shaPath}`);
}
if (namedAsset !== asset) {
  fail(`checksum file names ${namedAsset || "(nothing)"} but expected ${asset}: ${shaPath}`);
}
const actualSha = sha256(assetPath);
if (actualSha !== expectedSha) {
  fail(`checksum mismatch for ${asset}: expected ${expectedSha}, got ${actualSha}`);
}

const provenance = readJson(provenancePath, "provenance");
if (provenance.schemaVersion !== "https://aimux.app/schemas/release-provenance.v1.json") {
  fail(`provenance schema mismatch for ${asset}`);
}
if (provenance.package !== "aimux") fail(`provenance package mismatch for ${asset}`);
if (provenance.artifact?.name !== asset) {
  fail(`provenance artifact name mismatch for ${asset}: ${provenance.artifact?.name ?? "(missing)"}`);
}
if (provenance.artifact?.sha256 !== actualSha) {
  fail(`provenance sha256 mismatch for ${asset}: expected ${actualSha}, got ${provenance.artifact?.sha256 ?? "(missing)"}`);
}
if (provenance.artifact?.buildVariant !== expectedVariant || provenance.build?.variant !== expectedVariant) {
  fail(`provenance variant mismatch for ${asset}: expected ${expectedVariant}`);
}
if (provenance.artifact?.platformArch !== platformArch || provenance.build?.platformArch !== platformArch) {
  fail(`provenance platform-arch mismatch for ${asset}: expected ${platformArch}`);
}
if (!/^[0-9a-f]{40}$/i.test(provenance.source?.revision || "")) {
  fail(`provenance source revision is missing or not a git sha for ${asset}`);
}
for (const [name, value] of Object.entries(provenance.gates || {})) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`provenance gate ${name} is missing for ${asset}`);
  }
}

const sbom = readJson(sbomPath, "SBOM");
if (sbom.spdxVersion !== "SPDX-2.3") fail(`SBOM spdxVersion mismatch for ${asset}`);
if (typeof sbom.name !== "string" || !sbom.name.includes(asset)) fail(`SBOM name does not identify ${asset}`);
if (!Array.isArray(sbom.packages) || sbom.packages.length === 0) fail(`SBOM has no packages for ${asset}`);
if (!Array.isArray(sbom.documentDescribes) || sbom.documentDescribes.length === 0) {
  fail(`SBOM documentDescribes is empty for ${asset}`);
}

console.log(`release provenance verified for ${asset}`);
