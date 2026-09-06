#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const SOURCE_PATH = "scripts/build-release-asset.sh";
const FIXTURE_PATH = new URL("testdata/contracts/v1/release/asset.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const body = await readFile(new URL(SOURCE_PATH, ROOT), "utf8");

function evaluate(input) {
  return {
    contains: input.contains.map((needle) => ({ needle, present: body.includes(needle) })),
    notContains: input.notContains.map((needle) => ({ needle, present: body.includes(needle) })),
  };
}

const scenarios = [
  {
    name: "builds and packages the platform Rust CLI binary",
    contains: [
      "cargo build --manifest-path native/Cargo.toml -p aimux --release",
      'mkdir -p "$PKG_DIR/native/$PLATFORM-$ARCH"',
      'cp native/target/release/aimux "$PKG_DIR/native/$PLATFORM-$ARCH/aimux"',
      'chmod +x "$PKG_DIR/native/$PLATFORM-$ARCH/aimux"',
    ],
    notContains: [],
  },
  {
    name: "includes the Rust CLI binary in build-stamp coherence",
    contains: [
      'NATIVE_ARTIFACT="$PKG_DIR/native/$PLATFORM-$ARCH/aimux"',
      'BUILD_STAMP="$(artifact_mtime_ms "$NATIVE_ARTIFACT")-$(shasum -a 1 "$NATIVE_ARTIFACT"',
    ],
    notContains: ["PKG_DIR/dist/launcher-bin.js", 'MAIN_ARTIFACT_NAME="main.js"'],
  },
  {
    name: "keeps the release tarball on the native runtime surface",
    contains: [],
    notContains: [
      "tsconfig.local.json",
      "check-local-build-boundary.mjs",
      "yarn install --production",
      "node_modules/node-pty",
      "cp -R bin dist",
      "scripts/installed-aimux-shim.sh",
    ],
  },
];

const cases = scenarios.map((scenario, index) => {
  const input = {
    sourcePath: SOURCE_PATH,
    contains: scenario.contains,
    notContains: scenario.notContains,
  };
  return {
    id: `release-asset-${String(index + 1).padStart(3, "0")}`,
    name: scenario.name,
    source: "src/release-asset-contract.test.ts",
    sourceName: scenario.name,
    api: "build-release-asset.sh static contract",
    input,
    output: evaluate(input),
    inputSha256: hash(input),
  };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/release-asset-contract.test.ts",
  generatedBy: "scripts/capture-release-asset-contract.mjs",
  description:
    "Release asset native-runtime packaging and Node exclusion contract captured by evaluating the TypeScript release-asset Vitest assertions against scripts/build-release-asset.sh.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
