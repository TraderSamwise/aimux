#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function fail(message) {
  console.error(`aimux release provenance generation failed: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) fail(`unknown argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${key}`);
    args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

function requireArg(args, name) {
  const value = args[name];
  if (!value) fail(`missing --${name}`);
  return value;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function cargoMetadata(variant) {
  const args = ["metadata", "--manifest-path", join(repoRoot, "native/Cargo.toml"), "--format-version", "1"];
  if (variant === "lite") args.push("--no-default-features");
  const result = spawnSync("cargo", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(`cargo metadata failed for ${variant} SBOM: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`cargo metadata returned invalid JSON for ${variant} SBOM: ${error.message}`);
  }
}

function spdxId(input) {
  return `SPDXRef-${input.replace(/[^A-Za-z0-9.-]/g, "-")}`;
}

function packageSupplier(pkg) {
  return pkg.authors && pkg.authors.length > 0 ? `Organization: ${pkg.authors.join(", ")}` : "NOASSERTION";
}

function writeSbom(output, metadata, options) {
  const rootMetadataPackage = metadata.packages.find((candidate) => candidate.id === metadata.resolve?.root);
  const packages = metadata.packages.map((pkg) => ({
    name: pkg.name,
    SPDXID: spdxId(`${pkg.name}-${pkg.version}`),
    versionInfo: pkg.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    supplier: packageSupplier(pkg),
    licenseConcluded: "NOASSERTION",
    licenseDeclared: pkg.license || "NOASSERTION",
    copyrightText: "NOASSERTION",
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: `pkg:cargo/${pkg.name}@${pkg.version}`,
      },
    ],
  }));
  const rootPackage = rootMetadataPackage
    ? packages.find((pkg) => pkg.SPDXID === spdxId(`${rootMetadataPackage.name}-${rootMetadataPackage.version}`))
    : undefined;
  const documentDescribes = rootPackage ? [rootPackage.SPDXID] : packages.slice(0, 1).map((pkg) => pkg.SPDXID);
  const sbom = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${options.asset}.sbom`,
    documentNamespace: `https://aimux.app/sbom/${options.sourceRevision}/${options.asset}/${options.assetSha256}`,
    creationInfo: {
      created: options.createdAt,
      creators: ["Tool: scripts/write-release-provenance.mjs"],
    },
    documentDescribes,
    packages,
  };
  writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`);
}

const args = parseArgs(process.argv.slice(2));
const releaseDir = resolve(requireArg(args, "release-dir"));
const asset = requireArg(args, "asset");
const platformArch = requireArg(args, "platform-arch");
const buildVariant = requireArg(args, "variant");
const buildProfile = requireArg(args, "profile");
const version = requireArg(args, "version");
const buildStamp = requireArg(args, "build-stamp");
const sourceRevision = requireArg(args, "source-revision");
const sourceRef = args["source-ref"] || "";

if (!["full", "lite"].includes(buildVariant)) fail(`invalid build variant: ${buildVariant}`);
if (!["full", "local"].includes(buildProfile)) fail(`invalid build profile: ${buildProfile}`);
if (!/^[0-9a-f]{40}$/i.test(sourceRevision)) fail(`source revision must be a 40-character git sha: ${sourceRevision}`);

const assetPath = join(releaseDir, asset);
if (!existsSync(assetPath)) fail(`asset not found: ${assetPath}`);

const assetSha256 = sha256(assetPath);
const createdAt = new Date().toISOString();
const provenancePath = join(releaseDir, `${asset}.provenance.json`);
const sbomPath = join(releaseDir, `${asset}.sbom.spdx.json`);

const provenance = {
  schemaVersion: "https://aimux.app/schemas/release-provenance.v1.json",
  package: "aimux",
  version,
  source: {
    repository: "https://github.com/TraderSamwise/aimux",
    revision: sourceRevision,
    ref: sourceRef,
  },
  build: {
    profile: buildProfile,
    variant: buildVariant,
    platformArch,
    buildStamp,
  },
  artifact: {
    name: basename(asset),
    sha256: assetSha256,
    buildProfile,
    buildVariant,
    platformArch,
  },
  gates: {
    assetSet: "scripts/verify-release-asset-set.sh",
    boundary: `scripts/check-lite-build-boundary.sh --variant ${buildVariant} --archive release/${asset} --platform-arch ${platformArch}`,
    attestation: `gh attestation verify ${asset} --repo TraderSamwise/aimux`,
  },
  generatedAt: createdAt,
};

writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
writeSbom(sbomPath, cargoMetadata(buildVariant), {
  asset,
  assetSha256,
  sourceRevision,
  createdAt,
});

console.log(`Wrote ${provenancePath}`);
console.log(`Wrote ${sbomPath}`);
