#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/tool-output-watchers.json", ROOT);
const watchers = await import(new URL("dist/tool-output-watchers.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const inputs = [
  {
    name: "detects Codex prompt panes as needs-input signals",
    source: "src/tool-output-watchers.test.ts",
    api: "classifyToolPane",
    tool: "codex",
    text: ["Some output", "", "› Find and fix a bug in @filename"].join("\n"),
  },
  {
    name: "detects Claude prompt panes",
    source: "src/tool-output-watchers.test.ts",
    api: "classifyToolPane",
    tool: "claude",
    text: ["sam@MacBook-Pro-4 ~/repo main", "bypass permissions on (shift+tab to cycle)", "❯ "].join("\n"),
  },
  {
    name: "detects interrupted/error panes",
    source: "src/tool-output-watchers.test.ts",
    api: "classifyToolPane",
    tool: "codex",
    text: ["Conversation interrupted - tell the model what to do differently.", "Something went wrong."].join("\n"),
  },
  {
    name: "keeps an interrupted prompt visible through a stale trailing working status line",
    source: "src/tool-output-watchers.test.ts",
    api: "classifyToolPane",
    tool: "claude",
    text: ["Interrupted · What should Claude do instead?", "• Working (12s · esc to interrupt)"].join("\n"),
  },
  {
    name: "detects Codex update prompts",
    source: "src/tool-output-watchers.test.ts",
    api: "classifyToolPane",
    tool: "codex",
    text: [
      "Update available! 0.121.0 -> 0.122.0",
      "Run npm install -g @openai/codex to update.",
      "See full release notes:",
    ].join("\n"),
  },
  {
    name: "detects Claude update prompts",
    source: "src/tool-output-watchers.test.ts",
    api: "classifyToolPane",
    tool: "claude",
    text: ["Claude Code v2.1.116", "Update available.", "Run `claude update` to install."].join("\n"),
  },
  {
    name: "does not keep stale error state once later output exists",
    source: "src/tool-output-watchers.test.ts",
    api: "classifyToolPane",
    tool: "codex",
    text: [
      "Conversation interrupted - tell the model what to do differently.",
      "Something went wrong.",
      "> continue",
      "Working (12s - esc to interrupt)",
    ].join("\n"),
  },
];

const cases = inputs.map((input, index) => ({
  id: `runtime-state-tool-output-watchers-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: input.source,
  api: input.api,
  input,
  output: watchers.classifyToolPane(input.tool, input.text),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["src/tool-output-watchers.test.ts"],
  generatedBy: "scripts/capture-tool-output-watchers-contract.mjs",
  description:
    "Tool pane prompt/error/update classification captured by running TypeScript classifyToolPane over the watcher test scenarios.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
