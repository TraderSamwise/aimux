#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/session-runtime-headline.json", ROOT);

const { initPaths, getHistoryDir, getStatusDir } = await import(new URL("dist/paths.js", ROOT));
const { deriveHeadline, readStatusHeadline } = await import(new URL("dist/multiplexer/session-runtime-core.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function withProject(input, runCase) {
  const projectRoot = join(
    tmpdir(),
    `aimux-session-runtime-headline-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  const aimuxHome = join(projectRoot, "home");
  mkdirSync(join(projectRoot, ".aimux"), { recursive: true });
  mkdirSync(aimuxHome, { recursive: true });
  const previousHome = process.env.AIMUX_HOME;
  const previousCwd = process.cwd();
  try {
    process.env.AIMUX_HOME = aimuxHome;
    process.chdir(projectRoot);
    await initPaths(projectRoot);
    if (input.statusFile !== undefined) {
      mkdirSync(getStatusDir(), { recursive: true });
      writeFileSync(join(getStatusDir(), `${input.sessionId}.md`), input.statusFile);
    }
    if (input.historyLines) {
      mkdirSync(getHistoryDir(), { recursive: true });
      writeFileSync(join(getHistoryDir(), `${input.sessionId}.jsonl`), `${input.historyLines.join("\n")}\n`);
    }
    return await runCase();
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

async function runCase(input) {
  return withProject(input, () => ({
    statusHeadline: readStatusHeadline({}, input.sessionId) ?? null,
    derivedHeadline: deriveHeadline({}, input.sessionId) ?? null,
  }));
}

const longStatus = "1234567890".repeat(10);
const inputs = [
  {
    name: "returns null when neither status nor history exists",
    sessionId: "codex-empty",
  },
  {
    name: "reads first trimmed status line before history",
    sessionId: "codex-status",
    statusFile: "  Building project\nsecond line\n",
    historyLines: [JSON.stringify({ type: "prompt", content: "history prompt", ts: "2026-01-01T00:00:00.000Z" })],
  },
  {
    name: "truncates long status headline to eighty characters",
    sessionId: "codex-long-status",
    statusFile: `${longStatus}\n`,
  },
  {
    name: "falls back to the last prompt in recent history",
    sessionId: "codex-history",
    historyLines: [
      JSON.stringify({ type: "prompt", content: "first prompt", ts: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ type: "response", content: "response", ts: "2026-01-01T00:01:00.000Z" }),
      JSON.stringify({ type: "prompt", content: "second prompt", ts: "2026-01-01T00:02:00.000Z" }),
    ],
  },
  {
    name: "skips malformed history lines and truncates prompt headline",
    sessionId: "codex-malformed-history",
    historyLines: [
      "{malformed",
      JSON.stringify({ type: "prompt", content: longStatus, ts: "2026-01-01T00:00:00.000Z" }),
    ],
  },
  {
    name: "empty status file falls back to null history",
    sessionId: "codex-empty-status",
    statusFile: "  \n\n",
  },
];

const cases = [];
for (const [index, input] of inputs.entries()) {
  const capturedInput = clone(input);
  cases.push({
    id: `session-runtime-headline-${String(index + 1).padStart(3, "0")}`,
    name: input.name,
    source: "src/multiplexer/session-runtime-core.ts",
    api: "readStatusHeadline+deriveHeadline",
    input: capturedInput,
    output: await runCase(capturedInput),
    inputSha256: hash(capturedInput),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/session-runtime-core.ts",
  generatedBy: "scripts/capture-session-runtime-headline-contract.mjs",
  description:
    "Session runtime status/headline derivation captured by running TypeScript against temp status and history files.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
