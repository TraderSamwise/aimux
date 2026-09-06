#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const AGENT_DISPLAY_URL = new URL("app/lib/agent-display.ts", ROOT);
const STATUS_TONE_URL = new URL("app/lib/status-tone.ts", ROOT);
const FIXTURE_PATH = new URL("testdata/contracts/v1/agent-display/labels.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function transpile(url) {
  const source = await readFile(url, "utf8");
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: url.pathname,
  }).outputText;
}

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

const statusToneModuleUrl = moduleUrl(await transpile(STATUS_TONE_URL));
const agentDisplaySource = (await transpile(AGENT_DISPLAY_URL)).replace(
  /from ["']@\/lib\/status-tone["'];/g,
  `from "${statusToneModuleUrl}";`,
);
const {
  agentCompactIdentity,
  agentRoleLabel,
  agentShortName,
  agentToolName,
  isGeneratedAgentLabel,
} = await import(moduleUrl(agentDisplaySource));

function run(input) {
  if (input.api === "agentToolName") return agentToolName(input.agent);
  if (input.api === "isGeneratedAgentLabel") return isGeneratedAgentLabel(input.label, input.agent);
  if (input.api === "agentShortName") return agentShortName(input.agent);
  if (input.api === "agentRoleLabel") return agentRoleLabel(input.agent);
  if (input.api === "agentCompactIdentity") return agentCompactIdentity(input.agent);
  throw new Error(`unknown api ${input.api}`);
}

const generatedCodex = {
  id: "codex-o6o4kf",
  label: "codex-o6o4kf",
  command: "codex --model gpt-5.5",
  role: "coder",
};
const customClaude = {
  id: "claude-k9czzb",
  label: "overseer",
  command: "claude",
  role: "reviewer",
};

const inputs = [
  { name: "uses command token as generated-label tool name", api: "agentToolName", agent: generatedCodex },
  { name: "detects labels matching the generated id", api: "isGeneratedAgentLabel", label: "codex-o6o4kf", agent: generatedCodex },
  { name: "collapses generated session labels to the tool name", api: "agentShortName", agent: generatedCodex },
  { name: "adds role to compact generated identity", api: "agentCompactIdentity", agent: generatedCodex },
  { name: "keeps custom labels", api: "agentShortName", agent: customClaude },
  { name: "keeps custom compact identity roles", api: "agentCompactIdentity", agent: customClaude },
  { name: "does not collapse custom labels with tool prefixes", api: "agentShortName", agent: { id: "codex-o6o4kf", label: "codex-reviewer", command: "codex --model gpt-5.5" } },
  { name: "falls back to command when label is missing", api: "agentShortName", agent: { id: "claude-k9czzb", command: "claude" } },
  { name: "falls back to generated id when command is missing", api: "agentShortName", agent: { id: "aider-abc123" } },
  { name: "trims role labels", api: "agentRoleLabel", agent: { role: " coder " } },
  { name: "uses tool config before command", api: "agentToolName", agent: { toolConfigKey: "codex", command: "claude", label: "claude-k9czzb" } },
  { name: "falls back to generic agent name", api: "agentToolName", agent: { label: "" } },
  { name: "requires generated label digits", api: "isGeneratedAgentLabel", label: "codex-reviewer", agent: { id: "codex-o6o4kf", command: "codex" } },
];

const cases = inputs.map((input, index) => ({
  id: `agent-display-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "app/lib/agent-display.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "app/lib/agent-display.test.ts",
  generatedBy: "scripts/capture-agent-display-contract.mjs",
  description:
    "App agent generated-label detection, tool-name fallback, role-label trimming, short-name, and compact-identity behavior captured by running TypeScript agent-display helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
