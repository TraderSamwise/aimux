#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-interaction-helpers.json", ROOT);

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
    mode: input.mode ?? "dashboard",
    projectRoot: "/tmp/aimux-fixture-project",
    dashboardOverlayState: input.overlayKind ? { kind: input.overlayKind } : null,
    overseerWatchInstructionsTarget: clone(input.overseerWatchInstructionsTarget ?? null),
    overseerWatchInstructionsBuffer: input.overseerWatchInstructionsBuffer ?? "draft",
    workOutlineOverlaySessionId: input.workOutlineOverlaySessionId,
    workOutlineOverlayEntries: clone(input.workOutlineOverlayEntries ?? []),
    workOutlineOverlayOffset: input.workOutlineOverlayOffset ?? 7,
    footerFlash: null,
    footerFlashTicks: 0,
    openDashboardOverlay: rec.fn("openDashboardOverlay", (kind) => {
      host.dashboardOverlayState = { kind };
    }),
    clearDashboardOverlay: rec.fn("clearDashboardOverlay", () => {
      host.dashboardOverlayState = null;
    }),
    showDashboardError: rec.fn("showDashboardError"),
    renderOverseerOverlay: rec.fn("renderOverseerOverlay"),
    renderOverseerWatchInstructions: rec.fn("renderOverseerWatchInstructions"),
    renderWorkOutlineOverlay: rec.fn("renderWorkOutlineOverlay"),
    redrawDashboardWithOverlay: rec.fn("redrawDashboardWithOverlay"),
    loadWorkOutlineOverlayEntries: rec.fn("loadWorkOutlineOverlayEntries", () => {
      if (input.loadWorkOutlineResult === false) return false;
      host.workOutlineOverlayEntries = clone(input.reloadedWorkOutlineOverlayEntries ?? host.workOutlineOverlayEntries);
      return true;
    }),
  };
  return { host, calls: rec.calls };
}

function summarize(host, calls, returnValue) {
  return {
    returnValue: returnValue ?? null,
    overlayKind: host.dashboardOverlayState?.kind ?? null,
    overseerWatchInstructionsTarget: clone(host.overseerWatchInstructionsTarget),
    overseerWatchInstructionsBuffer: host.overseerWatchInstructionsBuffer,
    workOutlineOverlaySessionId: host.workOutlineOverlaySessionId ?? null,
    workOutlineOverlayOffset: host.workOutlineOverlayOffset,
    workOutlineOverlayEntries: clone(host.workOutlineOverlayEntries),
    footerFlash: host.footerFlash,
    footerFlashTicks: host.footerFlashTicks,
    calls,
  };
}

function runCase(input) {
  const { host, calls } = makeHost(input);
  const method = dashboardInteractionMethods[input.method];
  if (typeof method !== "function") {
    throw new Error(`unknown method ${input.method}`);
  }
  let returnValue;
  if (input.method === "formatRoutePreview") {
    returnValue = method.call(host, clone(input.recipientIds ?? []));
  } else if (input.method === "showOverseerWatchInstructions") {
    returnValue = method.call(host, clone(input.selected));
  } else if (input.method === "showWorkOutlineOverlay") {
    returnValue = method.call(host, input.sessionId);
  } else {
    returnValue = method.call(host);
  }
  return summarize(host, calls, returnValue);
}

const casesInput = [
  {
    name: "showOverseerOverlay opens overseer overlay and renders it",
    input: { method: "showOverseerOverlay" },
  },
  {
    name: "renderOverseerOverlay redraws dashboard with overlay",
    input: { method: "renderOverseerOverlay" },
  },
  {
    name: "showOverseerWatchInstructions stores target clears buffer and opens input overlay",
    input: { method: "showOverseerWatchInstructions", selected: { id: "codex-1", label: "Codex" } },
  },
  {
    name: "renderOverseerWatchInstructions redraws dashboard with overlay",
    input: { method: "renderOverseerWatchInstructions" },
  },
  {
    name: "showWorkOutlineOverlay loads all entries and renders work outline",
    input: {
      method: "showWorkOutlineOverlay",
      reloadedWorkOutlineOverlayEntries: [{ id: "note-1" }, { id: "note-2" }],
      workOutlineOverlayOffset: 4,
    },
  },
  {
    name: "showWorkOutlineOverlay records session filter before loading entries",
    input: {
      method: "showWorkOutlineOverlay",
      sessionId: "codex-1",
      reloadedWorkOutlineOverlayEntries: [{ id: "note-1", sessionId: "codex-1" }],
    },
  },
  {
    name: "showWorkOutlineOverlay stops when load fails",
    input: { method: "showWorkOutlineOverlay", sessionId: "codex-1", loadWorkOutlineResult: false },
  },
  {
    name: "renderWorkOutlineOverlay in dashboard mode redraws dashboard overlay",
    input: { method: "renderWorkOutlineOverlay", mode: "dashboard" },
  },
  {
    name: "formatRoutePreview returns empty string for no recipients",
    input: { method: "formatRoutePreview", recipientIds: [] },
  },
  {
    name: "formatRoutePreview renders one recipient",
    input: { method: "formatRoutePreview", recipientIds: ["codex-1"] },
  },
  {
    name: "formatRoutePreview renders two recipients",
    input: { method: "formatRoutePreview", recipientIds: ["codex-1", "claude-2"] },
  },
  {
    name: "formatRoutePreview truncates after two recipients with remainder count",
    input: { method: "formatRoutePreview", recipientIds: ["codex-1", "claude-2", "aider-3", "shell-4"] },
  },
];

const cases = casesInput.map((entry, index) => {
  const input = clone(entry.input);
  return {
    id: `dashboard-interaction-helpers-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-interaction.ts",
    api: input.method,
    input,
    output: runCase(clone(input)),
    inputSha256: hash(input),
  };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-interaction.ts",
  generatedBy: "scripts/capture-dashboard-interaction-helpers-contract.mjs",
  description:
    "Dashboard interaction direct overlay helpers and route preview formatting captured by running TypeScript.",
  cases,
});
