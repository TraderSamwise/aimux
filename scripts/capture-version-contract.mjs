#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/release/version.json", ROOT);

const { readAimuxVersionFromPackageRoot } = await import(new URL("dist/version.js", ROOT));
const { readAimuxBuildProfileFromPackageRoot } = await import(new URL("dist/build-profile.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function makeRoot(files) {
  const root = await mkdtemp(join(tmpdir(), "aimux-version-contract-"));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(root, name), contents);
  }
  return root;
}

async function capture(input) {
  const originalBuildProfile = process.env.AIMUX_BUILD_PROFILE;
  if ("envBuildProfile" in input) {
    if (input.envBuildProfile === null) delete process.env.AIMUX_BUILD_PROFILE;
    else process.env.AIMUX_BUILD_PROFILE = input.envBuildProfile;
  }
  const root = await makeRoot(input.files);
  try {
    if (input.api === "readAimuxVersionFromPackageRoot") return readAimuxVersionFromPackageRoot(root);
    if (input.api === "readAimuxBuildProfileFromPackageRoot") return readAimuxBuildProfileFromPackageRoot(root);
    throw new Error(`unknown api ${input.api}`);
  } finally {
    if (originalBuildProfile === undefined) delete process.env.AIMUX_BUILD_PROFILE;
    else process.env.AIMUX_BUILD_PROFILE = originalBuildProfile;
    await rm(root, { recursive: true, force: true });
  }
}

const scenarios = [
  {
    name: "prefers the installed artifact VERSION label",
    api: "readAimuxVersionFromPackageRoot",
    files: { VERSION: "local-c8abfdc6\n", "package.json": JSON.stringify({ version: "0.1.28" }) },
  },
  {
    name: "falls back to package.json for source checkouts",
    api: "readAimuxVersionFromPackageRoot",
    files: { "package.json": JSON.stringify({ version: "0.1.28" }) },
  },
  {
    name: "falls back to 0.0.0 when no version source is readable",
    api: "readAimuxVersionFromPackageRoot",
    files: {},
  },
  {
    name: "prefers the installed artifact BUILD_PROFILE label",
    api: "readAimuxBuildProfileFromPackageRoot",
    files: { BUILD_PROFILE: "local\n" },
  },
  {
    name: "falls back to full for source checkouts and older installs",
    api: "readAimuxBuildProfileFromPackageRoot",
    envBuildProfile: null,
    files: {},
  },
  {
    name: "ignores unknown artifact labels",
    api: "readAimuxBuildProfileFromPackageRoot",
    files: { BUILD_PROFILE: "enterprise\n" },
  },
];

const cases = [];
for (const [index, scenario] of scenarios.entries()) {
  const { name, ...input } = scenario;
  cases.push({
    id: `release-version-${String(index + 1).padStart(3, "0")}`,
    name,
    source: "src/version.test.ts",
    sourceName: name,
    api: input.api,
    input,
    output: await capture(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/version.test.ts",
  generatedBy: "scripts/capture-version-contract.mjs",
  description:
    "Installed artifact version and build-profile label precedence captured by running TypeScript version/build-profile helpers against temporary package roots.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
