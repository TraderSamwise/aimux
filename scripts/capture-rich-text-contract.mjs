#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/terminal/rich-text.json", ROOT);
const ESC = "\x1b[";

const { parseSgrRichTextLines, richTextLineText, richTextText } = await import(new URL("dist/rich-text.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const scenarios = [
  {
    name: "splits text into structured runs without raw escapes",
    input: `plain ${ESC}1mbold${ESC}0m tail`,
  },
  {
    name: "projects truecolor escapes into rgb colors",
    input: `${ESC}38;2;215;119;87mwarm`,
  },
  {
    name: "projects 256-color escapes into rgb colors",
    input: `${ESC}38;5;244mgray`,
  },
  {
    name: "carries attributes across lines until reset",
    input: `${ESC}31mred\nstill red${ESC}0m\nplain`,
  },
  {
    name: "keeps marks and inverse colors structured",
    input: `${ESC}1;3;4;38;2;255;0;0m${ESC}48;2;0;0;255m${ESC}7mflip`,
  },
  {
    name: "recovers plain text from parsed lines",
    input: `${ESC}1m● ${ESC}0mBash(${ESC}38;5;244mls${ESC}0m)`,
  },
];

const cases = scenarios.map((scenario, index) => {
  const input = { text: scenario.input };
  const lines = parseSgrRichTextLines(scenario.input);
  return {
    id: `terminal-rich-text-${String(index + 1).padStart(3, "0")}`,
    name: scenario.name,
    source: "src/rich-text.test.ts",
    sourceName: scenario.name,
    api: "parseSgrRichTextLines/richTextLineText/richTextText",
    input,
    output: {
      lines,
      lineTexts: lines.map(richTextLineText),
      text: richTextText(lines),
    },
    inputSha256: hash(input),
  };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/rich-text.test.ts",
  generatedBy: "scripts/capture-rich-text-contract.mjs",
  description:
    "SGR rich-text spans, RGB color projection, multiline attribute carryover, inverse colors, and plain-text recovery captured by running TypeScript rich-text helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
