#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-control-overlay-output.json", ROOT);

const { buildOrchestrationInputOverlayOutput, buildOrchestrationRoutePickerOverlayOutput } = await import(
  new URL("dist/multiplexer/dashboard-control.js", ROOT)
);

const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function makeHost(input) {
  return {
    orchestrationInputMode: input.orchestrationInputMode ?? null,
    orchestrationInputTarget: clone(input.orchestrationInputTarget ?? null),
    orchestrationInputBuffer: input.orchestrationInputBuffer ?? "",
    orchestrationRouteMode: input.orchestrationRouteMode ?? null,
    orchestrationRouteOptions: clone(input.orchestrationRouteOptions ?? []),
  };
}

async function runCase(api, input) {
  const host = makeHost(input);
  if (api === "buildOrchestrationInputOverlayOutput") {
    return buildOrchestrationInputOverlayOutput(host, input.cols, input.rows);
  }
  if (api === "buildOrchestrationRoutePickerOverlayOutput") {
    return buildOrchestrationRoutePickerOverlayOutput(host, input.cols, input.rows);
  }
  throw new Error(`unknown api ${api}`);
}

const routeOptions = Array.from({ length: 11 }, (_value, index) => ({
  label: `Agent ${index + 1}`,
  sessionId: `agent-${index + 1}`,
}));

const casesInput = [
  {
    api: "buildOrchestrationInputOverlayOutput",
    name: "message input shows worktree and send hint",
    input: {
      cols: 90,
      rows: 24,
      orchestrationInputMode: "message",
      orchestrationInputTarget: { label: "Codex One", sessionId: "codex-1", worktreePath: "/repo/wt" },
      orchestrationInputBuffer: "please review",
    },
  },
  {
    api: "buildOrchestrationInputOverlayOutput",
    name: "task input summarizes best-match recipient route",
    input: {
      cols: 90,
      rows: 24,
      orchestrationInputMode: "task",
      orchestrationInputTarget: { label: "Best available", recipientIds: ["a", "b", "c", "d"] },
      orchestrationInputBuffer: "ship it",
    },
  },
  {
    api: "buildOrchestrationInputOverlayOutput",
    name: "handoff input previews named recipients",
    input: {
      cols: 90,
      rows: 24,
      orchestrationInputMode: "handoff",
      orchestrationInputTarget: { label: "Team", recipientIds: ["claude-1", "codex-2"] },
      orchestrationInputBuffer: "take over",
    },
  },
  {
    api: "buildOrchestrationRoutePickerOverlayOutput",
    name: "route picker shows first nine options and ellipsis",
    input: {
      cols: 70,
      rows: 20,
      orchestrationRouteMode: "task",
      orchestrationRouteOptions: routeOptions,
    },
  },
  {
    api: "buildOrchestrationRoutePickerOverlayOutput",
    name: "route picker returns null without a mode",
    input: {
      cols: 70,
      rows: 20,
      orchestrationRouteOptions: routeOptions.slice(0, 2),
    },
  },
];

const cases = [];
for (const [index, entry] of casesInput.entries()) {
  const input = clone(entry.input);
  cases.push({
    id: `dashboard-control-overlay-output-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-control.ts",
    api: entry.api,
    input,
    output: await runCase(entry.api, clone(input)),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-control.ts",
  generatedBy: "scripts/capture-dashboard-control-overlay-output-contract.mjs",
  description: "Dashboard-control orchestration overlay rendering captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
