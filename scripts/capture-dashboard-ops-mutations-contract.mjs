#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-ops-mutations.json", ROOT);

const {
  createDashboardServiceWithFeedback,
  graveyardSessionWithFeedback,
  removeDashboardServiceWithFeedback,
  resumeOfflineServiceWithFeedback,
  stopDashboardServiceWithFeedback,
  stopSessionToOfflineWithFeedback,
} = await import(new URL("dist/multiplexer/dashboard-ops.js", ROOT));

const realNow = Date.now;
const realSetTimeout = globalThis.setTimeout;
let fakeNow = 1_700_000_000_000;
Date.now = () => fakeNow;
globalThis.setTimeout = (callback, ms = 0, ...args) =>
  realSetTimeout(() => {
    fakeNow += Number(ms) || 0;
    callback(...args);
  }, 0);
process.env.SHELL = "/bin/zsh";

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

function normalizeValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(value)
      .replace(/service-[0-9a-f]{8}/g, "<SERVICE_ID>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<ISO_DATE>"),
  );
}

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
        calls.push({ method: name, args: normalizeValue(args) });
        return impl?.(...args);
      };
    },
  };
}

function makePendingActionsFake(initial = []) {
  const actions = new Map();
  let nextToken = 0;
  for (const action of initial) {
    const token = action.token ?? ++nextToken;
    nextToken = Math.max(nextToken, token);
    actions.set(`${action.targetKind}:${action.id}`, { kind: action.kind, token });
  }
  return {
    getSessionAction(sessionId) {
      const action = actions.get(`session:${sessionId}`);
      return action === null ? null : action?.kind;
    },
    getServiceAction(serviceId) {
      const action = actions.get(`service:${serviceId}`);
      return action === null ? null : action?.kind;
    },
    setSessionAction(sessionId, kind) {
      const token = ++nextToken;
      actions.set(`session:${sessionId}`, { kind, token });
      return token;
    },
    clearSessionAction(sessionId) {
      actions.set(`session:${sessionId}`, null);
    },
    clearSessionActionIfToken(sessionId, token) {
      const key = `session:${sessionId}`;
      if (actions.get(key)?.token !== token) return false;
      actions.set(key, null);
      return true;
    },
    listSessionActions() {
      return [...actions.entries()]
        .filter(([key, value]) => key.startsWith("session:") && value)
        .map(([key, value]) => ({ id: key.slice("session:".length), kind: value.kind, token: value.token }));
    },
    setServiceAction(serviceId, kind) {
      const token = ++nextToken;
      actions.set(`service:${serviceId}`, { kind, token });
      return token;
    },
    clearServiceAction(serviceId) {
      actions.set(`service:${serviceId}`, null);
    },
    clearServiceActionIfToken(serviceId, token) {
      const key = `service:${serviceId}`;
      if (actions.get(key)?.token !== token) return false;
      actions.set(key, null);
      return true;
    },
    listServiceActions() {
      return [...actions.entries()]
        .filter(([key, value]) => key.startsWith("service:") && value)
        .map(([key, value]) => ({ id: key.slice("service:".length), kind: value.kind, token: value.token }));
    },
  };
}

function requestTimeoutError() {
  return Object.assign(new Error("request timed out after 9970ms"), { code: "ETIMEDOUT" });
}

function sequence(input, key, fallback) {
  const values = clone(input[key] ?? fallback);
  let index = 0;
  return {
    current() {
      const value = values[Math.min(index, values.length - 1)] ?? [];
      return clone(value);
    },
    advance() {
      index = Math.min(index + 1, Math.max(0, values.length - 1));
      return this.current();
    },
  };
}

function makeHost(input) {
  const rec = recorder();
  const services = sequence(input, "serviceSnapshots", [[]]);
  const sessions = sequence(input, "sessionSnapshots", [[]]);
  const pending = makePendingActionsFake(input.pendingActions ?? []);
  const host = {
    mode: input.mode ?? "dashboard",
    dashboardInputEpoch: 0,
    dashboardModelServiceRefreshedAt: 0,
    dashboardModelServiceRefreshError: input.refreshError ? new Error(input.refreshError) : undefined,
    dashboardRawServicesCache: clone(input.rawServices ?? services.current()),
    dashboardRawSessionsCache: clone(input.rawSessions ?? sessions.current()),
    dashboardPendingActions: pending,
    offlineSessions: clone(input.offlineSessions ?? []),
    sessions: clone(input.sessions ?? []),
    dashboardActivatingServiceIds: new Set(input.activatingServiceIds ?? []),
    footerFlash: "",
    footerFlashTicks: 0,
    serviceSeed: undefined,
    sessionSeed: undefined,
    setPendingDashboardServiceAction: rec.fn("setPendingDashboardServiceAction", (serviceId, kind, opts) => {
      if (kind === null) pending.clearServiceAction(serviceId);
      else pending.setServiceAction(serviceId, kind);
      host.serviceSeed = normalizeValue(opts?.serviceSeed);
    }),
    setPendingDashboardSessionAction: rec.fn("setPendingDashboardSessionAction", (sessionId, kind, opts) => {
      if (kind === null) pending.clearSessionAction(sessionId);
      else pending.setSessionAction(sessionId, kind);
      host.sessionSeed = normalizeValue(opts?.sessionSeed);
    }),
    reapplyDashboardPendingActions: rec.fn("reapplyDashboardPendingActions"),
    reconcileDashboardRenderState: rec.fn("reconcileDashboardRenderState"),
    renderDashboard: rec.fn("renderDashboard"),
    preferDashboardEntrySelection: rec.fn("preferDashboardEntrySelection"),
    getSessionLabel: rec.fn("getSessionLabel", (sessionId) => input.sessionLabels?.[sessionId] ?? undefined),
    adjustAfterRemove: rec.fn("adjustAfterRemove"),
    refreshLocalDashboardModel: rec.fn("refreshLocalDashboardModel"),
    resumeOfflineServiceById: rec.fn("resumeOfflineServiceById", () => {
      if (input.localServiceResumeError) throw new Error(input.localServiceResumeError);
    }),
    postToProjectService: rec.fn("postToProjectService", async (path, body) => {
      if (input.timeoutRoutes?.includes(path)) throw requestTimeoutError();
      if (input.errorRoutes?.[path]) throw new Error(input.errorRoutes[path]);
      if (path === "/services/create") {
        host.createdServiceId = body.serviceId;
      }
      return clone(input.routeResults?.[path] ?? {});
    }),
    refreshDashboardModelFromService: rec.fn("refreshDashboardModelFromService", async () => {
      host.dashboardModelServiceRefreshedAt += 1;
      if (input.refreshErrorUntilSettle && !input.settled) {
        host.dashboardModelServiceRefreshError = new Error(input.refreshErrorUntilSettle);
        return false;
      }
      host.dashboardModelServiceRefreshError = undefined;
      host.dashboardRawServicesCache = expandGeneratedServiceId(host, services.advance());
      host.dashboardRawSessionsCache = sessions.advance();
      return input.refreshReturnsFalse ? false : true;
    }),
    getDashboardServices: rec.fn("getDashboardServices", () => expandGeneratedServiceId(host, services.current())),
    getDashboardSessions: rec.fn("getDashboardSessions", () => sessions.current()),
    showDashboardError: rec.fn("showDashboardError"),
  };
  return { host, calls: rec.calls };
}

function expandGeneratedServiceId(host, value) {
  if (!host.createdServiceId) return value;
  return JSON.parse(JSON.stringify(value).replace(/<SERVICE_ID>/g, host.createdServiceId));
}

function summarize(host, calls, result) {
  return normalizeValue({
    result,
    footerFlash: host.footerFlash,
    footerFlashTicks: host.footerFlashTicks,
    pendingSessions: host.dashboardPendingActions.listSessionActions(),
    pendingServices: host.dashboardPendingActions.listServiceActions(),
    serviceSeed: host.serviceSeed ?? null,
    sessionSeed: host.sessionSeed ?? null,
    rawServices: host.dashboardRawServicesCache ?? null,
    rawSessions: host.dashboardRawSessionsCache ?? null,
    calls,
  });
}

async function runCase(input) {
  const { host, calls } = makeHost(input);
  let result = null;
  switch (input.api) {
    case "createDashboardServiceWithFeedback":
      result = await createDashboardServiceWithFeedback(host, input.commandLine ?? "", input.worktreePath);
      break;
    case "resumeOfflineServiceWithFeedback":
      result = await resumeOfflineServiceWithFeedback(host, clone(input.service));
      break;
    case "stopDashboardServiceWithFeedback":
      result = await stopDashboardServiceWithFeedback(host, clone(input.service));
      break;
    case "removeDashboardServiceWithFeedback":
      result = await removeDashboardServiceWithFeedback(host, clone(input.service));
      break;
    case "stopSessionToOfflineWithFeedback":
      result = await stopSessionToOfflineWithFeedback(host, clone(input.session));
      break;
    case "graveyardSessionWithFeedback":
      result = await graveyardSessionWithFeedback(host, input.sessionId, input.hasWorktrees);
      break;
    default:
      throw new Error(`unknown dashboard ops mutation api: ${input.api}`);
  }
  await sleep(10);
  return summarize(host, calls, result ?? null);
}

const cases = [
  {
    name: "creates a shell service through project API and clears pending after live row",
    input: {
      api: "createDashboardServiceWithFeedback",
      commandLine: "",
      worktreePath: "/repo",
      serviceSnapshots: [[], [{ id: "<SERVICE_ID>", status: "running", pid: 1234, foregroundCommand: "zsh" }]],
    },
  },
  {
    name: "creates a command service and labels it from the first command token",
    input: {
      api: "createDashboardServiceWithFeedback",
      commandLine: "pnpm dev --host 0.0.0.0",
      worktreePath: "/repo/app",
      serviceSnapshots: [[], [{ id: "<SERVICE_ID>", status: "running", pid: 2222 }]],
    },
  },
  {
    name: "blocks service create while four dashboard mutations are already in flight",
    input: {
      api: "createDashboardServiceWithFeedback",
      commandLine: "",
      pendingActions: [
        { targetKind: "session", id: "sess-a", kind: "starting", token: 1 },
        { targetKind: "session", id: "sess-b", kind: "stopping", token: 2 },
        { targetKind: "service", id: "svc-a", kind: "starting", token: 3 },
        { targetKind: "service", id: "svc-b", kind: "removing", token: 4 },
      ],
    },
  },
  {
    name: "starts an offline service in dashboard mode",
    input: {
      api: "resumeOfflineServiceWithFeedback",
      service: { id: "svc-1", label: "shell" },
      serviceSnapshots: [[], [{ id: "svc-1", status: "running" }]],
    },
  },
  {
    name: "local service resume failure clears pending and reports error",
    input: {
      api: "resumeOfflineServiceWithFeedback",
      mode: "agent",
      service: { id: "svc-1", label: "shell" },
      localServiceResumeError: "boom",
    },
  },
  {
    name: "does not stop a service while model-backed startup is pending",
    input: {
      api: "stopDashboardServiceWithFeedback",
      service: { id: "service-starting", label: "api" },
      serviceSnapshots: [[{ id: "service-starting", status: "offline", label: "api", pendingAction: "creating" }]],
    },
  },
  {
    name: "stops a running service after it settles offline",
    input: {
      api: "stopDashboardServiceWithFeedback",
      service: { id: "svc-1", label: "shell" },
      serviceSnapshots: [
        [{ id: "svc-1", status: "running" }],
        [{ id: "svc-1", status: "offline", foregroundCommand: "zsh", previewLine: "prompt" }],
      ],
    },
  },
  {
    name: "removes an offline service after stable row absence",
    input: {
      api: "removeDashboardServiceWithFeedback",
      service: { id: "svc-1", label: "shell" },
      rawServices: [{ id: "svc-1", status: "offline" }],
      serviceSnapshots: [[{ id: "svc-1", status: "offline" }], []],
    },
  },
  {
    name: "stops a dashboard agent after session row settles offline",
    input: {
      api: "stopSessionToOfflineWithFeedback",
      session: { id: "sess-1", command: "claude", label: "claude" },
      sessionLabels: { "sess-1": "claude" },
      sessionSnapshots: [
        [{ id: "sess-1", command: "claude", label: "claude", status: "running" }],
        [{ id: "sess-1", command: "claude", label: "claude", status: "offline" }],
      ],
    },
  },
  {
    name: "coalesces duplicate session stop",
    input: {
      api: "stopSessionToOfflineWithFeedback",
      session: { id: "sess-1", command: "codex", label: "codex" },
      sessionLabels: { "sess-1": "codex" },
      pendingActions: [{ targetKind: "session", id: "sess-1", kind: "stopping", token: 1 }],
      sessionSnapshots: [[{ id: "sess-1", command: "codex", label: "codex", status: "running" }]],
    },
  },
  {
    name: "does not let graveyard supersede pending stop for same agent",
    input: {
      api: "graveyardSessionWithFeedback",
      sessionId: "sess-1",
      hasWorktrees: true,
      sessions: [{ id: "sess-1", command: "codex", label: "codex", status: "running" }],
      sessionLabels: { "sess-1": "codex" },
      pendingActions: [{ targetKind: "session", id: "sess-1", kind: "stopping", token: 1 }],
      rawSessions: [{ id: "sess-1", command: "codex", label: "codex", status: "running" }],
      sessionSnapshots: [[{ id: "sess-1", command: "codex", label: "codex", status: "running", pendingAction: "graveyarding" }]],
    },
  },
  {
    name: "coalesces duplicate service removal",
    input: {
      api: "removeDashboardServiceWithFeedback",
      service: { id: "svc-1", label: "shell" },
      pendingActions: [{ targetKind: "service", id: "svc-1", kind: "removing", token: 1 }],
      rawServices: [{ id: "svc-1", status: "offline" }],
      serviceSnapshots: [[{ id: "svc-1", status: "offline", pendingAction: "removing", optimistic: true }]],
    },
  },
];

const outputCases = [];
for (const [index, entry] of cases.entries()) {
  const input = clone(entry.input);
  fakeNow = 1_700_000_000_000;
  const output = await runCase(clone(input));
  outputCases.push({
    id: `dashboard-ops-mutations-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-ops.ts",
    api: input.api,
    input,
    output,
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-ops.ts",
  generatedBy: "scripts/capture-dashboard-ops-mutations-contract.mjs",
  description:
    "Dashboard operation mutation feedback, pending-action pressure/coalescing, service lifecycle, and session stop/graveyard side effects captured by running TypeScript dashboard-ops exports.",
  cases: outputCases,
});

Date.now = realNow;
globalThis.setTimeout = realSetTimeout;
