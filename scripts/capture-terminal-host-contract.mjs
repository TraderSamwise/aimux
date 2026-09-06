#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/terminal/host.json", ROOT);

const { TerminalHost } = await import(new URL("dist/terminal-host.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function captureWrites(action) {
  const originalWrite = process.stdout.write;
  const writes = [];
  process.stdout.write = function write(chunk, ...args) {
    writes.push(String(chunk));
    const callback = args.find((arg) => typeof arg === "function");
    callback?.();
    return true;
  };
  try {
    action();
  } finally {
    process.stdout.write = originalWrite;
  }
  return {
    writes,
    joined: writes.join(""),
    containsFocusEnable: writes.join("").includes("\x1b[?1004h"),
    containsFocusDisable: writes.join("").includes("\x1b[?1004l"),
  };
}

const scenarios = [
  {
    name: "does not enable terminal focus reporting globally when entering raw mode",
    op: "enterRawMode",
  },
  {
    name: "disables terminal focus reporting during restore as defensive cleanup",
    op: "restoreTerminalState",
  },
];

const cases = scenarios.map((scenario, index) => {
  const input = { op: scenario.op };
  const output = captureWrites(() => {
    const host = new TerminalHost();
    if (scenario.op === "enterRawMode") host.enterRawMode();
    else if (scenario.op === "restoreTerminalState") host.restoreTerminalState();
    else throw new Error(`unknown op ${scenario.op}`);
  });
  return {
    id: `terminal-host-${String(index + 1).padStart(3, "0")}`,
    name: scenario.name,
    source: "src/terminal-host.test.ts",
    sourceName: scenario.name,
    api: "TerminalHost",
    input,
    output,
    inputSha256: hash(input),
  };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/terminal-host.test.ts",
  generatedBy: "scripts/capture-terminal-host-contract.mjs",
  description:
    "TerminalHost raw-mode and restore escape-sequence behavior captured by running the TypeScript TerminalHost implementation with stdout write recording.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
