#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/terminal/hotkeys.json", ROOT);

const { HotkeyHandler } = await import(new URL("dist/hotkeys.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function capture(input) {
  const originalWrite = process.stdout.write;
  const originalColumns = process.stdout.columns;
  const writes = [];
  const actions = [];
  const returns = [];
  process.stdout.columns = input.columns;
  process.stdout.write = function write(chunk, ...args) {
    writes.push(String(chunk));
    const callback = args.find((arg) => typeof arg === "function");
    callback?.();
    return true;
  };
  try {
    const hotkeys = new HotkeyHandler((action) => actions.push(action));
    for (const chunk of input.chunks) {
      returns.push(hotkeys.feed(Buffer.from(chunk, "utf8")));
    }
    hotkeys.destroy();
  } finally {
    process.stdout.write = originalWrite;
    process.stdout.columns = originalColumns;
  }
  return { returns, actions, writes };
}

const scenarios = [
  {
    name: "maps leader shift-p to the work outline action",
    chunks: ["\x01", "P"],
  },
  {
    name: "keeps leader lowercase-p mapped to previous session",
    chunks: ["\x01", "p"],
  },
];

const cases = scenarios.map((scenario, index) => {
  const input = { chunks: scenario.chunks, columns: 80 };
  return {
    id: `terminal-hotkeys-${String(index + 1).padStart(3, "0")}`,
    name: scenario.name,
    source: "src/hotkeys.test.ts",
    sourceName: scenario.name,
    api: "HotkeyHandler.feed",
    input,
    output: capture(input),
    inputSha256: hash(input),
  };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/hotkeys.test.ts",
  generatedBy: "scripts/capture-hotkeys-contract.mjs",
  description:
    "Leader-key action mapping and indicator writes captured by running TypeScript HotkeyHandler with stdout write recording.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
