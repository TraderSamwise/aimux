#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("src/multiplexer/dashboard-lifecycle.contract.v1.json", ROOT);
process.env.AIMUX_HOME = mkdtempSync(join(tmpdir(), "aimux-dashboard-lifecycle-home-"));

const { dashboardTailMethods } = await import(new URL("dist/multiplexer/dashboard-tail-methods.js", ROOT));
const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { TmuxSessionTransport } = await import(new URL("dist/tmux/session-transport.js", ROOT));
const { listTopologySessionStates, upsertTopologySession } = await import(
  new URL("dist/runtime-core/topology-sessions.js", ROOT)
);

const GENERATED_AT = "2026-09-07T00:00:00.000Z";
const INITIAL_AT = "2026-05-25T00:00:00.000Z";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function expandRepo(value, repoRoot) {
  if (typeof value === "string") return value.replaceAll("<repo>", repoRoot);
  if (Array.isArray(value)) return value.map((entry) => expandRepo(entry, repoRoot));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandRepo(entry, repoRoot)]));
}

function normalize(value, repoRoot) {
  if (typeof value === "string") {
    if (value === repoRoot) return "<repo>";
    return value.replaceAll(repoRoot, "<repo>").replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "<ts>");
  }
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, repoRoot));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry, repoRoot)]));
}

function target(id, index = 1) {
  return { sessionName: "aimux-test", windowId: id, windowIndex: index, windowName: "codex" };
}

function makeRuntime(raw, host) {
  const runtime = {
    id: raw.id,
    command: raw.command ?? raw.toolConfigKey ?? raw.tool ?? "codex",
    startTime: raw.startTime ? Date.parse(raw.startTime) : undefined,
    backendSessionId: raw.backendSessionId,
    team: raw.team,
    kill() {
      host.runtimeKillCalls += 1;
    },
  };
  if (raw.transportKind === "tmux") {
    const tmuxTarget = raw.tmuxTarget ?? target("@1", 1);
    runtime.transport = new TmuxSessionTransport(runtime.id, runtime.command, tmuxTarget, host.tmuxRuntimeManager, 80, 24);
    host.transports.push(runtime.transport);
    host.sessionTmuxTargets.set(runtime.id, tmuxTarget);
  }
  return runtime;
}

function makeHost(input, repoRoot) {
  const calls = [];
  const tmuxKillTargets = [];
  const manager = {
    getTargetByWindowId: (_sessionName, windowId) => input.targetsByWindowId?.[windowId],
    isWindowAlive: (tmuxTarget) => input.deadWindowIds?.includes(tmuxTarget?.windowId) !== true,
    killWindow: (tmuxTarget) => tmuxKillTargets.push(tmuxTarget),
    async killWindowAsync(tmuxTarget) {
      tmuxKillTargets.push(tmuxTarget);
    },
    listProjectManagedWindows: () => input.managedWindows ?? [],
  };
  const host = {
    projectRoot: repoRoot,
    mode: input.mode ?? "project-service",
    sessions: [],
    offlineSessions: input.offlineSessions ?? [],
    stoppingSessionIds: new Set(input.stoppingSessionIds ?? []),
    graveyardAfterStopSessionIds: new Set(input.graveyardAfterStopSessionIds ?? []),
    sessionTmuxTargets: new Map(Object.entries(input.sessionTmuxTargets ?? {})),
    sessionToolKeys: new Map(Object.entries(input.sessionToolKeys ?? {})),
    sessionOriginalArgs: new Map(Object.entries(input.sessionOriginalArgs ?? {})),
    sessionWorktreePaths: new Map(Object.entries(input.sessionWorktreePaths ?? {})),
    sessionStartTimes: new Map(),
    sessionRoles: new Map(),
    sessionTeams: new Map(),
    tmuxRuntimeManager: manager,
    transports: [],
    calls,
    tmuxKillTargets,
    runtimeKillCalls: 0,
    invalidateDesktopStateSnapshot: () => calls.push("invalidateDesktopStateSnapshot"),
    writeStatuslineFile: () => calls.push("writeStatuslineFile"),
    renderCurrentDashboardView: () => calls.push("renderCurrentDashboardView"),
    updateContextWatcherSessions: () => calls.push("updateContextWatcherSessions"),
    metadataServer: { notifyChange: () => calls.push("metadataNotify") },
    restoreTmuxSessionsFromTopology: () => calls.push("restoreTmuxSessionsFromTopology"),
    syncSessionsFromTopology: () => calls.push("syncSessionsFromTopology"),
    getSessionLabel: (sessionId) => input.labels?.[sessionId],
    deriveHeadline: (sessionId) => input.headlines?.[sessionId],
    debug: (message, category) => calls.push(`debug:${category}:${message}`),
  };
  host.sessions = (input.sessions ?? []).map((runtime) => makeRuntime(runtime, host));
  return host;
}

function topologySnapshot(projectRoot) {
  const statuses = ["starting", "running", "idle", "offline", "graveyard"];
  return Object.fromEntries(statuses.map((status) => [status, listTopologySessionStates({ statuses: [status], projectRoot })]));
}

function hostSnapshot(host) {
  return {
    sessions: host.sessions.map((session) => session.id),
    offlineSessions: host.offlineSessions.map((session) => ({
      id: session.id,
      status: session.status,
      backendSessionId: session.backendSessionId,
      worktreePath: session.worktreePath,
      label: session.label,
      headline: session.headline,
      freshRelaunchAllowed: session.freshRelaunchAllowed,
    })),
    stoppingSessionIds: [...host.stoppingSessionIds],
    graveyardAfterStopSessionIds: [...host.graveyardAfterStopSessionIds],
    sessionTmuxTargets: [...host.sessionTmuxTargets.keys()],
    calls: [...host.calls],
    tmuxKillTargets: host.tmuxKillTargets.map((target) => ({ ...target })),
    runtimeKillCalls: host.runtimeKillCalls,
  };
}

async function drainTimers() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

async function runInput(rawInput) {
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-dashboard-lifecycle-"));
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  const input = expandRepo(rawInput, repoRoot);
  await initPaths(repoRoot);
  for (const seed of input.topologySessions ?? []) {
    upsertTopologySession(seed.session, seed.status, { projectRoot: repoRoot, now: INITIAL_AT });
  }
  const host = makeHost(input, repoRoot);
  let result;
  let error;
  try {
    if (input.action === "stop") {
      result = await dashboardTailMethods.stopAgent.call(host, input.sessionId);
    } else {
      result = await dashboardTailMethods.sendAgentToGraveyard.call(host, input.sessionId);
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const immediate = {
    host: hostSnapshot(host),
    topology: topologySnapshot(repoRoot),
  };
  await drainTimers();
  const afterTimers = {
    host: hostSnapshot(host),
    topology: topologySnapshot(repoRoot),
  };
  for (const transport of host.transports) transport.destroy();
  rmSync(repoRoot, { recursive: true, force: true });
  return normalize({ result, error, immediate, afterTimers }, repoRoot);
}

const cases = [];

async function record(name, input) {
  const fullInput = { name, ...input };
  cases.push({
    id: `dashboard-lifecycle-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/multiplexer/dashboard-tail-methods.ts",
    api: input.action === "stop" ? "dashboardTailMethods.stopAgent" : "dashboardTailMethods.sendAgentToGraveyard",
    input: fullInput,
    output: await runInput(input),
    inputSha256: hash(fullInput),
  });
}

await record("stop live runtime records offline before kill", {
  action: "stop",
  sessionId: "claude-1",
  sessions: [{ id: "claude-1", command: "claude", startTime: INITIAL_AT, backendSessionId: "backend-1" }],
  sessionToolKeys: { "claude-1": "claude" },
  sessionOriginalArgs: { "claude-1": ["--resume", "backend-1"] },
  sessionWorktreePaths: { "claude-1": "<repo>" },
  labels: { "claude-1": "Main" },
  headlines: { "claude-1": "Ready" },
});

await record("stop tmux runtime uses async manager kill", {
  action: "stop",
  sessionId: "codex-1",
  sessions: [{ id: "codex-1", command: "codex", startTime: INITIAL_AT, transportKind: "tmux", tmuxTarget: target("@1", 1) }],
  sessionToolKeys: { "codex-1": "codex" },
  sessionOriginalArgs: { "codex-1": [] },
  sessionWorktreePaths: { "codex-1": "<repo>" },
  targetsByWindowId: { "@1": target("@1", 1) },
});

await record("stop existing offline topology is idempotent", {
  action: "stop",
  sessionId: "codex-offline",
  topologySessions: [
    {
      status: "offline",
      session: { id: "codex-offline", command: "codex", tool: "codex", toolConfigKey: "codex", args: [], lifecycle: "offline", worktreePath: "<repo>" },
    },
  ],
});

await record("stop live topology resolves and kills unowned tmux window", {
  action: "stop",
  sessionId: "codex-topology",
  topologySessions: [
    {
      status: "running",
      session: {
        id: "codex-topology",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "live",
        worktreePath: "<repo>",
        tmuxTarget: target("@7", 7),
      },
    },
  ],
  managedWindows: [{ target: target("@7", 7), metadata: { kind: "agent", sessionId: "codex-topology" } }],
  targetsByWindowId: { "@7": target("@7", 7) },
});

await record("stop graveyarded topology rejects", {
  action: "stop",
  sessionId: "codex-grave",
  topologySessions: [
    {
      status: "graveyard",
      session: { id: "codex-grave", command: "codex", tool: "codex", toolConfigKey: "codex", args: [], worktreePath: "<repo>" },
    },
  ],
});

await record("graveyard offline topology removes offline cache", {
  action: "graveyard",
  sessionId: "codex-offline",
  offlineSessions: [{ id: "codex-offline", status: "offline" }],
  topologySessions: [
    {
      status: "offline",
      session: { id: "codex-offline", command: "codex", tool: "codex", toolConfigKey: "codex", args: [], lifecycle: "offline", worktreePath: "<repo>" },
    },
  ],
});

await record("graveyard live runtime before kill", {
  action: "graveyard",
  sessionId: "codex-live",
  sessions: [{ id: "codex-live", command: "codex", startTime: INITIAL_AT }],
  sessionToolKeys: { "codex-live": "codex" },
  sessionOriginalArgs: { "codex-live": [] },
  sessionWorktreePaths: { "codex-live": "<repo>" },
});

await record("graveyard live topology resolves and kills unowned tmux window", {
  action: "graveyard",
  sessionId: "codex-topology-live",
  topologySessions: [
    {
      status: "running",
      session: {
        id: "codex-topology-live",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "live",
        worktreePath: "<repo>",
        tmuxTarget: target("@8", 8),
      },
    },
  ],
  managedWindows: [{ target: target("@8", 8), metadata: { kind: "agent", sessionId: "codex-topology-live" } }],
  targetsByWindowId: { "@8": target("@8", 8) },
});

await record("graveyard existing graveyard topology is idempotent", {
  action: "graveyard",
  sessionId: "codex-grave",
  topologySessions: [
    {
      status: "graveyard",
      session: { id: "codex-grave", command: "codex", tool: "codex", toolConfigKey: "codex", args: [], worktreePath: "<repo>" },
    },
  ],
});

await record("graveyard unknown session rejects", {
  action: "graveyard",
  sessionId: "missing",
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: GENERATED_AT,
  generatedBy: "scripts/capture-dashboard-lifecycle-contract.mjs",
  source: "src/multiplexer/dashboard-tail-methods.ts",
  subject: "dashboardTailMethods lifecycle transitions",
  description: "Dashboard agent stop/graveyard transitions captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});

rmSync(process.env.AIMUX_HOME, { recursive: true, force: true });
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
