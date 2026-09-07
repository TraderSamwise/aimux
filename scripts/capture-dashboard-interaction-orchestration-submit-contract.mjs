#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL(
  "testdata/contracts/v1/multiplexer/dashboard-interaction-orchestration-submit.json",
  ROOT,
);

const { dashboardInteractionMethods } = await import(new URL("dist/multiplexer/dashboard-interaction.js", ROOT));

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function recorder() {
  const calls = [];
  return {
    calls,
    fn(method, impl) {
      return (...args) => {
        calls.push({ method, args: clone(args) });
        return impl?.(...args);
      };
    },
  };
}

function makeHost(input) {
  const rec = recorder();
  const host = {
    mode: input.hostMode ?? "dashboard",
    dashboardInputEpoch: input.dashboardInputEpoch ?? 0,
    footerFlash: null,
    footerFlashTicks: 0,
    orchestrationInputBuffer: input.orchestrationInputBuffer ?? "draft",
    orchestrationInputTarget: clone(input.orchestrationInputTarget ?? { stale: true }),
    orchestrationInputMode: input.orchestrationInputMode ?? input.mode,
    postToProjectService: rec.fn("postToProjectService", async (path, body, opts) => {
      if (input.postThrows) {
        const error = new Error(input.postThrows);
        error.tuiApiRecoverable = false;
        throw error;
      }
      return clone(input.postResult ?? { ok: true, path, body, opts });
    }),
    clearDashboardOverlay: rec.fn("clearDashboardOverlay", () => {
      host.dashboardOverlayState = null;
    }),
    showDashboardError: rec.fn("showDashboardError"),
    renderDashboard: rec.fn("renderDashboard"),
  };
  return { host, calls: rec.calls };
}

async function runCase(input) {
  const { host, calls } = makeHost(input);
  const args = [input.mode, clone(input.target), input.body];
  if (input.lifecycle !== undefined) args.push(clone(input.lifecycle));
  await dashboardInteractionMethods.submitDashboardOrchestrationAction.call(host, ...args);
  return {
    footerFlash: host.footerFlash,
    footerFlashTicks: host.footerFlashTicks,
    overlayKind: host.dashboardOverlayState?.kind ?? null,
    orchestrationInputBuffer: host.orchestrationInputBuffer,
    orchestrationInputTarget: clone(host.orchestrationInputTarget),
    orchestrationInputMode: host.orchestrationInputMode,
    tuiApiConnectionState: host.tuiApiConnectionState ?? null,
    calls,
  };
}

const casesInput = [
  {
    name: "message to one session posts thread request and flashes singular recipient",
    input: {
      mode: "message",
      target: { sourceSessionId: "codex-source", sessionId: "claude-1", label: "Claude" },
      body: "please review this",
    },
  },
  {
    name: "message to route recipients flashes plural recipient count",
    input: {
      mode: "message",
      target: { sourceSessionId: "codex-source", recipientIds: ["a", "b", "c"], label: "All" },
      body: "status?",
    },
  },
  {
    name: "handoff posts handoff route and flashes label",
    input: {
      mode: "handoff",
      target: { sourceSessionId: "codex-source", sessionId: "reviewer-1", label: "Reviewer" },
      body: "take over please",
    },
  },
  {
    name: "task posts assignment route with assignee and description",
    input: {
      mode: "task",
      target: { sourceSessionId: "codex-source", assignee: "reviewer", label: "Reviewer", worktreePath: "/repo/wt" },
      body: "write tests",
    },
  },
  {
    name: "stale lifecycle posts but suppresses dashboard mutation",
    input: {
      mode: "message",
      target: { sessionId: "claude-1", label: "Claude" },
      body: "hello",
      dashboardInputEpoch: 2,
      lifecycle: { mode: "dashboard", inputEpoch: 1, requiresInputEpoch: true },
    },
  },
  {
    name: "handoff failure clears input and shows mode-specific error",
    input: {
      mode: "handoff",
      target: { sessionId: "reviewer-1", label: "Reviewer" },
      body: "take over",
      postThrows: "service unavailable",
    },
  },
];

const cases = [];
for (const [index, entry] of casesInput.entries()) {
  const input = clone(entry.input);
  cases.push({
    id: `dashboard-interaction-orchestration-submit-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-interaction.ts",
    api: "dashboardInteractionMethods.submitDashboardOrchestrationAction",
    input,
    output: await runCase(clone(input)),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-interaction.ts",
  generatedBy: "scripts/capture-dashboard-interaction-orchestration-submit-contract.mjs",
  description:
    "Dashboard orchestration submit message/handoff/task project-service mutations captured by running TypeScript dashboardInteractionMethods.submitDashboardOrchestrationAction.",
  cases,
});
