#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/worktrees.json", ROOT);
const { worktreeSettlePollDelay } = await import(new URL("dist/multiplexer/worktrees.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const inputs = [
  {
    name: "holds tight cadence for the first attempts",
    api: "worktreeSettlePollDelay",
    calls: [
      { attempt: 1, baseMs: 250 },
      { attempt: 2, baseMs: 250 },
      { attempt: 1, baseMs: 100 },
      { attempt: 2, baseMs: 100 },
    ],
  },
  {
    name: "decays and caps once settlement drags on",
    api: "worktreeSettlePollDelay",
    calls: [
      { attempt: 3, baseMs: 250 },
      { attempt: 4, baseMs: 250 },
      { attempt: 50, baseMs: 250 },
      { attempt: 50, baseMs: 100 },
    ],
  },
  {
    name: "never returns a busy-spin delay",
    api: "worktreeSettlePollDelay",
    calls: Array.from({ length: 40 }, (_, i) => ({ attempt: i + 1, baseMs: 100 })),
  },
  {
    name: "honors caller cap below the shared maximum",
    api: "worktreeSettlePollDelay",
    calls: Array.from({ length: 40 }, (_, i) => ({ attempt: i + 1, baseMs: 100, maxMs: 350 })),
  },
  {
    name: "never caps below the base delay",
    api: "worktreeSettlePollDelay",
    calls: [{ attempt: 40, baseMs: 250, maxMs: 100 }],
  },
];

function run(input) {
  return input.calls.map((call) => ({
    ...call,
    delayMs: worktreeSettlePollDelay(call.attempt, call.baseMs, call.maxMs),
  }));
}

const cases = inputs.map((input, index) => ({
  id: `multiplexer-worktrees-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/multiplexer/worktrees.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/worktrees.test.ts",
  generatedBy: "scripts/capture-multiplexer-worktrees-contract.mjs",
  description:
    "Multiplexer worktree settle-poll delay contracts captured by running TypeScript worktreeSettlePollDelay over the tested attempt ranges.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
