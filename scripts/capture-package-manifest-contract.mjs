#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/release/package-manifest.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const packageJson = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));

const input = {
  sourcePath: "package.json",
  requiredFiles: [
    "bin",
    "dist-ui",
    "docs",
    "scripts/tmux-control.sh",
    "scripts/tmux-open-hyperlink.sh",
    "scripts/tmux-statusline.sh",
    "native/darwin-arm64",
    "native/darwin-x64",
  ],
  forbiddenFiles: ["dist", "scripts/installed-aimux-shim.sh"],
};

const output = {
  files: packageJson.files ?? null,
  required: input.requiredFiles.map((entry) => ({ entry, present: packageJson.files?.includes(entry) === true })),
  forbidden: input.forbiddenFiles.map((entry) => ({ entry, present: packageJson.files?.includes(entry) === true })),
};

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/package-manifest.test.ts",
  generatedBy: "scripts/capture-package-manifest-contract.mjs",
  description:
    "Package manifest runtime file allowlist and retired Node payload exclusions captured by evaluating the TypeScript package-manifest contract against package.json.",
  cases: [
    {
      id: "release-package-manifest-001",
      name: "ships runtime scripts required by installed npm binaries",
      source: "src/package-manifest.test.ts",
      sourceName: "ships runtime scripts required by installed npm binaries",
      api: "package.json files contract",
      input,
      output,
      inputSha256: hash(input),
    },
  ],
});

console.log(`${FIXTURE_PATH.pathname}: 1 cases`);
