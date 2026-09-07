#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-model-process-info.json", ROOT);
const { readTmuxProcessInfo } = await import(new URL("dist/multiplexer/dashboard-model.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value) {
  return JSON.parse(JSON.stringify(value));
}

function runCase(input) {
  const calls = [];
  const host = {
    tmuxRuntimeManager: {
      displayMessage(format, windowId) {
        calls.push({ method: "displayMessage", args: [format, windowId] });
        return input.displayMessage;
      },
      captureTarget(target, opts) {
        calls.push({ method: "captureTarget", args: [clone(target), clone(opts)] });
        if (input.captureThrows) throw new Error(input.captureThrows);
        return input.captureOutput;
      },
    },
  };
  return {
    result: normalize(readTmuxProcessInfo(host, clone(input.target))),
    calls,
  };
}

const inputs = [
  {
    name: "parses pane command pid and last nonblank preview line",
    input: {
      target: { windowId: "@7" },
      displayMessage: " node \t 12345 ",
      captureOutput: "first line\n\n  running server  \n",
    },
  },
  {
    name: "omits empty command and nonnumeric pid when capture is empty",
    input: {
      target: { windowId: "@8" },
      displayMessage: "   \t not-a-pid ",
      captureOutput: "\n  \n",
    },
  },
  {
    name: "keeps command when pid is absent and ignores capture failures",
    input: {
      target: { windowId: "@9" },
      displayMessage: "python\t",
      captureThrows: "pane gone",
    },
  },
];

const cases = inputs.map((entry, index) => ({
  id: `dashboard-model-process-info-${String(index + 1).padStart(3, "0")}`,
  name: entry.name,
  source: "src/multiplexer/dashboard-model.ts",
  api: "readTmuxProcessInfo",
  input: entry.input,
  output: runCase(entry.input),
  inputSha256: hash(entry.input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-model.ts",
  generatedBy: "scripts/capture-dashboard-model-process-info-contract.mjs",
  description: "Dashboard tmux process command, pid, and preview-line parsing captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
