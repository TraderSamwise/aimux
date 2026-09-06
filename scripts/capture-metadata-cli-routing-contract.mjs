#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/metadata-cli/routing.json", ROOT);
const { parseRuntimeMetadataCliArgs } = await import(new URL("dist/metadata-cli-routing.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const inputs = [
  {
    name: "parses endpoint commands",
    args: ["metadata", "endpoint"],
  },
  {
    name: "parses status mutations with option values",
    args: ["metadata", "set-status", "claude-1", "Ready", "--tone=success"],
  },
  {
    name: "parses dash-prefixed status text after an option terminator",
    args: ["metadata", "set-status", "claude-1", "--", "-starting"],
  },
  {
    name: "parses dash-prefixed log messages after an option terminator",
    args: ["metadata", "log", "claude-1", "--", "-message"],
  },
  {
    name: "parses context mutations with nested PR data",
    args: [
      "metadata",
      "set-context",
      "claude-1",
      "--cwd",
      "/repo",
      "--branch",
      "feature",
      "--pr-number",
      "42",
      "--pr-title",
      "Ship it",
    ],
  },
  {
    name: "rejects malformed metadata commands",
    args: ["metadata", "set-status"],
  },
];

const cases = inputs.map((input, index) => ({
  id: `metadata-cli-routing-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/metadata-cli-routing.test.ts",
  api: "parseRuntimeMetadataCliArgs",
  input,
  output: parseRuntimeMetadataCliArgs(input.args),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/metadata-cli-routing.test.ts",
  generatedBy: "scripts/capture-metadata-cli-routing-contract.mjs",
  description:
    "Runtime metadata CLI command parsing, option terminator handling, project-service route mapping, and malformed-command errors captured by running TypeScript parseRuntimeMetadataCliArgs.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
