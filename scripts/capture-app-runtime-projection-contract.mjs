#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/app-runtime/projection.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function source(path) {
  return readFile(new URL(path, ROOT), "utf8");
}

function stripImports(sourceText) {
  return sourceText.replace(/^import .*;\n/gm, "");
}

async function importCombinedTypeScriptModule(paths) {
  const pieces = ["export function firstTokenOf(command) { if (!command) return ''; return command.trim().split(/\\s+/, 1)[0] ?? ''; }"];
  for (const path of paths) {
    pieces.push(stripImports(await source(path)));
  }
  const combined = pieces.join("\n");
  const transpiled = ts.transpileModule(combined, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "app-runtime-projection-contract.ts",
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const runtimeBrand = await importCombinedTypeScriptModule(["app/lib/runtime-brand.ts"]);
const topology = await importCombinedTypeScriptModule([
  "app/lib/agent-display.ts",
  "app/lib/desktop-state.ts",
  "app/lib/openrig-topology.ts",
]);

const desktopState = {
  ok: true,
  mainCheckoutInfo: { name: "aimux", branch: "main" },
  mainCheckoutPath: "/repo/aimux",
  worktrees: [{ name: "feature", path: "/repo/aimux-feature", branch: "feature/native" }],
  sessions: [
    {
      id: "agent-1",
      status: "running",
      command: "codex",
      worktreePath: "/repo/aimux",
      label: "Codex",
    },
    {
      id: "agent-2",
      status: "waiting",
      command: "claude",
      worktreePath: "/repo/aimux-feature",
      pendingAction: "review",
    },
  ],
  services: [
    {
      id: "web",
      status: "offline",
      command: "yarn dev",
      worktreePath: "/repo/aimux-feature",
    },
  ],
};

const inputs = [
  {
    name: "classifies lifecycle statuses into topology health",
    source: "app/lib/openrig-topology.test.ts",
    api: "healthForStatus",
    cases: [
      { status: "running" },
      { status: "waiting" },
      { status: "idle" },
      { status: "offline" },
      { status: "running", pendingAction: "needs approval" },
    ],
  },
  {
    name: "builds a project/worktree/agent/service topology from desktop state",
    source: "app/lib/openrig-topology.test.ts",
    api: "buildProjectTopology",
    project: { name: "aimux", path: "/repo/aimux" },
    state: desktopState,
  },
  {
    name: "recognizes core agent runtimes from commands",
    source: "app/lib/runtime-brand.test.ts",
    api: "runtimeBrandForCommand",
    commands: ["claude --continue", "codex exec", "zsh"],
  },
  {
    name: "falls services back to service identity",
    source: "app/lib/runtime-brand.test.ts",
    api: "runtimeBrandForKind",
    cases: [
      { kind: "service", command: "yarn dev" },
      { kind: "agent" },
    ],
  },
];

function run(input) {
  switch (input.api) {
    case "healthForStatus":
      return input.cases.map((item) => topology.healthForStatus(item.status, item.pendingAction));
    case "buildProjectTopology":
      return topology.buildProjectTopology(input.project, topology.groupByWorktree(input.state), input.state);
    case "runtimeBrandForCommand":
      return input.commands.map((command) => runtimeBrand.runtimeBrandForCommand(command));
    case "runtimeBrandForKind":
      return input.cases.map((item) => runtimeBrand.runtimeBrandForKind(item.kind, item.command));
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const cases = inputs.map((input, index) => ({
  id: `app-runtime-projection-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: input.source,
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["app/lib/openrig-topology.test.ts", "app/lib/runtime-brand.test.ts"],
  generatedBy: "scripts/capture-app-runtime-projection-contract.mjs",
  description:
    "App runtime brand and OpenRig-style topology projection behavior captured by running TypeScript app helper modules.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
