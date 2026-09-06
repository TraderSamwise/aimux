#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/tool-picker.json", ROOT);
const { defaultsLaunchOverride, formatEnvDefaults } = await import(new URL("dist/multiplexer/tool-picker.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function run(input) {
  switch (input.api) {
    case "formatEnvDefaults":
      return formatEnvDefaults(input.env);
    case "defaultsLaunchOverride":
      return defaultsLaunchOverride({ command: "claude", args: ["--base"], enabled: true, ...input.tool }) ?? null;
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const inputs = [
  {
    name: "formats undefined env defaults as empty",
    api: "formatEnvDefaults",
  },
  {
    name: "renders env defaults and quotes values with spaces",
    api: "formatEnvDefaults",
    env: { A: "1", MSG: "hello world" },
  },
  {
    name: "omits launch override when no defaults are configured",
    api: "defaultsLaunchOverride",
    tool: {},
  },
  {
    name: "omits launch override for empty default args and env",
    api: "defaultsLaunchOverride",
    tool: { defaultArgs: [], defaultEnv: {} },
  },
  {
    name: "appends default args after base args",
    api: "defaultsLaunchOverride",
    tool: { defaultArgs: ["--model", "opus"] },
  },
  {
    name: "carries default env through",
    api: "defaultsLaunchOverride",
    tool: { defaultEnv: { CLAUDE_YOLO: "1" } },
  },
  {
    name: "combines default args and env",
    api: "defaultsLaunchOverride",
    tool: { defaultArgs: ["--model", "opus"], defaultEnv: { FOO: "bar" } },
  },
];

const cases = inputs.map((input, index) => ({
  id: `tool-picker-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/multiplexer/tool-picker.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/tool-picker.test.ts",
  generatedBy: "scripts/capture-tool-picker-contract.mjs",
  description:
    "Tool picker default environment formatting and launch override contracts captured by running TypeScript tool-picker helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
