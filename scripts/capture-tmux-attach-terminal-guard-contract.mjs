#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/attach-terminal-guard.json", ROOT);
const { TmuxRuntimeManager, hasInteractiveTerminal } = await import(new URL("dist/tmux/runtime-manager.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function record(id, name, input, output) {
  return {
    id,
    name,
    source: "src/tmux/attach-terminal-guard.test.ts",
    input,
    output,
    inputSha256: hash(input),
  };
}

function withProcessTty(isTTY, run) {
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
  try {
    return run();
  } finally {
    if (stdin) Object.defineProperty(process.stdin, "isTTY", stdin);
    if (stdout) Object.defineProperty(process.stdout, "isTTY", stdout);
  }
}

function runAttach(isTTY, sessionName, windowIndex) {
  const interactiveCalls = [];
  const manager = new TmuxRuntimeManager(() => "", (args) => {
    interactiveCalls.push(args);
    return "";
  });
  return withProcessTty(isTTY, () => {
    try {
      manager.attachSession(sessionName, windowIndex);
      return { thrown: null, interactiveCalls };
    } catch (error) {
      return { thrown: String(error?.message ?? error), interactiveCalls };
    }
  });
}

const ttyMatrix = [
  { stdin: true, stdout: true },
  { stdin: true, stdout: false },
  { stdin: false, stdout: true },
  {},
];

const cases = [
  record("tmux-attach-terminal-guard-001", "requires both stdin and stdout to be a terminal", { api: "hasInteractiveTerminal", matrix: ttyMatrix }, {
    results: ttyMatrix.map((entry) =>
      hasInteractiveTerminal({
        stdin: entry.stdin === undefined ? undefined : { isTTY: entry.stdin },
        stdout: entry.stdout === undefined ? undefined : { isTTY: entry.stdout },
      }),
    ),
  }),
  record(
    "tmux-attach-terminal-guard-002",
    "refuses to attach with no terminal, naming the command to run by hand",
    { api: "attachSession", isTTY: false, sessionName: "aimux-proj", windowIndex: 0 },
    runAttach(false, "aimux-proj", 0),
  ),
  record(
    "tmux-attach-terminal-guard-003",
    "attaches normally when a terminal is present",
    { api: "attachSession", isTTY: true, sessionName: "aimux-proj", windowIndex: 2 },
    runAttach(true, "aimux-proj", 2),
  ),
];

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-attach-terminal-guard-contract.mjs",
  source: "src/tmux/attach-terminal-guard.test.ts",
  sources: ["src/tmux/attach-terminal-guard.test.ts", "src/tmux/runtime-manager.ts"],
  description: "tmux interactive-terminal checks and attach-session argv/error behavior captured by running TypeScript runtime-manager helpers.",
  caseCount: cases.length,
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
