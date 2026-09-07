#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-ops-agent-actions.json", ROOT);

const {
  forkDashboardAgentWithFeedback,
  spawnDashboardAgentWithFeedback,
  switchDashboardAgentToolWithFeedback,
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

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

function normalizeValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<ISO_DATE>"));
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
    listServiceActions() {
      return [];
    },
  };
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
  const sessions = sequence(input, "sessionSnapshots", [[]]);
  const pending = makePendingActionsFake(input.pendingActions ?? []);
  const host = {
    mode: input.mode ?? "dashboard",
    dashboardInputEpoch: 0,
    dashboardModelServiceRefreshedAt: 0,
    dashboardModelServiceRefreshError: input.refreshError ? new Error(input.refreshError) : undefined,
    dashboardRawSessionsCache: clone(input.rawSessions ?? sessions.current()),
    dashboardPendingActions: pending,
    sessions: clone(input.sessions ?? []),
    footerFlash: "",
    footerFlashTicks: 0,
    sessionSeed: undefined,
    setPendingDashboardSessionAction: rec.fn("setPendingDashboardSessionAction", (sessionId, kind, opts) => {
      if (kind === null) pending.clearSessionAction(sessionId);
      else pending.setSessionAction(sessionId, kind);
      host.sessionSeed = normalizeValue(opts?.sessionSeed);
    }),
    reapplyDashboardPendingActions: rec.fn("reapplyDashboardPendingActions"),
    reconcileDashboardRenderState: rec.fn("reconcileDashboardRenderState"),
    renderDashboard: rec.fn("renderDashboard"),
    renderCurrentDashboardView: rec.fn("renderCurrentDashboardView"),
    preferDashboardEntrySelection: rec.fn("preferDashboardEntrySelection"),
    getSessionLabel: rec.fn("getSessionLabel", (sessionId) => input.sessionLabels?.[sessionId] ?? undefined),
    refreshLocalDashboardModel: rec.fn("refreshLocalDashboardModel"),
    switchAgentTool: rec.fn("switchAgentTool", async () => {
      if (input.switchError) throw new Error(input.switchError);
    }),
    postToProjectService: rec.fn("postToProjectService", async (path) => {
      if (input.errorRoutes?.[path]) throw new Error(input.errorRoutes[path]);
      return clone(input.routeResults?.[path] ?? {});
    }),
    refreshDashboardModelFromService: rec.fn("refreshDashboardModelFromService", async () => {
      host.dashboardModelServiceRefreshedAt += 1;
      host.dashboardModelServiceRefreshError = undefined;
      host.dashboardRawSessionsCache = sessions.advance();
      return input.refreshReturnsFalse ? false : true;
    }),
    getDashboardSessions: rec.fn("getDashboardSessions", () => sessions.current()),
    showDashboardError: rec.fn("showDashboardError"),
  };
  return { host, calls: rec.calls };
}

function summarize(host, calls, result) {
  return normalizeValue({
    result: result ?? null,
    footerFlash: host.footerFlash,
    footerFlashTicks: host.footerFlashTicks,
    pendingSessions: host.dashboardPendingActions.listSessionActions(),
    sessionSeed: host.sessionSeed ?? null,
    rawSessions: host.dashboardRawSessionsCache ?? null,
    calls,
  });
}

async function runCase(input) {
  const { host, calls } = makeHost(input);
  let result = null;
  switch (input.api) {
    case "spawnDashboardAgentWithFeedback":
      result = await spawnDashboardAgentWithFeedback(host, clone(input.input));
      break;
    case "forkDashboardAgentWithFeedback":
      result = await forkDashboardAgentWithFeedback(host, clone(input.input));
      break;
    case "switchDashboardAgentToolWithFeedback":
      result = await switchDashboardAgentToolWithFeedback(host, clone(input.input));
      break;
    default:
      throw new Error(`unknown dashboard ops agent api: ${input.api}`);
  }
  await sleep(10);
  return summarize(host, calls, result);
}

const baseSession = {
  id: "codex-1",
  command: "codex",
  toolConfigKey: "codex",
  label: "Coder",
  status: "running",
  active: true,
};

const cases = [
  {
    name: "spawnDashboardAgentWithFeedback selects a normal target and settles when it appears",
    input: {
      api: "spawnDashboardAgentWithFeedback",
      input: { sessionId: "codex-new", tool: "codex", worktreePath: "/repo/wt" },
      sessionSnapshots: [[], [{ id: "codex-new", command: "codex", toolConfigKey: "codex", status: "running" }]],
    },
  },
  {
    name: "spawnDashboardAgentWithFeedback does not select project-control agents",
    input: {
      api: "spawnDashboardAgentWithFeedback",
      input: { sessionId: "scribe-new", tool: "claude", scribe: true },
      sessionSnapshots: [[], [{ id: "scribe-new", command: "claude", toolConfigKey: "claude", status: "running" }]],
    },
  },
  {
    name: "forkDashboardAgentWithFeedback forwards source instruction and launch override",
    input: {
      api: "forkDashboardAgentWithFeedback",
      input: {
        sourceSessionId: "codex-1",
        targetSessionId: "codex-child",
        tool: "codex",
        instruction: "continue",
        worktreePath: "/repo/wt-child",
        launchOverride: { command: "codex", args: ["--model", "gpt-5"], env: { AIMUX: "1" } },
      },
      sessionSnapshots: [[], [{ id: "codex-child", command: "codex", toolConfigKey: "codex", status: "running" }]],
    },
  },
  {
    name: "switchDashboardAgentToolWithFeedback settles after dashboard model shows the new tool",
    input: {
      api: "switchDashboardAgentToolWithFeedback",
      input: { sessionId: "codex-1", tool: "claude", instruction: "switch over" },
      sessionLabels: { "codex-1": "Coder" },
      sessionSnapshots: [
        [baseSession],
        [{ ...baseSession, command: "claude", toolConfigKey: "claude" }],
      ],
    },
  },
  {
    name: "switchDashboardAgentToolWithFeedback coalesces an existing pending switch",
    input: {
      api: "switchDashboardAgentToolWithFeedback",
      input: { sessionId: "codex-1", tool: "claude" },
      pendingActions: [{ targetKind: "session", id: "codex-1", kind: "switching", token: 1 }],
      sessionSnapshots: [[baseSession]],
    },
  },
  {
    name: "switchDashboardAgentToolWithFeedback uses local mutation path outside dashboard mode",
    input: {
      api: "switchDashboardAgentToolWithFeedback",
      mode: "agent",
      input: { sessionId: "codex-1", tool: "claude", launchOverride: { command: "claude", args: [] } },
      sessions: [baseSession],
      sessionSnapshots: [[baseSession]],
    },
  },
];

const outputCases = [];
for (const [index, entry] of cases.entries()) {
  const input = clone(entry.input);
  fakeNow = 1_700_000_000_000;
  outputCases.push({
    id: `dashboard-ops-agent-actions-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-ops.ts",
    api: input.api,
    input,
    output: await runCase(clone(input)),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-ops.ts",
  generatedBy: "scripts/capture-dashboard-ops-agent-actions-contract.mjs",
  description:
    "Dashboard operation agent spawn/fork/switch feedback captured by running TypeScript dashboard-ops exports with deterministic host adapters.",
  cases: outputCases,
});

Date.now = realNow;
globalThis.setTimeout = realSetTimeout;
console.log(`${FIXTURE_PATH.pathname}: ${outputCases.length} cases`);
