#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-control-orchestration.json", ROOT);

const { handleOrchestrationInputKey, handleOrchestrationRoutePickerKey } = await import(
  new URL("dist/multiplexer/dashboard-control.js", ROOT)
);

const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function recorder() {
  const calls = [];
  return {
    calls,
    fn(name, impl) {
      return (...args) => {
        calls.push({ method: name, args: clone(args) });
        return impl?.(...args);
      };
    },
  };
}

function makeHost(input) {
  const rec = recorder();
  const host = {
    mode: input.mode ?? "dashboard",
    dashboardInputEpoch: input.dashboardInputEpoch ?? 0,
    orchestrationInputMode: input.orchestrationInputMode ?? null,
    orchestrationInputTarget: clone(input.orchestrationInputTarget ?? null),
    orchestrationInputBuffer: input.orchestrationInputBuffer ?? "",
    orchestrationRouteMode: input.orchestrationRouteMode ?? null,
    orchestrationRouteOptions: clone(input.orchestrationRouteOptions ?? []),
    dashboardOverlayState: clone(input.dashboardOverlayState ?? { kind: "none" }),
    clearDashboardOverlay: rec.fn("clearDashboardOverlay", () => {
      host.dashboardOverlayState = { kind: "none" };
    }),
    renderDashboard: rec.fn("renderDashboard"),
    renderOrchestrationInput: rec.fn("renderOrchestrationInput"),
    openDashboardOverlay: rec.fn("openDashboardOverlay", (kind) => {
      host.dashboardOverlayState = { kind };
    }),
    submitDashboardOrchestrationAction: rec.fn("submitDashboardOrchestrationAction", async () => ({ ok: true })),
  };
  return { host, calls: rec.calls };
}

async function runCase(api, input) {
  const { host, calls } = makeHost(input);
  const handler = api === "handleOrchestrationInputKey" ? handleOrchestrationInputKey : handleOrchestrationRoutePickerKey;
  handler(host, Buffer.from(input.key));
  await sleep(10);
  return {
    overlayKind: host.dashboardOverlayState?.kind ?? null,
    inputMode: host.orchestrationInputMode ?? null,
    inputTarget: host.orchestrationInputTarget ?? null,
    inputBuffer: host.orchestrationInputBuffer ?? null,
    routeMode: host.orchestrationRouteMode ?? null,
    routeOptions: host.orchestrationRouteOptions ?? [],
    calls,
  };
}

const target = { label: "Codex One", sessionId: "codex-1", worktreePath: "/repo/wt" };
const casesInput = [
  {
    api: "handleOrchestrationInputKey",
    name: "printable input appends and rerenders",
    input: {
      orchestrationInputMode: "message",
      orchestrationInputTarget: target,
      orchestrationInputBuffer: "hel",
      key: "lo",
    },
  },
  {
    api: "handleOrchestrationInputKey",
    name: "backspace removes one character and rerenders",
    input: {
      orchestrationInputMode: "handoff",
      orchestrationInputTarget: target,
      orchestrationInputBuffer: "handoff!",
      key: "\u007f",
    },
  },
  {
    api: "handleOrchestrationInputKey",
    name: "escape clears input overlay state",
    input: {
      orchestrationInputMode: "task",
      orchestrationInputTarget: target,
      orchestrationInputBuffer: "drop",
      dashboardOverlayState: { kind: "orchestration-input" },
      key: "\u001b",
    },
  },
  {
    api: "handleOrchestrationInputKey",
    name: "enter with blank body clears and renders without submit",
    input: {
      orchestrationInputMode: "message",
      orchestrationInputTarget: target,
      orchestrationInputBuffer: "   ",
      dashboardOverlayState: { kind: "orchestration-input" },
      key: "\r",
    },
  },
  {
    api: "handleOrchestrationInputKey",
    name: "enter submits trimmed body with lifecycle token",
    input: {
      orchestrationInputMode: "handoff",
      orchestrationInputTarget: target,
      orchestrationInputBuffer: "  take this  ",
      dashboardOverlayState: { kind: "orchestration-input" },
      dashboardInputEpoch: 42,
      key: "\r",
    },
  },
  {
    api: "handleOrchestrationRoutePickerKey",
    name: "escape clears route picker",
    input: {
      orchestrationRouteMode: "message",
      orchestrationRouteOptions: [target],
      dashboardOverlayState: { kind: "orchestration-route-picker" },
      key: "\u001b",
    },
  },
  {
    api: "handleOrchestrationRoutePickerKey",
    name: "valid digit opens input for selected target",
    input: {
      orchestrationRouteMode: "task",
      orchestrationRouteOptions: [
        { label: "First", sessionId: "codex-1" },
        { label: "Second", recipientIds: ["claude-1", "codex-2"] },
      ],
      dashboardOverlayState: { kind: "orchestration-route-picker" },
      key: "2",
    },
  },
  {
    api: "handleOrchestrationRoutePickerKey",
    name: "out of range digit clears and returns to dashboard",
    input: {
      orchestrationRouteMode: "task",
      orchestrationRouteOptions: [{ label: "Only", sessionId: "codex-1" }],
      dashboardOverlayState: { kind: "orchestration-route-picker" },
      key: "3",
    },
  },
];

const cases = [];
for (const [index, entry] of casesInput.entries()) {
  const input = clone(entry.input);
  cases.push({
    id: `dashboard-control-orchestration-${String(index + 1).padStart(3, "0")}`,
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
  generatedBy: "scripts/capture-dashboard-control-orchestration-contract.mjs",
  description:
    "Dashboard-control orchestration input and route-picker key side effects captured by running TypeScript handlers.",
  cases,
});
