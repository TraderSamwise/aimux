#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/terminal/key-parser.json", ROOT);

const { parseKeys } = await import(new URL("dist/key-parser.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const inputs = [
  {
    name: "normalizes carriage return to enter",
    sourceName: "normalizes carriage return and line feed to enter",
    raw: "\r",
  },
  {
    name: "normalizes line feed to enter",
    sourceName: "normalizes carriage return and line feed to enter",
    raw: "\n",
  },
  {
    name: "normalizes alt carriage return to alt+enter",
    sourceName: "normalizes alt carriage return and alt line feed to alt+enter",
    raw: "\x1b\r",
  },
  {
    name: "normalizes alt line feed to alt+enter",
    sourceName: "normalizes alt carriage return and alt line feed to alt+enter",
    raw: "\x1b\n",
  },
  {
    name: "keeps focus reports and following keys as separate events",
    sourceName: "keeps focus reports and following keys as separate events",
    raw: "\x1b[I\r",
  },
];

const cases = inputs.map((input, index) => {
  const caseInput = { raw: input.raw };
  return {
    id: `terminal-key-parser-${String(index + 1).padStart(3, "0")}`,
    name: input.name,
    source: "src/key-parser.test.ts",
    sourceName: input.sourceName,
    api: "parseKeys",
    input: caseInput,
    output: parseKeys(input.raw),
    inputSha256: hash(caseInput),
  };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/key-parser.test.ts",
  generatedBy: "scripts/capture-key-parser-contract.mjs",
  description:
    "Terminal key parser enter, alt-enter, and focus-report splitting behavior captured by running TypeScript parseKeys.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
