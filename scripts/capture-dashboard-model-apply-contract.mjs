#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-model-apply.json", ROOT);
const { applyDashboardModel } = await import(new URL("dist/multiplexer/dashboard-model.js", ROOT));

const FIXED_NOW = 1_700_000_000_000;
Date.now = () => FIXED_NOW;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function mergePatch(entry, patches = {}) {
  const patch = entry?.id ? patches[entry.id] : undefined;
  return patch ? { ...entry, ...clone(patch) } : entry;
}

function createPending(input, calls) {
  let version = input.version ?? 0;
  let sessionActions = clone(input.sessionActions ?? []);
  let serviceActions = clone(input.serviceActions ?? []);
  let sessionAppend = clone(input.sessionAppend ?? []);
  let teammateAppend = clone(input.teammateAppend ?? []);
  let serviceAppend = clone(input.serviceAppend ?? []);
  let worktreeAppend = clone(input.worktreeAppend ?? []);
  let sessionPatches = clone(input.sessionPatches ?? {});
  let servicePatches = clone(input.servicePatches ?? {});
  let worktreePatches = clone(input.worktreePatches ?? {});
  const clearResults = clone(input.clearResults ?? {});

  return {
    getVersion() {
      calls.push({ method: "getVersion", args: [] });
      return version;
    },
    listSessionActions() {
      calls.push({ method: "listSessionActions", args: [] });
      return clone(sessionActions);
    },
    clearSessionActionIfToken(id, token) {
      calls.push({ method: "clearSessionActionIfToken", args: [id, token] });
      const result = clearResults[`session:${id}:${token}`] ?? true;
      if (result) {
        sessionActions = sessionActions.filter((action) => action.id !== id || action.token !== token);
        version += 1;
      }
      return result;
    },
    listServiceActions() {
      calls.push({ method: "listServiceActions", args: [] });
      return clone(serviceActions);
    },
    clearServiceActionIfToken(id, token) {
      calls.push({ method: "clearServiceActionIfToken", args: [id, token] });
      const result = clearResults[`service:${id}:${token}`] ?? true;
      if (result) {
        serviceActions = serviceActions.filter((action) => action.id !== id || action.token !== token);
        version += 1;
      }
      return result;
    },
    applyToSessions(rows, options = {}) {
      const includeTeammates = options.includeTeammates === true;
      calls.push({ method: "applyToSessions", args: [{ includeTeammates, ids: rows.map((row) => row.id) }] });
      const appended = includeTeammates ? teammateAppend : sessionAppend;
      return [...clone(rows), ...clone(appended)].map((entry) => mergePatch(entry, sessionPatches));
    },
    applyToServices(rows) {
      calls.push({ method: "applyToServices", args: [{ ids: rows.map((row) => row.id) }] });
      return [...clone(rows), ...clone(serviceAppend)].map((entry) => mergePatch(entry, servicePatches));
    },
    applyToWorktrees(rows) {
      calls.push({ method: "applyToWorktrees", args: [{ names: rows.map((row) => row.name) }] });
      return [...clone(rows), ...clone(worktreeAppend)].map((entry) => mergePatch(entry, worktreePatches));
    },
    setState(update = {}) {
      if (typeof update.version === "number") version = update.version;
      if (update.sessionActions) sessionActions = clone(update.sessionActions);
      if (update.serviceActions) serviceActions = clone(update.serviceActions);
      if (update.sessionAppend) sessionAppend = clone(update.sessionAppend);
      if (update.teammateAppend) teammateAppend = clone(update.teammateAppend);
      if (update.serviceAppend) serviceAppend = clone(update.serviceAppend);
      if (update.worktreeAppend) worktreeAppend = clone(update.worktreeAppend);
      if (update.sessionPatches) sessionPatches = clone(update.sessionPatches);
      if (update.servicePatches) servicePatches = clone(update.servicePatches);
      if (update.worktreePatches) worktreePatches = clone(update.worktreePatches);
    },
    output() {
      return { version, sessionActions: clone(sessionActions), serviceActions: clone(serviceActions) };
    },
  };
}

function createHost(input, calls) {
  const pending = createPending(input.pending ?? {}, calls);
  const hostInput = input.host ?? {};
  const host = {
    dashboardPendingActions: pending,
    dashboardUiStateStore: {
      orderWorktreeGroups(groups) {
        calls.push({ method: "orderWorktreeGroups", args: [{ names: groups.map((group) => group.name) }] });
        if (hostInput.orderWorktreeGroups === "reverse") return clone(groups).reverse();
        return groups;
      },
      markSelectionDirty() {
        calls.push({ method: "markSelectionDirty", args: [] });
      },
    },
    dashboardModelSnapshotKey: hostInput.dashboardModelSnapshotKey,
    dashboardModelVersion: hostInput.dashboardModelVersion,
    dashboardState: clone(hostInput.dashboardState ?? {}),
    dashboardScribePreviewSessionId: hostInput.dashboardScribePreviewSessionId,
    dashboardScribePreviewEntriesCache: Object.hasOwn(hostInput, "dashboardScribePreviewEntriesCache")
      ? clone(hostInput.dashboardScribePreviewEntriesCache)
      : undefined,
    refreshDashboardScribePreviewEntries(selected) {
      calls.push({ method: "refreshDashboardScribePreviewEntries", args: [selected?.id ?? null] });
    },
  };

  if (Object.hasOwn(hostInput, "selectedSession")) {
    host.getSelectedDashboardSessionForActions = () => {
      calls.push({ method: "getSelectedDashboardSessionForActions", args: [] });
      return hostInput.selectedSession ? clone(hostInput.selectedSession) : undefined;
    };
  }

  return host;
}

function hostOutput(host) {
  return {
    rawSessions: clone(host.dashboardRawSessionsCache ?? null),
    rawTeammates: clone(host.dashboardRawTeammatesCache ?? null),
    rawServices: clone(host.dashboardRawServicesCache ?? null),
    rawWorktreeGroups: clone(host.dashboardRawWorktreeGroupsCache ?? null),
    sessions: clone(host.dashboardSessionsCache ?? null),
    teammates: clone(host.dashboardTeammatesCache ?? null),
    services: clone(host.dashboardServicesCache ?? null),
    worktreeGroups: clone(host.dashboardWorktreeGroupsCache ?? null),
    operationFailures: clone(host.dashboardOperationFailuresCache ?? null),
    agentRestoreOffer: clone(host.dashboardAgentRestoreOfferCache ?? null),
    mainCheckoutInfo: clone(host.dashboardMainCheckoutInfoCache ?? null),
    modelVersion: host.dashboardModelVersion ?? null,
    refreshedAt: host.dashboardModelRefreshedAt ?? null,
    pending: host.dashboardPendingActions.output(),
  };
}

function runCase(input) {
  const calls = [];
  const host = createHost(input, calls);
  const operations = input.operations ?? [];
  const steps = [];
  for (const operation of operations) {
    host.dashboardPendingActions.setState(operation.pendingUpdate ?? {});
    const callStart = calls.length;
    const result = applyDashboardModel(
      host,
      clone(operation.sessions ?? []),
      clone(operation.teammates ?? []),
      clone(operation.services ?? []),
      clone(operation.worktreeGroups ?? []),
      clone(operation.mainCheckoutInfo ?? { name: "Main Checkout", branch: "master" }),
      clone(operation.operationFailures ?? []),
      clone(operation.agentRestoreOffer ?? null),
    );
    steps.push({
      result,
      calls: clone(calls.slice(callStart)),
      host: hostOutput(host),
    });
  }
  return { steps };
}

const liveSession = {
  index: 1,
  id: "codex-main",
  command: "codex",
  status: "running",
  active: true,
  createdAt: "2026-01-01T10:00:00.000Z",
};
const scribeSession = {
  index: 2,
  id: "scribe-main",
  command: "claude",
  status: "running",
  active: false,
  scribe: true,
  createdAt: "2026-01-01T09:00:00.000Z",
};
const worktreeSession = {
  index: 3,
  id: "codex-wt",
  command: "codex",
  status: "running",
  active: false,
  worktreePath: "/repo/wt-a",
  worktreeName: "wt-a",
  createdAt: "2026-01-01T11:00:00.000Z",
};
const teammateSession = {
  index: 4,
  id: "team-a",
  command: "codex",
  status: "running",
  active: false,
  team: { teamId: "t1", parentSessionId: "codex-main", role: "coder" },
};
const straySession = {
  index: 5,
  id: "not-team",
  command: "codex",
  status: "running",
  active: false,
};
const mainService = { id: "svc-main", command: "yarn", args: ["dev"], status: "running", active: true };
const wtService = {
  id: "svc-wt",
  command: "node",
  args: ["server.js"],
  status: "running",
  active: false,
  worktreePath: "/repo/wt-a",
  worktreeName: "wt-a",
};
const mainGroup = { name: "Main Checkout", branch: "master", status: "offline", sessions: [], services: [] };
const wtGroup = {
  name: "wt-a",
  branch: "feature/a",
  path: "/repo/wt-a",
  status: "offline",
  createdAt: "2026-01-02T00:00:00.000Z",
  sessions: [],
  services: [],
};

const inputs = [
  {
    name: "populates raw and derived caches with composed worktree groups",
    host: { orderWorktreeGroups: "reverse" },
    pending: {
      version: 2,
      teammateAppend: [
        {
          index: 6,
          id: "team-b",
          command: "claude",
          status: "running",
          active: false,
          team: { teamId: "t1", parentSessionId: "codex-main", role: "reviewer" },
        },
        { index: 7, id: "not-a-teammate", command: "codex", status: "running", active: false },
      ],
    },
    operations: [
      {
        sessions: [liveSession, scribeSession, worktreeSession],
        teammates: [teammateSession, straySession],
        services: [mainService, wtService],
        worktreeGroups: [mainGroup, wtGroup],
        mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
        operationFailures: [{ id: "op-1", message: "failed" }],
        agentRestoreOffer: { id: "restore-1", sessionIds: ["codex-main"] },
      },
    ],
  },
  {
    name: "returns false for an unchanged snapshot after refreshing timestamp",
    pending: { version: 3 },
    operations: [
      {
        sessions: [liveSession],
        teammates: [],
        services: [],
        worktreeGroups: [mainGroup],
        mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
      },
      {
        sessions: [liveSession],
        teammates: [],
        services: [],
        worktreeGroups: [mainGroup],
        mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
      },
    ],
  },
  {
    name: "pending action version changes force a rebuild for identical raw rows",
    pending: { version: 0, sessionPatches: { "codex-main": { headline: "first pass" } } },
    operations: [
      {
        sessions: [liveSession],
        worktreeGroups: [mainGroup],
        mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
      },
      {
        pendingUpdate: { version: 1, sessionPatches: { "codex-main": { headline: "second pass" } } },
        sessions: [liveSession],
        worktreeGroups: [mainGroup],
        mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
      },
    ],
  },
  {
    name: "scribe preview refresh is suppressed when the selected preview is already cached",
    host: {
      dashboardState: { previewSource: "scribe" },
      dashboardScribePreviewSessionId: "codex-main",
      dashboardScribePreviewEntriesCache: [],
      selectedSession: liveSession,
    },
    operations: [
      {
        sessions: [liveSession],
        worktreeGroups: [mainGroup],
        mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
      },
    ],
  },
  {
    name: "scribe preview refresh receives the selected session when the cache is stale",
    host: {
      dashboardState: { previewSource: "scribe" },
      dashboardScribePreviewSessionId: "old-session",
      dashboardScribePreviewEntriesCache: [],
      selectedSession: liveSession,
    },
    operations: [
      {
        sessions: [liveSession],
        worktreeGroups: [mainGroup],
        mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
      },
    ],
  },
  {
    name: "non-scribe preview refreshes without a selected session argument",
    host: { dashboardState: { previewSource: "output" } },
    operations: [
      {
        sessions: [liveSession],
        worktreeGroups: [mainGroup],
        mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
      },
    ],
  },
  {
    name: "reconciled pending clears contribute to snapshot version before caches are built",
    pending: {
      version: 10,
      sessionActions: [{ id: "codex-main", kind: "creating", token: 42, startedAt: "2026-01-01T00:00:00.000Z" }],
    },
    operations: [
      {
        sessions: [liveSession],
        worktreeGroups: [mainGroup],
        mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
      },
    ],
  },
];

const cases = inputs.map((input, index) => ({
  id: `dashboard-model-apply-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/multiplexer/dashboard-model.ts",
  api: "applyDashboardModel",
  input,
  output: runCase(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-model.ts",
  generatedBy: "scripts/capture-dashboard-model-apply-contract.mjs",
  description:
    "Dashboard model cache application captured by running TypeScript applyDashboardModel with instrumented host adapters.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
