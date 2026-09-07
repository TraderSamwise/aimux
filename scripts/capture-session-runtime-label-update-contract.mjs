#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/session-runtime-label-update.json", ROOT);

const { updateSessionLabel } = await import(new URL("dist/multiplexer/session-runtime-core.js", ROOT));

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value) {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function recorder(input) {
  const calls = [];
  return {
    calls,
    fn(method, impl) {
      return (...args) => {
        calls.push({ method, args: normalize(clone(args)) });
        return impl?.(...args);
      };
    },
  };
}

function makeDashboardHost(input) {
  const rec = recorder(input);
  const pendingActions = {
    clearSessionActionIfToken: rec.fn("dashboardPendingActions.clearSessionActionIfToken", () =>
      input.clearSessionActionIfToken ?? true,
    ),
  };
  const host = {
    mode: "dashboard",
    dashboardInputEpoch: input.dashboardInputEpoch ?? 0,
    projectRoot: "/repo",
    footerFlash: null,
    footerFlashTicks: 0,
    dashboardPendingActions: input.withTokenClearer === false ? undefined : pendingActions,
    setPendingDashboardSessionAction: rec.fn("setPendingDashboardSessionAction", () => input.pendingToken),
    reapplyDashboardPendingActions: rec.fn("reapplyDashboardPendingActions"),
    writeStatuslineFile: rec.fn("writeStatuslineFile"),
    renderCurrentDashboardView: rec.fn("renderCurrentDashboardView"),
    invalidateDesktopStateSnapshot: rec.fn("invalidateDesktopStateSnapshot"),
    postToProjectService: rec.fn("postToProjectService", async () => {
      if (input.staleAfterPost) host.dashboardInputEpoch += 1;
      if (input.postThrows) throw new Error(input.postThrows);
      return { ok: true };
    }),
    refreshDashboardModelFromService: rec.fn("refreshDashboardModelFromService", async () => {
      if (input.refreshThrows) throw new Error(input.refreshThrows);
      return input.refreshResult ?? true;
    }),
  };
  return { host, calls: rec.calls };
}

function makeLocalHost(input) {
  const rec = recorder(input);
  const host = {
    mode: input.mode ?? "session",
    projectRoot: "/repo",
    sessionLabels: new Map(input.sessionLabels ?? []),
    offlineSessions: clone(input.offlineSessions ?? []),
    dashboardSessionsCache: clone(input.dashboardSessionsCache ?? []),
    dashboardWorktreeGroupsCache: clone(input.dashboardWorktreeGroupsCache ?? []),
    dashboardState: {
      worktreeSessions: clone(input.worktreeSessions ?? []),
    },
    sessions: clone(input.sessions ?? []),
    sessionTmuxTargets: new Map(),
    invalidateDesktopStateSnapshot: rec.fn("invalidateDesktopStateSnapshot"),
    saveState: rec.fn("saveState"),
    writeStatuslineFile: rec.fn("writeStatuslineFile"),
    renderDashboard: rec.fn("renderDashboard"),
  };
  return { host, calls: rec.calls };
}

async function runCase(input) {
  const { host, calls } = input.mode === "dashboard" ? makeDashboardHost(input) : makeLocalHost(input);
  let result = null;
  let error = null;
  try {
    result = await updateSessionLabel(host, input.sessionId, input.label);
  } catch (err) {
    error = normalize(err);
  }
  return {
    result,
    error,
    labels: host.sessionLabels ? Array.from(host.sessionLabels.entries()) : null,
    offlineSessions: host.offlineSessions ?? null,
    dashboardSessionsCache: host.dashboardSessionsCache ?? null,
    dashboardWorktreeGroupsCache: host.dashboardWorktreeGroupsCache ?? null,
    worktreeSessions: host.dashboardState?.worktreeSessions ?? null,
    footerFlash: host.footerFlash ?? null,
    footerFlashTicks: host.footerFlashTicks ?? null,
    dashboardInputEpoch: host.dashboardInputEpoch ?? null,
    calls,
  };
}

const casesInput = [
  {
    name: "dashboard rename posts mutation refreshes and clears numeric pending token",
    input: {
      mode: "dashboard",
      sessionId: "codex-1",
      label: "  Review Lead  ",
      pendingToken: 7,
    },
  },
  {
    name: "dashboard rename falls back to clearing pending action without token helper",
    input: {
      mode: "dashboard",
      sessionId: "codex-1",
      label: "Agent",
      pendingToken: 9,
      withTokenClearer: false,
    },
  },
  {
    name: "dashboard rename failure refreshes model and flashes while lifecycle is current",
    input: {
      mode: "dashboard",
      sessionId: "codex-1",
      label: "Agent",
      pendingToken: 3,
      postThrows: "rename rejected",
    },
  },
  {
    name: "dashboard rename failure does not flash stale input lifecycle",
    input: {
      mode: "dashboard",
      sessionId: "codex-1",
      label: "Agent",
      pendingToken: 4,
      postThrows: "rename rejected",
      staleAfterPost: true,
    },
  },
  {
    name: "local rename trims label and updates offline session",
    input: {
      mode: "session",
      sessionId: "offline-1",
      label: "  Ops  ",
      sessionLabels: [["offline-1", "Old"]],
      offlineSessions: [{ id: "offline-1", label: "Old" }],
    },
  },
  {
    name: "local blank label clears label from maps and offline session",
    input: {
      mode: "session",
      sessionId: "offline-1",
      label: "   ",
      sessionLabels: [["offline-1", "Old"]],
      offlineSessions: [{ id: "offline-1", label: "Old" }],
    },
  },
];

const cases = [];
for (const [index, entry] of casesInput.entries()) {
  const input = clone(entry.input);
  cases.push({
    id: `session-runtime-label-update-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/session-runtime-core.ts",
    api: "updateSessionLabel",
    input,
    output: await runCase(clone(input)),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/session-runtime-core.ts",
  generatedBy: "scripts/capture-session-runtime-label-update-contract.mjs",
  description:
    "Session-runtime label update dashboard mutation and local state side effects captured by running TypeScript updateSessionLabel.",
  cases,
});
