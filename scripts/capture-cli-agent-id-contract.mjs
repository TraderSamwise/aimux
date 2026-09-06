#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/cli/agent-id.json", ROOT);
const {
  buildAgentIdentityErrorPayload,
  buildAgentIdentityPayload,
  renderAgentIdentityLines,
} = await import(new URL("dist/cli/agent-id.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function run(input) {
  switch (input.api) {
    case "buildAgentIdentityPayload":
      return buildAgentIdentityPayload(input.projectRoot, input.identity);
    case "renderAgentIdentityLines":
      return renderAgentIdentityLines(input.payload);
    case "buildAgentIdentityErrorPayload":
      return buildAgentIdentityErrorPayload(input.projectRoot, input.identity);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const inputs = [
  {
    name: "builds the JSON payload for a resolved agent identity",
    api: "buildAgentIdentityPayload",
    projectRoot: "/repo",
    identity: {
      ok: true,
      sessionId: "claude-abc123",
      backendSessionId: "native-session",
      source: "topology",
      tool: "claude",
      toolConfigKey: "claude",
      command: "claude",
      status: "graveyard",
      worktreePath: "/repo/.aimux/worktrees/feature",
    },
  },
  {
    name: "renders stable human-readable identity lines",
    api: "renderAgentIdentityLines",
    payload: {
      ok: true,
      projectRoot: "/repo",
      canonical: "codex",
      aimuxId: "codex-abc123",
      backendSessionId: "native-session",
      source: "discovered",
      status: "offline",
      worktreePath: "/repo",
    },
  },
  {
    name: "builds the JSON payload for a failed identity lookup",
    api: "buildAgentIdentityErrorPayload",
    projectRoot: "/repo",
    identity: {
      ok: false,
      sessionId: "missing",
      reason: 'Agent "missing" is not managed in runtime topology',
    },
  },
];

const cases = inputs.map((input, index) => ({
  id: `cli-agent-id-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/cli/agent-id.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/cli/agent-id.test.ts",
  generatedBy: "scripts/capture-cli-agent-id-contract.mjs",
  description:
    "CLI agent identity JSON payload and human-readable line rendering captured by running TypeScript cli/agent-id helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
