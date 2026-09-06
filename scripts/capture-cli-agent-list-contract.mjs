#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/cli/agent-list.json", ROOT);
const { renderAgentsByWorktreeLines, renderAgentsFlatLines } = await import(
  new URL("dist/cli/agent-list.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function run(input) {
  switch (input.api) {
    case "renderAgentsFlatLines":
      return renderAgentsFlatLines(input.agents, input.projectRoot);
    case "renderAgentsByWorktreeLines":
      return renderAgentsByWorktreeLines(input.agents, input.projectRoot);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const agents = [
  {
    id: "codex-2",
    command: "codex",
    tool: "codex",
    toolConfigKey: "codex",
    status: "running",
    worktreePath: "/repo/worktrees/feature",
    activity: "working",
    attention: "ok",
    role: "coder",
    backendSessionId: "backend-2",
    loop: { active: true, goal: "ship" },
  },
  {
    id: "claude-1",
    command: "claude",
    tool: "claude",
    toolConfigKey: "claude",
    status: "idle",
    worktreePath: "/repo",
    task: { description: "Review handoff", status: "pending" },
  },
];

const inputs = [
  {
    name: "renders flat agent summaries with canonical backend state role loop and task fields",
    api: "renderAgentsFlatLines",
    projectRoot: "/repo",
    agents,
  },
  {
    name: "renders worktree grouped summaries with main checkout first",
    api: "renderAgentsByWorktreeLines",
    projectRoot: "/repo",
    agents,
  },
  {
    name: "renders empty inventory explicitly",
    api: "renderAgentsFlatLines",
    agents: [],
  },
  {
    name: "renders empty grouped inventory explicitly",
    api: "renderAgentsByWorktreeLines",
    agents: [],
  },
];

const cases = inputs.map((input, index) => ({
  id: `cli-agent-list-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/cli/agent-list.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/cli/agent-list.test.ts",
  generatedBy: "scripts/capture-cli-agent-list-contract.mjs",
  description:
    "CLI agent-list flat and worktree-grouped renderer outputs captured by running the TypeScript cli/agent-list helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
