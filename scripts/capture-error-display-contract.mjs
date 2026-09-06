#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/error-display/display.json", ROOT);

const { userFacingErrorLines, userFacingErrorMessage } = await import(new URL("dist/error-display.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const inputs = [
  {
    name: "collapses raw tmux command failures before dashboard display",
    error: "Command failed: tmux new-window env -i OPENAI_API_KEY=sk-real SECRET_TOKEN=abc",
  },
  {
    name: "redacts sensitive assignments in ordinary messages",
    error: "failed TOKEN=abc ok=1",
  },
  {
    name: "trims blank multiline errors and caps at six lines",
    error: "\n one \n\n two\n three\n four\n five\n six\n seven\n",
  },
  {
    name: "redacts quoted sensitive assignments",
    error: "AUTH_KEY=\"abc 123\" password='secret' visible=yes",
  },
  {
    name: "truncates very long lines",
    error: `prefix ${"x".repeat(260)}`,
  },
  {
    name: "falls back for empty messages",
    error: "   \n\t",
  },
];

const cases = inputs.map((input, index) => {
  const error = new Error(input.error);
  const payload = { error: input.error };
  return {
    id: `error-display-${String(index + 1).padStart(3, "0")}`,
    name: input.name,
    source: "src/error-display.test.ts",
    api: "userFacingErrorDisplay",
    input: payload,
    output: {
      lines: userFacingErrorLines(error),
      message: userFacingErrorMessage(error),
    },
    inputSha256: hash(payload),
  };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/error-display.test.ts",
  generatedBy: "scripts/capture-error-display-contract.mjs",
  description:
    "User-facing error redaction, tmux failure collapsing, multiline filtering, line-count caps, and truncation captured by running TypeScript error-display helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
