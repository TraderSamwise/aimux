#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/services.json", ROOT);
const { buildServiceStateFromMetadata, getServiceLaunchCommandLine, serviceLabelForCommand } = await import(
  new URL("dist/multiplexer/services.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function run(input) {
  switch (input.api) {
    case "getServiceLaunchCommandLine":
      return getServiceLaunchCommandLine(input.metadata);
    case "serviceLabelForCommand":
      return serviceLabelForCommand(input.commandLine);
    case "buildServiceStateFromMetadata":
      return buildServiceStateFromMetadata(input.serviceId, input.metadata, input.options);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const inputs = [
  {
    name: "recovers launch commands from shell -lc metadata",
    api: "getServiceLaunchCommandLine",
    metadata: { command: "shell", args: ["-lc", "yarn dev"] },
  },
  {
    name: "returns empty launch command for non -lc shell metadata",
    api: "getServiceLaunchCommandLine",
    metadata: { command: "shell", args: ["-l"] },
  },
  {
    name: "derives service state from explicit launch command metadata",
    api: "buildServiceStateFromMetadata",
    serviceId: "svc-1",
    metadata: {
      command: "zsh",
      args: ["-lc", "ignored"],
      createdAt: "2026-05-02T00:00:00.000Z",
      worktreePath: "/repo/apps/web",
      label: "web",
      launchCommandLine: " yarn web ",
    },
    options: {
      cwd: "/repo/apps/web",
      tmuxTarget: { sessionName: "aimux-repo", windowId: "@9", windowIndex: 9, windowName: "web" },
      retained: true,
    },
  },
  {
    name: "falls back to shell -lc args while deriving service state",
    api: "buildServiceStateFromMetadata",
    serviceId: "svc-2",
    metadata: { command: "shell", args: ["-lc", "pnpm dev"], label: "pnpm" },
    options: {},
  },
  {
    name: "labels blank service commands as shell",
    api: "serviceLabelForCommand",
    commandLine: "   ",
  },
  {
    name: "labels path commands by basename",
    api: "serviceLabelForCommand",
    commandLine: "/opt/bin/custom-server --port 3000",
  },
];

const cases = inputs.map((input, index) => ({
  id: `multiplexer-services-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/multiplexer/services.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/services.test.ts",
  generatedBy: "scripts/capture-multiplexer-services-contract.mjs",
  description:
    "Multiplexer service launch metadata helper contracts captured by running TypeScript services helpers; tmux-backed mutation flows are fenced out.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
