#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tui/render-text.json", ROOT);
const { composeTwoPane, stripAnsi } = await import(new URL("dist/tui/render/text.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function run(input) {
  switch (input.api) {
    case "composeTwoPane":
      return composeTwoPane(input.left, input.right, input.cols, input.separator);
    case "stripAnsi":
      return stripAnsi(input.text);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const inputs = [
  {
    name: "joins panes with default pipe separator",
    api: "composeTwoPane",
    left: ["left"],
    right: ["right"],
    cols: 80,
  },
  {
    name: "honors custom separator with same visible width",
    api: "composeTwoPane",
    left: ["left"],
    right: ["right"],
    cols: 80,
    separator: "   ",
  },
  {
    name: "keeps output within columns for wider separator",
    api: "composeTwoPane",
    left: ["left"],
    right: ["right"],
    cols: 80,
    separator: "  ||  ",
  },
  {
    name: "strips SGR sequences from composed text",
    api: "stripAnsi",
    text: "\u001b[1;38;5;75mready\u001b[0m",
  },
];

const cases = inputs.map((input, index) => ({
  id: `tui-render-text-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/tui/render/text.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/tui/render/text.test.ts",
  generatedBy: "scripts/capture-tui-render-text-contract.mjs",
  description: "TUI text helper outputs captured by running TypeScript tui/render/text helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
