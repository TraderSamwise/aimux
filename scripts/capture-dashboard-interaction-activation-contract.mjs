#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-interaction-activation.json", ROOT);

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
    dashboardActivationToken: clone(input.dashboardActivationToken ?? undefined),
    dashboardActivatingServiceIds: new Set(input.dashboardActivatingServiceIds ?? []),
    dashboardWorktreeGroupsCache: clone(input.dashboardWorktreeGroupsCache ?? []),
    offlineSessions: clone(input.offlineSessions ?? []),
    sessions: clone(input.sessions ?? []),
    footerFlash: input.footerFlash ?? "",
    footerFlashTicks: input.footerFlashTicks ?? 0,
    preferDashboardEntrySelection: rec.fn("preferDashboardEntrySelection"),
    persistDashboardUiState: rec.fn("persistDashboardUiState"),
    waitAndOpenLiveTmuxWindowForEntry: rec.fn("waitAndOpenLiveTmuxWindowForEntry", async () => input.entryOpenResult ?? "missing"),
    resumeOfflineSessionWithFeedback: rec.fn("resumeOfflineSessionWithFeedback", async () => {
      if (input.invalidateOnResume) host.dashboardInputEpoch += 1;
      if (input.modeAfterResume) host.mode = input.modeAfterResume;
      return input.sessionResumeResult ?? "settled";
    }),
    refreshDashboardModelFromService: rec.fn("refreshDashboardModelFromService", async () => true),
    refreshLocalDashboardModel: rec.fn("refreshLocalDashboardModel"),
    renderDashboard: rec.fn("renderDashboard"),
    getDashboardSessions: rec.fn("getDashboardSessions", () => clone(input.dashboardSessions ?? [])),
    getDashboardServices: rec.fn("getDashboardServices", () => clone(input.dashboardServices ?? [])),
    waitAndOpenLiveTmuxWindowForService: rec.fn("waitAndOpenLiveTmuxWindowForService", async () => input.serviceOpenResult ?? "missing"),
    resumeOfflineServiceWithFeedback: rec.fn("resumeOfflineServiceWithFeedback", async () => {
      if (input.invalidateOnResume) host.dashboardInputEpoch += 1;
      return input.serviceResumeResult ?? "settled";
    }),
    showDashboardError: rec.fn("showDashboardError"),
  };
  return { host, calls: rec.calls };
}

async function runCase(input) {
  const { host, calls } = makeHost(input);
  const target = clone(input.entry ?? input.service ?? null);
  const options = clone(input.options ?? {});
  const result =
    input.api === "activateDashboardService"
      ? await dashboardInteractionMethods.activateDashboardService.call(host, target)
      : await dashboardInteractionMethods.activateDashboardEntry.call(host, target, options);
  return {
    result,
    footerFlash: host.footerFlash,
    footerFlashTicks: host.footerFlashTicks,
    activationToken: host.dashboardActivationToken ?? null,
    activatingServiceIds: [...host.dashboardActivatingServiceIds],
    calls,
  };
}

const cases = [
  {
    name: "running session selects row and opens live tmux window",
    api: "activateDashboardEntry",
    input: {
      entry: { id: "codex-1", status: "running", worktreePath: "/repo/.aimux/worktrees/demo" },
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      entryOpenResult: "opened",
    },
  },
  {
    name: "preserved teammate activation skips dashboard selection persistence",
    api: "activateDashboardEntry",
    input: {
      entry: {
        id: "reviewer-1",
        status: "running",
        worktreePath: "/repo/.aimux/worktrees/demo",
        team: { teamId: "team-1", parentSessionId: "parent-1", role: "reviewer" },
      },
      options: { preserveDashboardSelection: true },
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      entryOpenResult: "opened",
    },
  },
  {
    name: "offline dashboard agent resumes and refreshes without opening",
    api: "activateDashboardEntry",
    input: {
      entry: { id: "codex-1", status: "offline", command: "codex", worktreePath: "/repo/.aimux/worktrees/demo" },
      offlineSessions: [{ id: "codex-1", status: "offline", command: "codex", worktreePath: "/repo/.aimux/worktrees/demo" }],
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      sessionResumeResult: "settled",
      dashboardSessions: [{ id: "codex-1", status: "running", tmuxWindowId: "@agent" }],
    },
  },
  {
    name: "blocked offline dashboard agent flashes restore reason",
    api: "activateDashboardEntry",
    input: {
      entry: {
        id: "codex-1",
        status: "offline",
        command: "codex",
        label: "Codex",
        restoreState: "blocked",
        restoreBlockedReason: "missing exact resumable backend session id",
        worktreePath: "/repo/.aimux/worktrees/demo",
      },
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
    },
  },
  {
    name: "offline dashboard agent activation invalidated after resume returns missing",
    api: "activateDashboardEntry",
    input: {
      entry: { id: "codex-1", status: "offline", command: "codex", worktreePath: "/repo/.aimux/worktrees/demo" },
      offlineSessions: [{ id: "codex-1", status: "offline", command: "codex", worktreePath: "/repo/.aimux/worktrees/demo" }],
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      sessionResumeResult: "settled",
      invalidateOnResume: true,
    },
  },
  {
    name: "offline dashboard agent pending resume returns pending",
    api: "activateDashboardEntry",
    input: {
      entry: { id: "codex-1", status: "offline", worktreePath: "/repo/.aimux/worktrees/demo" },
      offlineSessions: [{ id: "codex-1", status: "offline", worktreePath: "/repo/.aimux/worktrees/demo" }],
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      sessionResumeResult: "pending",
    },
  },
  {
    name: "running dashboard agent missing live window refreshes and flashes unavailable",
    api: "activateDashboardEntry",
    input: {
      entry: { id: "codex-1", status: "running", command: "codex", worktreePath: "/repo/.aimux/worktrees/demo" },
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      entryOpenResult: "missing",
    },
  },
  {
    name: "offline service resumes then waits for live tmux service",
    api: "activateDashboardService",
    input: {
      service: { id: "service-1", status: "offline", label: "shell", worktreePath: "/repo/.aimux/worktrees/demo" },
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      serviceResumeResult: "settled",
      serviceOpenResult: "opened",
      dashboardServices: [{ id: "service-1", status: "running", label: "shell", tmuxWindowId: "@service" }],
    },
  },
  {
    name: "offline service pending resume returns pending without refresh",
    api: "activateDashboardService",
    input: {
      service: { id: "service-1", status: "offline", label: "shell", worktreePath: "/repo/.aimux/worktrees/demo" },
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      serviceResumeResult: "pending",
    },
  },
  {
    name: "running service missing live window refreshes and flashes unavailable",
    api: "activateDashboardService",
    input: {
      service: { id: "service-1", status: "running", label: "shell", worktreePath: "/repo/.aimux/worktrees/demo" },
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      serviceOpenResult: "missing",
    },
  },
];

const outputCases = [];
for (const [index, entry] of cases.entries()) {
  const input = { ...clone(entry.input), api: entry.api };
  const output = await runCase(clone(input));
  outputCases.push({
    id: `dashboard-interaction-activation-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-interaction.ts",
    api: entry.api,
    input,
    output,
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-interaction.ts",
  generatedBy: "scripts/capture-dashboard-interaction-activation-contract.mjs",
  description:
    "Dashboard interaction session/service activation selection, resume, refresh, pending, and unavailable-window side effects captured by running TypeScript dashboardInteractionMethods.",
  cases: outputCases,
});
