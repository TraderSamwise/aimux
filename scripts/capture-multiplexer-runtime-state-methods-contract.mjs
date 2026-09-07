#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/runtime-state-methods.json", ROOT);
const FIXED_NOW = "2026-06-01T00:00:00.000Z";
const RealDate = Date;

globalThis.Date = class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) return new RealDate(FIXED_NOW);
    return new RealDate(...args);
  }

  static now() {
    return new RealDate(FIXED_NOW).getTime();
  }

  static parse(value) {
    return RealDate.parse(value);
  }

  static UTC(...args) {
    return RealDate.UTC(...args);
  }
};

const runtimeState = await import(new URL("dist/multiplexer/runtime-state.js", ROOT));
const paths = await import(new URL("dist/paths.js", ROOT));
const topologySessions = await import(new URL("dist/runtime-core/topology-sessions.js", ROOT));
const topologyServices = await import(new URL("dist/runtime-core/topology-services.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value, ctx) {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return nested.replaceAll(ctx.projectRoot, "<repo>").replaceAll(ctx.tmpRoot, "<tmp>");
    }),
  );
}

function denormalize(value, ctx) {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return nested.replaceAll("<repo>", ctx.projectRoot).replaceAll("<tmp>", ctx.tmpRoot);
    }),
  );
}

function callRecorder(calls, name, impl = () => undefined) {
  return (...args) => {
    calls.push({ method: name, args: clone(args) });
    return impl(...args);
  };
}

function snapshotTopology() {
  return {
    sessions: topologySessions.listTopologySessionStates(),
  };
}

function snapshotSessionServiceTopology() {
  return {
    sessions: topologySessions.listTopologySessionStates(),
    services: topologyServices.listTopologyServiceStates(),
  };
}

async function withFixture(label, fn) {
  const tmpRoot = mkdtempSync(join(tmpdir(), `aimux-runtime-state-methods-${label}-`));
  const projectRoot = join(tmpRoot, "repo");
  const previousHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = join(tmpRoot, "home");
  try {
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    await paths.initPaths(projectRoot);
    return await fn({ tmpRoot, projectRoot });
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function pendingActions(input, calls) {
  return {
    getSessionAction: callRecorder(calls, "dashboardPendingActions.getSessionAction", (id) => input.pendingSessionActions?.[id]),
    getServiceAction: callRecorder(calls, "dashboardPendingActions.getServiceAction", (id) => input.pendingServiceActions?.[id]),
  };
}

function tmuxRuntimeManager(input, calls) {
  return {
    listProjectManagedWindows: callRecorder(calls, "tmuxRuntimeManager.listProjectManagedWindows", () =>
      clone(input.liveWindows ?? []),
    ),
    isWindowAlive: callRecorder(calls, "tmuxRuntimeManager.isWindowAlive", (target) => {
      if (!input.deadWindowIds) return true;
      return !input.deadWindowIds.includes(target.windowId);
    }),
    displayMessage: callRecorder(calls, "tmuxRuntimeManager.displayMessage", (_format, windowId) => input.displayPaths?.[windowId] ?? null),
  };
}

function runtimeTopologyHost(input, calls) {
  return {
    projectRoot: input.projectRoot,
    sessions: clone(input.host?.sessions ?? []),
    offlineSessions: clone(input.host?.offlineSessions ?? []),
    offlineServices: clone(input.host?.offlineServices ?? []),
    dashboardPendingActions: pendingActions(input, calls),
    tmuxRuntimeManager: tmuxRuntimeManager(input, calls),
    debug: callRecorder(calls, "debug"),
  };
}

function mapEntries(map) {
  return [...map.entries()].map(([key, value]) => [key, clone(value)]);
}

function simplifyRuntime(session) {
  return {
    id: session.id,
    command: session.command,
    backendSessionId: session.backendSessionId,
  };
}

function restoreTmuxHost(input, calls) {
  const host = {
    projectRoot: input.projectRoot,
    sessions: clone(input.host?.sessions ?? []),
    sessionTmuxTargets: new Map(input.host?.sessionTmuxTargets ?? []),
    sessionLabels: new Map(input.host?.sessionLabels ?? []),
    sessionToolKeys: new Map(input.host?.sessionToolKeys ?? []),
    sessionOriginalArgs: new Map(input.host?.sessionOriginalArgs ?? []),
    sessionWorktreePaths: new Map(input.host?.sessionWorktreePaths ?? []),
    sessionRoles: new Map(input.host?.sessionRoles ?? []),
    stoppingSessionIds: new Set(input.host?.stoppingSessionIds ?? []),
    contextWatcher: { stop: callRecorder(calls, "contextWatcher.stop") },
    tmuxRuntimeManager: {
      listProjectManagedWindows: callRecorder(calls, "tmuxRuntimeManager.listProjectManagedWindows", () =>
        clone(input.liveWindows ?? []),
      ),
      clearTargetHistory: callRecorder(calls, "tmuxRuntimeManager.clearTargetHistory"),
      renameWindow: callRecorder(calls, "tmuxRuntimeManager.renameWindow"),
    },
    registerManagedSession(transport, args, toolConfigKey, worktreePath, role, startTime, team) {
      calls.push({
        method: "registerManagedSession",
        args: [
          { id: transport.id, command: transport.command, backendSessionId: transport.backendSessionId },
          clone(args),
          toolConfigKey,
          worktreePath,
          role,
          startTime,
          clone(team),
        ],
      });
      host.sessions.push({
        id: transport.id,
        command: transport.command,
        backendSessionId: transport.backendSessionId,
        transport,
      });
    },
    syncTmuxWindowMetadata: callRecorder(calls, "syncTmuxWindowMetadata"),
    updateContextWatcherSessions: callRecorder(calls, "updateContextWatcherSessions"),
    debug: callRecorder(calls, "debug"),
  };
  return host;
}

async function record(cases, name, api, label, input, run) {
  await withFixture(label, async (ctx) => {
    const normalizedInput = normalize(input(ctx), ctx);
    const output = normalize(await run(ctx, denormalize(normalizedInput, ctx)), ctx);
    cases.push({
      id: `multiplexer-runtime-state-methods-${String(cases.length + 1).padStart(3, "0")}`,
      name,
      source: "src/multiplexer/runtime-state.test.ts",
      api,
      input: normalizedInput,
      output,
      inputSha256: hash(normalizedInput),
    });
  });
}

const cases = [];

await record(
  cases,
  "adjustAfterRemove moves empty worktree session level back to worktrees",
  "adjustAfterRemove",
  "adjust-worktree-level",
  () => ({
    host: {
      dashboardState: { level: "sessions", sessionIndex: 4, worktreeEntries: [] },
      activeIndex: 0,
      dashboardSessions: [{ id: "a" }],
    },
    hasWorktrees: true,
  }),
  (_ctx, input) => {
    const calls = [];
    const host = {
      ...clone(input.host),
      updateWorktreeSessions: callRecorder(calls, "updateWorktreeSessions"),
      getDashboardSessions: callRecorder(calls, "getDashboardSessions", () => clone(input.host.dashboardSessions)),
    };
    runtimeState.adjustAfterRemove(host, input.hasWorktrees);
    return { host: clone(host), calls };
  },
);

await record(
  cases,
  "adjustAfterRemove clamps dashboard active index when there are no worktrees",
  "adjustAfterRemove",
  "adjust-active-index",
  () => ({
    host: { dashboardState: { level: "flat" }, activeIndex: 5, dashboardSessions: [{ id: "a" }, { id: "b" }] },
    hasWorktrees: false,
  }),
  (_ctx, input) => {
    const calls = [];
    const host = {
      ...clone(input.host),
      getDashboardSessions: callRecorder(calls, "getDashboardSessions", () => clone(input.host.dashboardSessions)),
    };
    runtimeState.adjustAfterRemove(host, input.hasWorktrees);
    return { host: clone(host), calls };
  },
);

await record(
  cases,
  "stopSessionToOffline persists offline topology and kills the runtime",
  "stopSessionToOffline",
  "stop-offline",
  ({ projectRoot }) => ({
    projectRoot,
    session: {
      id: "codex-1",
      command: "codex",
      backendSessionId: "backend-1",
      startTime: RealDate.parse("2026-05-01T00:00:00.000Z"),
      team: { teamId: "team-1", parentSessionId: "parent-1", role: "worker" },
    },
    host: {
      offlineSessions: [{ id: "codex-1", stale: true }],
      sessionToolKeys: [["codex-1", "codex"]],
      sessionOriginalArgs: [["codex-1", ["--model", "gpt-5"]]],
      sessionWorktreePaths: [["codex-1", `${projectRoot}/.aimux/worktrees/demo`]],
      sessionLabels: [["codex-1", "Codex One"]],
      headlines: [["codex-1", "Working on fixtures"]],
    },
  }),
  (_ctx, input) => {
    const calls = [];
    const session = {
      ...clone(input.session),
      kill: callRecorder(calls, "session.kill"),
    };
    const host = {
      projectRoot: input.projectRoot,
      mode: "project-service",
      offlineSessions: clone(input.host.offlineSessions),
      stoppingSessionIds: new Set(),
      sessionToolKeys: new Map(input.host.sessionToolKeys),
      sessionOriginalArgs: new Map(input.host.sessionOriginalArgs),
      sessionWorktreePaths: new Map(input.host.sessionWorktreePaths),
      sessionLabels: new Map(input.host.sessionLabels),
      noteLastUsedItem: callRecorder(calls, "noteLastUsedItem"),
      getSessionLabel: callRecorder(calls, "getSessionLabel", (id) => new Map(input.host.sessionLabels).get(id)),
      deriveHeadline: callRecorder(calls, "deriveHeadline", (id) => new Map(input.host.headlines).get(id)),
      saveState: callRecorder(calls, "saveState"),
      debug: callRecorder(calls, "debug"),
    };
    runtimeState.stopSessionToOffline(host, session);
    return {
      host: {
        offlineSessions: host.offlineSessions,
        stoppingSessionIds: [...host.stoppingSessionIds],
        startedInDashboard: host.startedInDashboard,
      },
      topology: snapshotTopology(),
      calls,
    };
  },
);

await record(
  cases,
  "graveyardSession moves a topology session and prunes offline cache",
  "graveyardSession",
  "graveyard-session",
  ({ projectRoot }) => {
    topologySessions.upsertTopologySession(
      {
        id: "codex-1",
        tool: "codex",
        command: "codex",
        args: [],
        lifecycle: "offline",
        worktreePath: `${projectRoot}/.aimux/worktrees/demo`,
      },
      "offline",
      { projectRoot },
    );
    return {
      projectRoot,
      sessionId: "codex-1",
      initialTopology: snapshotTopology(),
      host: { offlineSessions: [{ id: "codex-1", worktreePath: `${projectRoot}/.aimux/worktrees/demo` }] },
    };
  },
  (_ctx, input) => {
    const calls = [];
    const host = {
      projectRoot: input.projectRoot,
      mode: "dashboard",
      offlineSessions: clone(input.host.offlineSessions),
      noteLastUsedItem: callRecorder(calls, "noteLastUsedItem"),
      invalidateDesktopStateSnapshot: callRecorder(calls, "invalidateDesktopStateSnapshot"),
      writeStatuslineFile: callRecorder(calls, "writeStatuslineFile"),
      renderCurrentDashboardView: callRecorder(calls, "renderCurrentDashboardView"),
      debug: callRecorder(calls, "debug"),
    };
    runtimeState.graveyardSession(host, input.sessionId);
    return { host: { offlineSessions: host.offlineSessions }, topology: snapshotTopology(), calls };
  },
);

await record(
  cases,
  "isSessionRuntimeLive requires matching live tmux metadata",
  "isSessionRuntimeLive",
  "runtime-live",
  () => ({
    runtime: { id: "codex-1", exited: false },
    sessionTmuxTargets: [["codex-1", { sessionName: "aimux-repo", windowId: "@1", windowIndex: 1, windowName: "codex" }]],
    resolvedTarget: { sessionName: "aimux-repo", windowId: "@1", windowIndex: 1, windowName: "codex" },
    metadata: { kind: "agent", sessionId: "codex-1" },
  }),
  (_ctx, input) => {
    const calls = [];
    const host = {
      sessionTmuxTargets: new Map(input.sessionTmuxTargets),
      tmuxRuntimeManager: {
        getTargetByWindowId: callRecorder(calls, "tmuxRuntimeManager.getTargetByWindowId", () => input.resolvedTarget),
        getWindowMetadata: callRecorder(calls, "tmuxRuntimeManager.getWindowMetadata", () => input.metadata),
      },
    };
    return { live: runtimeState.isSessionRuntimeLive(host, clone(input.runtime)), calls };
  },
);

await record(
  cases,
  "restoreTmuxSessionsFromTopology restores team role from live tmux metadata",
  "restoreTmuxSessionsFromTopology",
  "restore-team-role",
  ({ projectRoot }) => ({
    projectRoot,
    liveWindows: [
      {
        target: { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" },
        metadata: {
          kind: "agent",
          sessionId: "codex-1",
          command: "codex",
          args: [],
          toolConfigKey: "codex",
          worktreePath: projectRoot,
          role: "reviewer",
          team: { teamId: "team-1", parentSessionId: "parent-1", role: "reviewer" },
          createdAt: "2026-04-21T00:00:00.000Z",
        },
      },
    ],
    host: { sessions: [], sessionTmuxTargets: [], sessionLabels: [] },
    initialTopology: snapshotSessionServiceTopology(),
  }),
  (_ctx, input) => {
    const calls = [];
    const host = restoreTmuxHost(input, calls);
    const liveWindows = runtimeState.restoreTmuxSessionsFromTopology(host);
    const output = {
      liveWindows,
      host: {
        sessions: host.sessions.map(simplifyRuntime),
        sessionTmuxTargets: mapEntries(host.sessionTmuxTargets),
        sessionLabels: mapEntries(host.sessionLabels),
      },
      calls,
    };
    for (const session of host.sessions) session.transport?.destroy?.();
    return output;
  },
);

await record(
  cases,
  "restoreTmuxSessionsFromTopology preserves saved backend ids when adopting live windows",
  "restoreTmuxSessionsFromTopology",
  "restore-backend-id",
  ({ projectRoot }) => {
    topologySessions.upsertTopologySession(
      {
        id: "codex-live",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "live",
        backendSessionId: "backend-live",
        worktreePath: projectRoot,
      },
      "running",
      { projectRoot },
    );
    return {
      projectRoot,
      liveWindows: [
        {
          target: { sessionName: "aimux-test", windowId: "@2", windowIndex: 2, windowName: "codex" },
          metadata: {
            kind: "agent",
            sessionId: "codex-live",
            command: "codex",
            args: [],
            toolConfigKey: "codex",
            worktreePath: projectRoot,
            createdAt: "2026-04-21T00:00:00.000Z",
          },
        },
      ],
      host: { sessions: [], sessionTmuxTargets: [], sessionLabels: [] },
      initialTopology: snapshotSessionServiceTopology(),
    };
  },
  (_ctx, input) => {
    const calls = [];
    const host = restoreTmuxHost(input, calls);
    const liveWindows = runtimeState.restoreTmuxSessionsFromTopology(host);
    const output = {
      liveWindows,
      host: {
        sessions: host.sessions.map(simplifyRuntime),
        sessionTmuxTargets: mapEntries(host.sessionTmuxTargets),
        sessionLabels: mapEntries(host.sessionLabels),
      },
      calls,
    };
    for (const session of host.sessions) session.transport?.destroy?.();
    return output;
  },
);

await record(
  cases,
  "restoreTmuxSessionsFromTopology evicts in-memory runtimes without live tmux metadata",
  "restoreTmuxSessionsFromTopology",
  "restore-evict-stale-runtime",
  ({ projectRoot }) => ({
    projectRoot,
    liveWindows: [],
    host: {
      sessions: [{ id: "codex-stale", command: "codex" }],
      sessionTmuxTargets: [
        ["codex-stale", { sessionName: "aimux-test", windowId: "@8", windowIndex: 8, windowName: "codex" }],
      ],
      sessionToolKeys: [["codex-stale", "codex"]],
      sessionOriginalArgs: [["codex-stale", []]],
      sessionWorktreePaths: [["codex-stale", projectRoot]],
      sessionRoles: [],
    },
    initialTopology: snapshotSessionServiceTopology(),
  }),
  (_ctx, input) => {
    const calls = [];
    const host = restoreTmuxHost(input, calls);
    const liveWindows = runtimeState.restoreTmuxSessionsFromTopology(host);
    return {
      liveWindows,
      host: {
        sessions: host.sessions.map(simplifyRuntime),
        sessionTmuxTargets: mapEntries(host.sessionTmuxTargets),
        sessionLabels: mapEntries(host.sessionLabels),
      },
      calls,
    };
  },
);

await record(
  cases,
  "restoreTmuxSessionsFromTopology clears pane history when rebinding an existing runtime target",
  "restoreTmuxSessionsFromTopology",
  "restore-rebind-target",
  ({ projectRoot }) => ({
    projectRoot,
    liveWindows: [
      {
        target: { sessionName: "aimux-test", windowId: "@2", windowIndex: 2, windowName: "codex" },
        metadata: {
          kind: "agent",
          sessionId: "codex-live",
          command: "codex",
          args: [],
          toolConfigKey: "codex",
          worktreePath: projectRoot,
        },
      },
    ],
    host: {
      sessions: [{ id: "codex-live", command: "codex" }],
      sessionTmuxTargets: [
        ["codex-live", { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" }],
      ],
      sessionLabels: [],
    },
    initialTopology: snapshotSessionServiceTopology(),
  }),
  (_ctx, input) => {
    const calls = [];
    const host = restoreTmuxHost(input, calls);
    const liveWindows = runtimeState.restoreTmuxSessionsFromTopology(host);
    return {
      liveWindows,
      host: {
        sessions: host.sessions.map(simplifyRuntime),
        sessionTmuxTargets: mapEntries(host.sessionTmuxTargets),
        sessionLabels: mapEntries(host.sessionLabels),
      },
      calls,
    };
  },
);

await record(
  cases,
  "loadOfflineTopologySessions skips a session with a pending start action",
  "loadOfflineTopologySessions",
  "load-offline-pending-session",
  ({ projectRoot }) => {
    topologySessions.upsertTopologySession(
      {
        id: "codex-1",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "offline",
        backendSessionId: "native-session",
        worktreePath: projectRoot,
      },
      "offline",
      { projectRoot },
    );
    return {
      projectRoot,
      pendingSessionActions: { "codex-1": "starting" },
      host: { sessions: [], offlineSessions: [] },
      initialTopology: snapshotSessionServiceTopology(),
    };
  },
  (_ctx, input) => {
    const calls = [];
    const host = runtimeTopologyHost(input, calls);
    const changed = runtimeState.loadOfflineTopologySessions(host);
    return { changed, host: { offlineSessions: host.offlineSessions }, topology: snapshotSessionServiceTopology(), calls };
  },
);

await record(
  cases,
  "loadOfflineTopologySessions does not confuse same-id pending service actions with sessions",
  "loadOfflineTopologySessions",
  "load-offline-session-service-pending",
  ({ projectRoot }) => {
    topologySessions.upsertTopologySession(
      {
        id: "codex-1",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "offline",
        backendSessionId: "native-session",
        worktreePath: projectRoot,
      },
      "offline",
      { projectRoot },
    );
    return {
      projectRoot,
      pendingServiceActions: { "codex-1": "starting" },
      host: { sessions: [], offlineSessions: [] },
      initialTopology: snapshotSessionServiceTopology(),
    };
  },
  (_ctx, input) => {
    const calls = [];
    const host = runtimeTopologyHost(input, calls);
    const changed = runtimeState.loadOfflineTopologySessions(host);
    return { changed, host: { offlineSessions: host.offlineSessions }, topology: snapshotSessionServiceTopology(), calls };
  },
);

await record(
  cases,
  "loadOfflineTopologySessions clears stale offline cache when topology has no offline sessions",
  "loadOfflineTopologySessions",
  "load-offline-clears-empty",
  ({ projectRoot }) => ({
    projectRoot,
    host: {
      sessions: [],
      offlineSessions: [{ id: "codex-stale", command: "codex", toolConfigKey: "codex", worktreePath: projectRoot }],
    },
    initialTopology: snapshotSessionServiceTopology(),
  }),
  (_ctx, input) => {
    const calls = [];
    const host = runtimeTopologyHost(input, calls);
    const changed = runtimeState.loadOfflineTopologySessions(host);
    return { changed, host: { offlineSessions: host.offlineSessions }, topology: snapshotSessionServiceTopology(), calls };
  },
);

await record(
  cases,
  "loadOfflineTopologySessions loads valid offline sessions without backend ids",
  "loadOfflineTopologySessions",
  "load-offline-without-backend",
  ({ projectRoot }) => {
    topologySessions.upsertTopologySession(
      { id: "claude-recoverable", command: "claude", tool: "claude", toolConfigKey: "claude", args: [], lifecycle: "offline", worktreePath: projectRoot },
      "offline",
      { projectRoot },
    );
    return { projectRoot, host: { sessions: [], offlineSessions: [] }, initialTopology: snapshotSessionServiceTopology() };
  },
  (_ctx, input) => {
    const calls = [];
    const host = runtimeTopologyHost(input, calls);
    const changed = runtimeState.loadOfflineTopologySessions(host);
    return { changed, host: { offlineSessions: host.offlineSessions }, topology: snapshotSessionServiceTopology(), calls };
  },
);

await record(
  cases,
  "loadOfflineTopologySessions ignores metadata-only backend id changes",
  "loadOfflineTopologySessions",
  "load-offline-metadata-only-backend-unchanged",
  ({ projectRoot }) => {
    topologySessions.upsertTopologySession(
      { id: "claude-recoverable", command: "claude", tool: "claude", toolConfigKey: "claude", args: [], lifecycle: "offline", worktreePath: projectRoot },
      "offline",
      { projectRoot },
    );
    return {
      projectRoot,
      host: {
        sessions: [],
        offlineSessions: [
          { id: "claude-recoverable", command: "claude", tool: "claude", toolConfigKey: "claude", args: [], lifecycle: "offline", worktreePath: projectRoot },
        ],
      },
      initialTopology: snapshotSessionServiceTopology(),
    };
  },
  (_ctx, input) => {
    const calls = [];
    const host = runtimeTopologyHost(input, calls);
    const changed = runtimeState.loadOfflineTopologySessions(host);
    return { changed, host: { offlineSessions: host.offlineSessions }, topology: snapshotSessionServiceTopology(), calls };
  },
);

await record(
  cases,
  "loadOfflineTopologySessions reports restore blocker changes",
  "loadOfflineTopologySessions",
  "load-offline-restore-blocker-changed",
  ({ projectRoot }) => {
    topologySessions.upsertTopologySession(
      {
        id: "claude-recoverable",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: [],
        lifecycle: "offline",
        backendSessionId: "backend-1",
        worktreePath: projectRoot,
        restoreBlockedReason: "agent exited during startup",
      },
      "offline",
      { projectRoot },
    );
    return {
      projectRoot,
      host: {
        sessions: [],
        offlineSessions: [
          {
            id: "claude-recoverable",
            command: "claude",
            tool: "claude",
            toolConfigKey: "claude",
            args: [],
            lifecycle: "offline",
            backendSessionId: "backend-1",
            worktreePath: projectRoot,
          },
        ],
      },
      initialTopology: snapshotSessionServiceTopology(),
    };
  },
  (_ctx, input) => {
    const calls = [];
    const host = runtimeTopologyHost(input, calls);
    const changed = runtimeState.loadOfflineTopologySessions(host);
    return { changed, host: { offlineSessions: host.offlineSessions }, topology: snapshotSessionServiceTopology(), calls };
  },
);

await record(
  cases,
  "loadOfflineTopologySessions strips stale tmux targets from explicit offline sessions",
  "loadOfflineTopologySessions",
  "load-offline-strips-stale-tmux-target",
  () => {
    topologySessions.upsertTopologySession(
      {
        id: "codex-offline",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "offline",
        tmuxTarget: { sessionName: "aimux-test", windowId: "@4", windowIndex: 4, windowName: "codex" },
      },
      "offline",
    );
    return { host: { sessions: [], offlineSessions: [] }, initialTopology: snapshotSessionServiceTopology() };
  },
  (_ctx, input) => {
    const calls = [];
    const host = runtimeTopologyHost(input, calls);
    const changed = runtimeState.loadOfflineTopologySessions(host);
    return { changed, host: { offlineSessions: host.offlineSessions }, topology: snapshotSessionServiceTopology(), calls };
  },
);

await record(
  cases,
  "loadOfflineTopologySessions skips offline sessions whose worktree is gone",
  "loadOfflineTopologySessions",
  "load-offline-missing-worktree",
  ({ projectRoot }) => {
    topologySessions.upsertTopologySession(
      {
        id: "codex-missing",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "offline",
        worktreePath: join(projectRoot, "deleted-worktree"),
      },
      "offline",
      { projectRoot },
    );
    return { projectRoot, host: { sessions: [], offlineSessions: [] }, initialTopology: snapshotSessionServiceTopology() };
  },
  (_ctx, input) => {
    const calls = [];
    const host = runtimeTopologyHost(input, calls);
    const changed = runtimeState.loadOfflineTopologySessions(host);
    return { changed, host: { offlineSessions: host.offlineSessions }, topology: snapshotSessionServiceTopology(), calls };
  },
);

await record(
  cases,
  "reconcileOrphanedTopologySessions demotes crash-orphaned running sessions to offline",
  "reconcileOrphanedTopologySessions",
  "reconcile-session-demote",
  ({ projectRoot }) => {
    topologySessions.upsertTopologySession(
      {
        id: "codex-1",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "live",
        backendSessionId: "native-1",
        worktreePath: projectRoot,
      },
      "running",
      { projectRoot },
    );
    return { projectRoot, host: { sessions: [], offlineSessions: [] }, initialTopology: snapshotSessionServiceTopology() };
  },
  (_ctx, input) => {
    const calls = [];
    const host = runtimeTopologyHost(input, calls);
    const changed = runtimeState.reconcileOrphanedTopologySessions(host, []);
    return { changed, host: { offlineSessions: host.offlineSessions }, topology: snapshotSessionServiceTopology(), calls };
  },
);

await record(
  cases,
  "reconcileOrphanedTopologySessions graveyards unrecoverable missing-worktree sessions",
  "reconcileOrphanedTopologySessions",
  "reconcile-session-graveyard",
  ({ projectRoot }) => {
    const missingWorktree = join(projectRoot, "deleted-worktree");
    topologySessions.upsertTopologySession(
      {
        id: "codex-gone",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "live",
        backendSessionId: "native-gone",
        worktreePath: missingWorktree,
      },
      "running",
      { projectRoot },
    );
    return { projectRoot, host: { sessions: [], offlineSessions: [] }, initialTopology: snapshotSessionServiceTopology() };
  },
  (_ctx, input) => {
    const calls = [];
    const host = runtimeTopologyHost(input, calls);
    const changed = runtimeState.reconcileOrphanedTopologySessions(host, []);
    return { changed, host: { offlineSessions: host.offlineSessions }, topology: snapshotSessionServiceTopology(), calls };
  },
);

await record(
  cases,
  "reconcileOrphanedTopologySessions demotes stale starting sessions and records restore blocker",
  "reconcileOrphanedTopologySessions",
  "reconcile-session-stale-starting",
  ({ projectRoot }) => {
    topologySessions.upsertTopologySession(
      {
        id: "claude-starting",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: [],
        lifecycle: "live",
        backendSessionId: "backend-1",
        worktreePath: projectRoot,
      },
      "starting",
      { projectRoot, now: new RealDate(RealDate.parse(FIXED_NOW) - 10_000).toISOString() },
    );
    return {
      projectRoot,
      pendingSessionActions: { "claude-starting": "starting" },
      host: { sessions: [], offlineSessions: [] },
      initialTopology: snapshotSessionServiceTopology(),
    };
  },
  (_ctx, input) => {
    const calls = [];
    const host = runtimeTopologyHost(input, calls);
    const changed = runtimeState.reconcileOrphanedTopologySessions(host, []);
    return { changed, host: { offlineSessions: host.offlineSessions }, topology: snapshotSessionServiceTopology(), calls };
  },
);

await record(
  cases,
  "loadOfflineServices skips a stopped service with a pending start action",
  "loadOfflineServices",
  "load-services-pending-service",
  ({ projectRoot }) => {
    topologyServices.upsertTopologyService(
      { id: "service-1", label: "web", launchCommandLine: "yarn web", worktreePath: projectRoot },
      "stopped",
      { projectRoot },
    );
    return {
      projectRoot,
      pendingServiceActions: { "service-1": "starting" },
      host: { offlineServices: [] },
      initialTopology: snapshotSessionServiceTopology(),
    };
  },
  (_ctx, input) => {
    const calls = [];
    const host = runtimeTopologyHost(input, calls);
    const changed = runtimeState.loadOfflineServices(host);
    return { changed, host: { offlineServices: host.offlineServices }, topology: snapshotSessionServiceTopology(), calls };
  },
);

await record(
  cases,
  "loadOfflineServices does not confuse same-id pending session actions with services",
  "loadOfflineServices",
  "load-services-session-pending",
  ({ projectRoot }) => {
    topologyServices.upsertTopologyService(
      { id: "service-1", label: "shell", launchCommandLine: "yarn shell", worktreePath: projectRoot },
      "stopped",
      { projectRoot },
    );
    return {
      projectRoot,
      pendingSessionActions: { "service-1": "starting" },
      host: { offlineServices: [] },
      initialTopology: snapshotSessionServiceTopology(),
    };
  },
  (_ctx, input) => {
    const calls = [];
    const host = runtimeTopologyHost(input, calls);
    const changed = runtimeState.loadOfflineServices(host);
    return { changed, host: { offlineServices: host.offlineServices }, topology: snapshotSessionServiceTopology(), calls };
  },
);

await record(
  cases,
  "loadOfflineServices demotes crash-orphaned running services to stopped",
  "loadOfflineServices",
  "load-services-demote",
  ({ projectRoot }) => {
    topologyServices.upsertTopologyService(
      {
        id: "service-orphan",
        label: "web",
        launchCommandLine: "yarn web",
        worktreePath: projectRoot,
        tmuxTarget: { sessionName: "aimux-repo", windowId: "@3", windowIndex: 3, windowName: "web" },
      },
      "running",
      { projectRoot },
    );
    return { projectRoot, host: { offlineServices: [] }, initialTopology: snapshotSessionServiceTopology() };
  },
  (_ctx, input) => {
    const calls = [];
    const host = runtimeTopologyHost(input, calls);
    const changed = runtimeState.loadOfflineServices(host);
    return { changed, host: { offlineServices: host.offlineServices }, topology: snapshotSessionServiceTopology(), calls };
  },
);

await record(
  cases,
  "reconcileOrphanedTopologyServices leaves a mid-launch service untouched",
  "reconcileOrphanedTopologyServices",
  "reconcile-services-pending",
  ({ projectRoot }) => {
    topologyServices.upsertTopologyService({ id: "service-starting", label: "web", worktreePath: projectRoot }, "starting", {
      projectRoot,
    });
    return {
      projectRoot,
      pendingServiceActions: { "service-starting": "starting" },
      host: { offlineServices: [] },
      initialTopology: snapshotSessionServiceTopology(),
    };
  },
  (_ctx, input) => {
    const calls = [];
    const host = runtimeTopologyHost(input, calls);
    const changed = runtimeState.reconcileOrphanedTopologyServices(host);
    return { changed, host: { offlineServices: host.offlineServices }, topology: snapshotSessionServiceTopology(), calls };
  },
);

await record(
  cases,
  "buildLiveServiceStates projects alive service windows and dedupes by service id",
  "buildLiveServiceStates",
  "live-service-states",
  ({ projectRoot }) => ({
    projectRoot,
    liveWindows: [
      {
        target: { sessionName: "aimux-repo", windowId: "@7", windowIndex: 7, windowName: "web" },
        metadata: {
          kind: "service",
          sessionId: "service-live",
          command: "yarn",
          args: ["web"],
          label: "web",
          createdAt: "2026-05-01T00:00:00.000Z",
          worktreePath: projectRoot,
        },
      },
      {
        target: { sessionName: "aimux-repo", windowId: "@8", windowIndex: 8, windowName: "web-duplicate" },
        metadata: {
          kind: "service",
          sessionId: "service-live",
          command: "yarn",
          args: ["web"],
          label: "web duplicate",
          worktreePath: projectRoot,
        },
      },
      {
        target: { sessionName: "aimux-repo", windowId: "@9", windowIndex: 9, windowName: "agent" },
        metadata: { kind: "agent", sessionId: "codex-1", command: "codex", worktreePath: projectRoot },
      },
    ],
    displayPaths: { "@7": `${projectRoot}/app` },
    host: { offlineServices: [] },
    initialTopology: snapshotSessionServiceTopology(),
  }),
  (_ctx, input) => {
    const calls = [];
    const host = runtimeTopologyHost(input, calls);
    const services = runtimeState.buildLiveServiceStates(host);
    return { services, calls };
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/runtime-state.test.ts",
  generatedBy: "scripts/capture-multiplexer-runtime-state-methods-contract.mjs",
  description:
    "Multiplexer runtime-state state transition contracts for dashboard removal adjustment, stop-to-offline topology persistence, graveyard session mutation, live tmux metadata checks, topology reconciliation, offline loads, and live service projections captured by running TypeScript runtime-state helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
