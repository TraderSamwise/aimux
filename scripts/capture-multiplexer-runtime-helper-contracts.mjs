#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/runtime-helpers.json", ROOT);

const { dashboardProjectRoot, handleDashboardSubscreenNavigationKey, pruneRuntimeGuardRepairAttempts } = await import(
  new URL("dist/multiplexer/dashboard-control.js", ROOT)
);
const {
  basenameForHost,
  renderSessionDetails,
  truncateAnsiForHost,
  truncatePlainForHost,
  wrapKeyValueForHost,
  wrapTextForHost,
} = await import(new URL("dist/multiplexer/dashboard-ops.js", ROOT));
const {
  deriveAimuxSessionIdFromBackendSessionId,
  getScopedSessionEntries,
  getSessionWorktreePath,
  getSessionsByWorktree,
  injectCodexDeveloperInstructions,
  resolveDefaultScribeLaunch,
  summarizeLaunchArgs,
} = await import(new URL("dist/multiplexer/session-launch.js", ROOT));
const {
  applyDashboardSessionLabel,
  applySessionLabel,
  getSessionLabel,
  handleSessionRuntimeEvent,
  reconcileAgentActivity,
  registerManagedSession,
  resolveLiveSessionTmuxTarget,
  resolveRunningSession,
  stripSgr,
  updateContextWatcherSessions,
} = await import(new URL("dist/multiplexer/session-runtime-core.js", ROOT));
const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { listTopologySessionStates } = await import(new URL("dist/runtime-core/topology-sessions.js", ROOT));
const { attentionScore, describeHandoffState, getPreferredThreadIndexForParticipant } = await import(
  new URL("dist/multiplexer/subscreens.js", ROOT)
);

const FIXED_NOW = 1_700_000_000_000;
Date.now = () => FIXED_NOW;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const cwd = process.cwd();
await initPaths(cwd);

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function mapFromPairs(pairs) {
  return new Map(pairs ?? []);
}

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))));
}

function normalizeTargetMap(map) {
  return Object.fromEntries(
    [...map.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([key, value]) => [key, value ?? null]),
  );
}

function callLogHost(methods) {
  const calls = [];
  const host = {};
  for (const name of methods) {
    host[name] = (...args) => {
      calls.push({ method: name, args: clone(args) });
    };
  }
  return { host, calls };
}

function record(cases, name, source, api, input, run) {
  const normalizedInput = normalizeValue(input);
  const output = normalizeValue(run(clone(input)));
  cases.push({
    id: `multiplexer-runtime-helpers-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source,
    api,
    input: normalizedInput,
    output,
    inputSha256: hash(normalizedInput),
  });
}

async function recordAsync(cases, name, source, api, input, run) {
  const normalizedInput = normalizeValue(input);
  const output = normalizeValue(await run(clone(input)));
  cases.push({
    id: `multiplexer-runtime-helpers-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source,
    api,
    input: normalizedInput,
    output,
    inputSha256: hash(normalizedInput),
  });
}

function normalizeValue(value) {
  return JSON.parse(JSON.stringify(value).split(cwd).join("<REPO>"));
}

function createRuntimeCoreTargetHost(input) {
  const calls = [];
  const sessionTmuxTargets = mapFromPairs(input.sessionTmuxTargets);
  const resolvedTargets = new Map((input.resolvedTargets ?? []).map(([key, value]) => [key, value]));
  const metadataByWindow = new Map((input.metadataByWindow ?? []).map(([key, value]) => [key, value]));
  const host = {
    projectRoot: input.projectRoot,
    sessions: clone(input.sessions ?? []),
    sessionToolKeys: mapFromPairs(input.sessionToolKeys),
    sessionTmuxTargets,
    tmuxRuntimeManager: {
      getTargetByWindowId(sessionName, windowId) {
        calls.push({ method: "getTargetByWindowId", args: [sessionName, windowId] });
        if (input.throwOnGetTarget) throw new Error("target lookup failed");
        return resolvedTargets.has(windowId) ? clone(resolvedTargets.get(windowId)) : null;
      },
      getWindowMetadata(target) {
        calls.push({ method: "getWindowMetadata", args: [clone(target)] });
        return clone(metadataByWindow.get(target?.windowId) ?? null);
      },
      listProjectManagedWindows(projectRoot) {
        calls.push({ method: "listProjectManagedWindows", args: [projectRoot] });
        return clone(input.projectWindows ?? []);
      },
      isWindowAlive(target) {
        calls.push({ method: "isWindowAlive", args: [clone(target)] });
        return target?.alive !== false;
      },
    },
  };
  return { host, calls };
}

function resolveLiveSessionTmuxTargetFixture(input) {
  return input.scenarios.map((scenario) => {
    const { host, calls } = createRuntimeCoreTargetHost(scenario);
    const result = resolveLiveSessionTmuxTarget(host, scenario.sessionId, scenario.fallback);
    return {
      name: scenario.name,
      result: result ?? null,
      sessionTmuxTargets: normalizeTargetMap(host.sessionTmuxTargets),
      calls,
    };
  });
}

function updateContextWatcherFixture(input) {
  return input.scenarios.map((scenario) => {
    const { host, calls } = createRuntimeCoreTargetHost(scenario);
    const updates = [];
    host.contextWatcher = {
      updateSessions(sessions) {
        updates.push(
          sessions.map((session) => ({
            ...session,
            turnPatterns: session.turnPatterns?.map((pattern) => pattern.toString()),
            tmuxTarget: session.tmuxTarget ?? null,
          })),
        );
      },
      start() {
        calls.push({ method: "contextWatcher.start", args: [] });
      },
    };
    updateContextWatcherSessions(host);
    return {
      name: scenario.name,
      updates,
      sessionTmuxTargets: normalizeTargetMap(host.sessionTmuxTargets),
      calls,
    };
  });
}

function registerManagedSessionFixture(input) {
  return input.scenarios.map((scenario) => {
    const calls = [];
    const listeners = {};
    const transport = {
      id: scenario.transport.id,
      command: scenario.transport.command,
      backendSessionId: scenario.transport.backendSessionId,
      exited: scenario.transport.exited ?? false,
      exitCode: scenario.transport.exitCode,
      status: scenario.transport.status ?? "running",
      write() {},
      resize() {},
      kill() {},
      destroy() {},
      onData(cb) {
        listeners.data = cb;
      },
      onExit(cb) {
        listeners.exit = cb;
      },
    };
    const sessions = clone(scenario.sessions ?? []);
    if (scenario.expectExisting && sessions[0]) {
      sessions[0].transport = transport;
    }
    const host = {
      sessions,
      offlineSessions: clone(scenario.offlineSessions ?? []),
      sessionToolKeys: mapFromPairs(scenario.sessionToolKeys),
      sessionOriginalArgs: mapFromPairs(scenario.sessionOriginalArgs),
      sessionWorktreePaths: mapFromPairs(scenario.sessionWorktreePaths),
      sessionRoles: mapFromPairs(scenario.sessionRoles),
      sessionLabels: mapFromPairs(scenario.sessionLabels),
      updateContextWatcherSessions() {
        calls.push({ method: "updateContextWatcherSessions", args: [] });
      },
      contextWatcher: {
        start() {
          calls.push({ method: "contextWatcher.start", args: [] });
        },
      },
      handleSessionRuntimeEvent(runtime, event) {
        calls.push({ method: "handleSessionRuntimeEvent", args: [runtime.id, clone(event)] });
      },
    };
    const beforeSessionCount = host.sessions.length;
    const runtime = registerManagedSession(
      host,
      transport,
      scenario.args ?? [],
      scenario.toolConfigKey,
      scenario.worktreePath,
      scenario.role,
      scenario.startTime,
      scenario.team,
    );
    if (scenario.emitData) listeners.data?.(scenario.emitData);
    if (Number.isInteger(scenario.emitExitCode)) listeners.exit?.(scenario.emitExitCode);
    return {
      name: scenario.name,
      returnedExisting: Boolean(scenario.expectExisting && host.sessions.length === beforeSessionCount),
      runtime: {
        id: runtime.id,
        command: runtime.command,
        backendSessionId: runtime.backendSessionId ?? null,
        status: runtime.status,
        startTime: runtime.startTime ?? null,
        team: runtime.team ?? null,
      },
      sessions: host.sessions.map((session) => session.id),
      sessionToolKeys: mapToObject(host.sessionToolKeys),
      sessionOriginalArgs: mapToObject(host.sessionOriginalArgs),
      sessionWorktreePaths: mapToObject(host.sessionWorktreePaths),
      sessionRoles: mapToObject(host.sessionRoles),
      sessionLabels: mapToObject(host.sessionLabels),
      calls,
    };
  });
}

async function handleSessionRuntimeEventFixture(input) {
  const outputs = [];
  for (const scenario of input.scenarios) {
    const root = mkdtempSync(join(tmpdir(), "aimux-runtime-core-event-"));
    const repoRoot = join(root, "repo");
    const aimuxHome = join(root, "home");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(aimuxHome, { recursive: true });
    process.env.AIMUX_HOME = aimuxHome;
    await initPaths(repoRoot);
    const recording = scenario.recording;
    if (recording) {
      const dir = join(repoRoot, ".aimux", "recordings");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${scenario.runtime.id}.log`), recording);
    }
    const calls = [];
    const runtime = clone(scenario.runtime);
    const host = {
      mode: scenario.host.mode,
      projectRoot: repoRoot,
      sessions: [runtime, ...clone(scenario.host.extraSessions ?? [])],
      offlineSessions: clone(scenario.host.offlineSessions ?? []),
      stoppingSessionIds: new Set(scenario.host.stoppingSessionIds ?? []),
      graveyardAfterStopSessionIds: new Set(scenario.host.graveyardAfterStopSessionIds ?? []),
      sessionOriginalArgs: mapFromPairs(scenario.host.sessionOriginalArgs),
      sessionToolKeys: mapFromPairs(scenario.host.sessionToolKeys),
      sessionWorktreePaths: mapFromPairs(scenario.host.sessionWorktreePaths),
      sessionTmuxTargets: mapFromPairs(scenario.host.sessionTmuxTargets),
      startedInDashboard: scenario.host.startedInDashboard ?? false,
      activeIndex: scenario.host.activeIndex ?? 0,
      unpreservedExitedSessionIds: new Set(),
      getSessionLabel(sessionId) {
        calls.push({ method: "getSessionLabel", args: [sessionId] });
        return scenario.host.labels?.[sessionId];
      },
      deriveHeadline(sessionId) {
        calls.push({ method: "deriveHeadline", args: [sessionId] });
        return scenario.host.headlines?.[sessionId];
      },
      updateContextWatcherSessions() {
        calls.push({ method: "updateContextWatcherSessions", args: [] });
      },
      loadOfflineTopologySessions() {
        calls.push({ method: "loadOfflineTopologySessions", args: [] });
      },
      writeStatuslineFile() {
        calls.push({ method: "writeStatuslineFile", args: [] });
      },
      saveState() {
        calls.push({ method: "saveState", args: [] });
      },
      renderDashboard() {
        calls.push({ method: "renderDashboard", args: [] });
      },
      resolveRun(code) {
        calls.push({ method: "resolveRun", args: [code] });
      },
      publishAlert(alert) {
        calls.push({ method: "publishAlert", args: [clone(alert)] });
      },
      debug(message, scope) {
        calls.push({ method: "debug", args: [message, scope] });
      },
    };
    try {
      handleSessionRuntimeEvent(host, runtime, clone(scenario.event));
      outputs.push({
        name: scenario.name,
        sessions: host.sessions.map((session) => session.id),
        offlineSessions: host.offlineSessions,
        stoppingSessionIds: [...host.stoppingSessionIds].sort(),
        graveyardAfterStopSessionIds: [...host.graveyardAfterStopSessionIds].sort(),
        sessionTmuxTargets: normalizeTargetMap(host.sessionTmuxTargets),
        activeIndex: host.activeIndex,
        footerFlash: host.footerFlash ?? null,
        footerFlashTicks: host.footerFlashTicks ?? null,
        unpreservedExitedSessionIds: [...host.unpreservedExitedSessionIds].sort(),
        topology: listTopologySessionStates({ statuses: ["offline"] }).map((session) => ({
          ...session,
          updatedAt: session.updatedAt ? "<NOW>" : session.updatedAt,
        })),
        calls,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  return outputs;
}

const cases = [];

record(
  cases,
  "trims explicit project root and falls back to current working directory",
  "src/multiplexer/dashboard-control.test.ts",
  "dashboardProjectRoot",
  { hosts: [{ projectRoot: "  /repo/worktree  " }, { projectRoot: "   " }, {}] },
  (input) => input.hosts.map((host) => dashboardProjectRoot(host)),
);

record(
  cases,
  "keeps only runtime guard repair attempts inside the flap window",
  "src/multiplexer/dashboard-control.test.ts",
  "pruneRuntimeGuardRepairAttempts",
  { attempts: [1_000, 40_000, 119_999, 120_000, 120_001, 160_000], now: 160_000 },
  (input) => pruneRuntimeGuardRepairAttempts(input.attempts, input.now),
);

record(
  cases,
  "routes dashboard subscreen navigation keys and records side effects",
  "src/multiplexer/dashboard-control.test.ts",
  "handleDashboardSubscreenNavigationKey",
  {
    scenarios: [
      { key: "d", currentScreen: "coordination" },
      { key: "c", currentScreen: "coordination" },
      { key: "c", currentScreen: "graveyard" },
      { key: "p", currentScreen: "library" },
      { key: "l", currentScreen: "library", event: { shift: true, name: "l", sequence: "L" } },
      { key: "t", currentScreen: "project" },
      { key: "g", currentScreen: "topology" },
      { key: "x", currentScreen: "topology" },
    ],
  },
  (input) =>
    input.scenarios.map((scenario) => {
      const { host, calls } = callLogHost([
        "showCoordination",
        "showProject",
        "showLibrary",
        "showTopology",
        "showGraveyard",
        "renderDashboard",
        "writeDashboardClientStatuslineFile",
        "persistDashboardUiState",
      ]);
      host.mode = "dashboard";
      host.activeIndex = 0;
      host.getDashboardSessions = () => [{ id: "codex-1" }];
      host.getDashboardServices = () => [];
      host.dashboardState = {
        screen: scenario.currentScreen,
        level: "worktrees",
        focusedWorktreePath: "/repo",
        hideOfflineAgents: false,
        worktreeSessions: [],
        worktreeEntries: [],
        sessionIndex: 0,
        setScreen(screen) {
          calls.push({ method: "dashboardState.setScreen", args: [screen] });
          this.screen = screen;
        },
      };
      host.tmuxRuntimeManager = { refreshStatus: () => calls.push({ method: "tmuxRuntimeManager.refreshStatus", args: [] }) };
      const handled = handleDashboardSubscreenNavigationKey(host, scenario.key, scenario.currentScreen, scenario.event);
      return { scenario, handled, screen: host.dashboardState.screen, calls };
    }),
);

record(
  cases,
  "renders session details and terminal-safe text helpers",
  "src/multiplexer/dashboard-ops.test.ts",
  "renderSessionDetails+textHelpers",
  {
    session: {
      id: "codex-1",
      command: "codex",
      toolConfigKey: "codex-review",
      label: "Reviewer",
      backendSessionId: "backend-123",
      worktreeName: "feature",
      worktreeBranch: "rust-port",
      cwd: "/repo/.aimux/worktrees/feature",
      prNumber: 42,
      prTitle: "Fixture parity",
      prUrl: "https://github.example/pull/42",
      repoOwner: "sam",
      repoName: "aimux",
      repoRemote: "git@example.com:sam/aimux.git",
      semantic: {
        presentation: { statusLabel: "Needs input" },
        user: { attention: "needs_input" },
        notifications: { unreadCount: 2, latestText: "approve command" },
        activityNewCount: 3,
      },
      lastEvent: { message: "wrote parser fix" },
      threadName: "Parser parity",
      threadUnreadCount: 1,
      threadWaitingOnMeCount: 2,
      threadWaitingOnThemCount: 0,
      threadPendingCount: 1,
      services: [{ url: "http://localhost:3000" }, { port: 4317 }],
    },
    width: 44,
    height: 18,
    text: "This is a long line that should wrap across terminal columns",
    ansi: "\u001b[31mred text that truncates\u001b[0m",
  },
  (input) => ({
    details: renderSessionDetails({}, input.session, input.width, input.height),
    wrapKeyValue: wrapKeyValueForHost("Path", "/repo/.aimux/worktrees/feature/subdir", 32),
    wrapText: wrapTextForHost(input.text, 18),
    truncatePlain: truncatePlainForHost(input.text, 24),
    truncateAnsi: truncateAnsiForHost(input.ansi, 12),
    basename: basenameForHost("/repo/.aimux/worktrees/feature"),
  }),
);

record(
  cases,
  "resolves default scribe launch from config variants",
  "src/multiplexer/session-launch.test.ts",
  "resolveDefaultScribeLaunch",
  {
    configs: [
      { scribe: { defaultAgent: null }, tools: {} },
      { scribe: { defaultAgent: "codex" }, tools: {} },
      { scribe: { defaultAgent: "codex" }, tools: { codex: { command: "codex", args: ["--model", "gpt-5"], enabled: false } } },
      {
        scribe: { defaultAgent: { tool: "codex", extraArgs: ["--profile", "scribe"], env: { TEAM: "scribe" } } },
        tools: {
          codex: {
            command: "codex",
            args: ["--model", "gpt-5"],
            enabled: true,
            defaultArgs: ["--sandbox", "workspace-write"],
            defaultEnv: { AIMUX_TOOL: "codex" },
            sessionIdFlag: ["--session-id", "{sessionId}"],
            preambleFlag: ["--append-system-prompt"],
          },
        },
      },
    ],
  },
  (input) => input.configs.map((config) => resolveDefaultScribeLaunch(config)),
);

record(
  cases,
  "derives backend session IDs, redacts launch args, and injects Codex instructions before positional prompts",
  "src/multiplexer/session-launch.test.ts",
  "deriveAimuxSessionIdFromBackendSessionId+summarizeLaunchArgs+injectCodexDeveloperInstructions",
  {
    backendCases: [
      { command: "/usr/local/bin/codex", backendSessionId: "ABC-def_123456", existingIds: [] },
      {
        command: "claude",
        backendSessionId: "ABC-def_1234567890abcdef",
        existingIds: ["claude-abcdef", "claude-abcdef1", "claude-abcdef12", "claude-abcdef123"],
      },
      { command: "codex", backendSessionId: "!!!", existingIds: [] },
    ],
    launchArgs: [
      "--model",
      "gpt-5",
      "--api-token",
      "super-secret",
      "AIMUX_TOKEN=abc123",
      "--password=hunter2",
      "x".repeat(130),
    ],
    codexArgs: ["--model", "gpt-5", "--sandbox", "workspace-write", "Implement the parser"],
    developerKey: "developer_instructions",
    instructions: "Follow AGENTS.md",
  },
  (input) => ({
    ids: input.backendCases.map((c) =>
      deriveAimuxSessionIdFromBackendSessionId(c.command, c.backendSessionId, c.existingIds),
    ),
    summarized: summarizeLaunchArgs(input.launchArgs),
    injected: injectCodexDeveloperInstructions(input.codexArgs, input.developerKey, input.instructions),
    blankInjection: injectCodexDeveloperInstructions(input.codexArgs, "", input.instructions),
  }),
);

record(
  cases,
  "groups launch sessions by worktree and filters project-control sessions",
  "src/multiplexer/session-launch.test.ts",
  "getSessionsByWorktree+getScopedSessionEntries+getSessionWorktreePath",
  {
    sessions: [
      { id: "codex-1", command: "codex" },
      { id: "overseer-1", command: "claude", team: { role: "overseer", projectControl: true } },
      { id: "claude-1", command: "claude" },
      { id: "scribe-1", command: "codex", team: { role: "scribe", projectControl: true } },
    ],
    worktreePairs: [
      ["codex-1", "/repo/.aimux/worktrees/a"],
      ["overseer-1", "/repo"],
      ["claude-1", "/repo/.aimux/worktrees/a"],
    ],
  },
  (input) => {
    const host = { sessions: clone(input.sessions), sessionWorktreePaths: mapFromPairs(input.worktreePairs) };
    return {
      worktreePath: getSessionWorktreePath(host, "codex-1"),
      groups: [...getSessionsByWorktree(host).entries()].map(([path, sessions]) => ({
        path: path ?? null,
        ids: sessions.map((session) => session.id),
      })),
      scoped: getScopedSessionEntries(host).map(({ session, index }) => ({ id: session.id, index })),
    };
  },
);

record(
  cases,
  "applies and resolves session labels across live and offline caches",
  "src/multiplexer/session-runtime-core.test.ts",
  "getSessionLabel+applySessionLabel+applyDashboardSessionLabel",
  {
    sessionLabels: [["live-1", "Live Label"]],
    offlineSessions: [{ id: "offline-1", command: "codex", label: "Old Offline" }],
    dashboardSessionsCache: [{ id: "live-1", label: "Old Live" }, { id: "other" }],
    dashboardWorktreeGroupsCache: [{ name: "main", sessions: [{ id: "live-1", label: "Old Group" }, { id: "other" }] }],
    dashboardState: { worktreeSessions: [{ id: "live-1", label: "Old State" }, { id: "other" }] },
  },
  (input) => {
    const host = {
      sessionLabels: mapFromPairs(input.sessionLabels),
      offlineSessions: clone(input.offlineSessions),
      dashboardSessionsCache: clone(input.dashboardSessionsCache),
      dashboardWorktreeGroupsCache: clone(input.dashboardWorktreeGroupsCache),
      dashboardState: clone(input.dashboardState),
    };
    const before = {
      live: getSessionLabel(host, "live-1"),
      offline: getSessionLabel(host, "offline-1"),
      missing: getSessionLabel(host, "missing-1") ?? null,
    };
    applySessionLabel(host, "offline-1", "  New Offline  ");
    applySessionLabel(host, "live-1", " ");
    applyDashboardSessionLabel(host, "live-1", "  New Dashboard  ");
    return {
      before,
      labels: mapToObject(host.sessionLabels),
      offlineSessions: host.offlineSessions,
      dashboardSessionsCache: host.dashboardSessionsCache,
      dashboardWorktreeGroupsCache: host.dashboardWorktreeGroupsCache,
      dashboardState: host.dashboardState,
    };
  },
);

record(
  cases,
  "strips SGR, reconciles activity, and rejects missing or exited sessions",
  "src/multiplexer/session-runtime-core.test.ts",
  "stripSgr+reconcileAgentActivity+resolveRunningSession",
  {
    text: "plain \u001b[1;31mred\u001b[0m text \u001b[38;2;1;2;3mtruecolor\u001b[0m",
    activityCases: [
      { reported: "idle", activityText: "Thinking", paneState: {} },
      { reported: "waiting", activityText: "Thinking", paneState: {} },
      { reported: "idle", activityText: "", paneState: { interruptedVisible: true } },
      { activityText: "Running", paneState: {} },
    ],
    sessions: [{ id: "live-1", command: "codex" }, { id: "exited-1", command: "codex", exited: true }],
  },
  (input) => {
    const host = { sessions: clone(input.sessions) };
    const resolve = (sessionId) => {
      try {
        return { ok: true, value: resolveRunningSession(host, sessionId).id };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    };
    return {
      stripped: stripSgr(input.text),
      activities: input.activityCases.map((c) => reconcileAgentActivity(c.reported, c.activityText || undefined, c.paneState)),
      resolve: [resolve("live-1"), resolve("exited-1"), resolve("missing-1")],
    };
  },
);

record(
  cases,
  "resolves live tmux targets from cache, startup grace, and scanned windows",
  "src/multiplexer/session-runtime-core.test.ts",
  "resolveLiveSessionTmuxTarget",
  {
    scenarios: [
      {
        name: "cached metadata match retargets to resolved target",
        sessionId: "claude-1",
        sessions: [{ id: "claude-1", startTime: FIXED_NOW - 60_000 }],
        sessionTmuxTargets: [["claude-1", { sessionName: "aimux-test", windowId: "@1", windowIndex: 1 }]],
        resolvedTargets: [["@1", { sessionName: "aimux-test", windowId: "@1", windowIndex: 2 }]],
        metadataByWindow: [["@1", { kind: "agent", sessionId: "claude-1" }]],
      },
      {
        name: "metadata-less just-created target stays valid during startup grace",
        sessionId: "claude-new",
        sessions: [{ id: "claude-new", startTime: FIXED_NOW }],
        sessionTmuxTargets: [["claude-new", { sessionName: "aimux-test", windowId: "@2", windowIndex: 1 }]],
        resolvedTargets: [["@2", { sessionName: "aimux-test", windowId: "@2", windowIndex: 3 }]],
        metadataByWindow: [["@2", null]],
      },
      {
        name: "stale cached target is removed before scanned replacement is adopted",
        sessionId: "codex-1",
        projectRoot: "/repo/project",
        sessions: [{ id: "codex-1", startTime: FIXED_NOW - 60_000 }],
        sessionTmuxTargets: [["codex-1", { sessionName: "aimux-test", windowId: "@3", windowIndex: 1 }]],
        resolvedTargets: [["@3", null]],
        projectWindows: [
          {
            target: { sessionName: "aimux-test", windowId: "@4", windowIndex: 4 },
            metadata: { kind: "agent", sessionId: "other" },
          },
          {
            target: { sessionName: "aimux-test", windowId: "@5", windowIndex: 5, alive: false },
            metadata: { kind: "agent", sessionId: "codex-1" },
          },
          {
            target: { sessionName: "aimux-test", windowId: "@6", windowIndex: 6 },
            metadata: { kind: "agent", sessionId: "codex-1" },
          },
        ],
      },
      {
        name: "cached target with mismatched metadata is rejected",
        sessionId: "claude-wrong",
        sessions: [{ id: "claude-wrong", startTime: FIXED_NOW - 60_000 }],
        sessionTmuxTargets: [["claude-wrong", { sessionName: "aimux-test", windowId: "@7", windowIndex: 7 }]],
        resolvedTargets: [["@7", { sessionName: "aimux-test", windowId: "@7", windowIndex: 7 }]],
        metadataByWindow: [["@7", { kind: "agent", sessionId: "other" }]],
        projectWindows: [],
      },
      {
        name: "fallback target is returned when manager cannot validate ownership",
        sessionId: "raw-1",
        fallback: { sessionName: "aimux-test", windowId: "@8", windowIndex: 8 },
        sessions: [{ id: "raw-1", startTime: FIXED_NOW - 60_000 }],
        resolvedTargets: [["@8", { sessionName: "aimux-test", windowId: "@8", windowIndex: 8 }]],
        metadataByWindow: [["@8", { kind: "agent", sessionId: "raw-1" }]],
      },
    ],
  },
  resolveLiveSessionTmuxTargetFixture,
);

record(
  cases,
  "projects context watcher sessions with resolved tmux targets and turn patterns",
  "src/multiplexer/session-runtime-core.test.ts",
  "updateContextWatcherSessions",
  {
    scenarios: [
      {
        name: "maps configured tool patterns and live targets",
        projectRoot: "/repo/project",
        sessions: [
          { id: "claude-live", command: "claude" },
          { id: "codex-missing-target", command: "codex" },
        ],
        sessionToolKeys: [
          ["claude-live", "claude"],
          ["codex-missing-target", "codex"],
        ],
        sessionTmuxTargets: [["claude-live", { sessionName: "aimux-test", windowId: "@11", windowIndex: 1 }]],
        resolvedTargets: [["@11", { sessionName: "aimux-test", windowId: "@11", windowIndex: 2 }]],
        metadataByWindow: [["@11", { kind: "agent", sessionId: "claude-live" }]],
        projectWindows: [],
      },
    ],
  },
  updateContextWatcherFixture,
);

record(
  cases,
  "registers managed sessions, restores labels, and keeps teammate roles out of role maps",
  "src/multiplexer/session-runtime-core.test.ts",
  "registerManagedSession",
  {
    scenarios: [
      {
        name: "new teammate session records launch maps and inherited offline label",
        transport: { id: "codex-1", command: "codex", backendSessionId: "backend-1", status: "running" },
        args: ["--model", "gpt-5"],
        toolConfigKey: "codex",
        worktreePath: "/repo/.aimux/worktrees/feature",
        role: "coder",
        startTime: 1234,
        team: { teamId: "team-1", parentSessionId: "parent-1", role: "reviewer" },
        offlineSessions: [{ id: "codex-1", label: "Reviewer" }],
        emitData: "hello",
        emitExitCode: 0,
      },
      {
        name: "existing runtime is returned without mutating host maps",
        expectExisting: true,
        sessions: [{ id: "codex-existing", transportToken: "same-transport" }],
        transport: { id: "codex-existing", command: "codex", status: "idle" },
        sessionRoles: [["codex-existing", "existing-role"]],
        sessionLabels: [["codex-existing", "Existing"]],
      },
    ],
  },
  (input) => {
    input.scenarios[1].sessions[0].transport = input.scenarios[1].transport;
    return registerManagedSessionFixture(input);
  },
);

await recordAsync(
  cases,
  "handles runtime output and exit events without dropping restorable sessions",
  "src/multiplexer/session-runtime-core.test.ts",
  "handleSessionRuntimeEvent",
  {
    scenarios: [
      {
        name: "output event only rewrites statusline",
        runtime: { id: "codex-output", command: "codex", startTime: FIXED_NOW - 60_000 },
        event: { type: "output", data: "hello" },
        host: { mode: "dashboard", startedInDashboard: true },
      },
      {
        name: "last project-service session exits without resolving host run",
        runtime: { id: "claude-last", command: "claude", startTime: FIXED_NOW - 60_000 },
        event: { type: "exit", code: 0 },
        host: {
          mode: "project-service",
          startedInDashboard: false,
          sessionOriginalArgs: [["claude-last", []]],
          sessionToolKeys: [["claude-last", "claude"]],
        },
      },
      {
        name: "non-service last session resolves run",
        runtime: { id: "claude-standalone", command: "claude", startTime: FIXED_NOW - 60_000 },
        event: { type: "exit", code: 0 },
        host: {
          mode: "dashboard",
          startedInDashboard: false,
          sessionOriginalArgs: [["claude-standalone", []]],
          sessionToolKeys: [["claude-standalone", "claude"]],
        },
      },
      {
        name: "quick backend crash is preserved offline but restore-blocked",
        runtime: {
          id: "claude-current-crash",
          command: "claude",
          startTime: FIXED_NOW,
          backendSessionId: "backend-current-crash",
        },
        event: { type: "exit", code: 1 },
        recording: "boot\nError: model not found\n",
        host: {
          mode: "dashboard",
          startedInDashboard: true,
          sessionOriginalArgs: [["claude-current-crash", []]],
          sessionToolKeys: [["claude-current-crash", "claude"]],
          sessionWorktreePaths: [["claude-current-crash", "/repo/project"]],
        },
      },
      {
        name: "quick session without backend id is not preserved",
        runtime: { id: "claude-quick", command: "claude", startTime: FIXED_NOW },
        event: { type: "exit", code: 0 },
        host: {
          mode: "dashboard",
          startedInDashboard: true,
          sessionOriginalArgs: [["claude-quick", []]],
          sessionToolKeys: [["claude-quick", "claude"]],
        },
      },
      {
        name: "stopped codex session without backend id keeps fresh relaunch allowed",
        runtime: { id: "codex-stopped", command: "codex", startTime: FIXED_NOW - 20_000 },
        event: { type: "exit", code: 0 },
        host: {
          mode: "dashboard",
          startedInDashboard: true,
          stoppingSessionIds: ["codex-stopped"],
          sessionOriginalArgs: [["codex-stopped", ["--dangerously-bypass-approvals-and-sandbox"]]],
          sessionToolKeys: [["codex-stopped", "codex"]],
          sessionWorktreePaths: [["codex-stopped", "/repo/project"]],
        },
      },
      {
        name: "teammate metadata is preserved when runtime becomes offline",
        runtime: {
          id: "claude-team-exit",
          command: "claude",
          startTime: FIXED_NOW - 20_000,
          team: { teamId: "team-1", parentSessionId: "parent-1", role: "reviewer" },
        },
        event: { type: "exit", code: 0 },
        host: {
          mode: "dashboard",
          startedInDashboard: true,
          sessionOriginalArgs: [["claude-team-exit", []]],
          sessionToolKeys: [["claude-team-exit", "claude"]],
          sessionWorktreePaths: [["claude-team-exit", "/repo/project"]],
        },
      },
    ],
  },
  handleSessionRuntimeEventFixture,
);

record(
  cases,
  "scores attention, chooses preferred thread, and describes handoff state",
  "src/multiplexer/subscreens.test.ts",
  "attentionScore+getPreferredThreadIndexForParticipant+describeHandoffState",
  {
    attentionInputs: [
      { semantic: { user: { attention: "error" }, notifications: {}, activityNewCount: 0 } },
      { semantic: { user: { attention: "needs_input" }, notifications: {}, activityNewCount: 0 } },
      { semantic: { user: { attention: "none", label: "done" }, notifications: {}, activityNewCount: 0 } },
      { semantic: { user: { attention: "none" }, notifications: { unreadCount: 1 }, activityNewCount: 0 } },
    ],
    participant: "codex-1",
    entries: [
      {
        displayTitle: "Older unread",
        thread: {
          id: "thread-1",
          participants: ["codex-1", "user"],
          owner: "user",
          waitingOn: [],
          unreadBy: ["codex-1"],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      {
        displayTitle: "Waiting on me",
        thread: {
          id: "thread-2",
          participants: ["codex-1", "user"],
          owner: "user",
          waitingOn: ["codex-1"],
          unreadBy: [],
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      },
      {
        displayTitle: "Different participant",
        thread: {
          id: "thread-3",
          participants: ["claude-1", "user"],
          owner: "claude-1",
          waitingOn: ["user"],
          unreadBy: ["user"],
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      },
    ],
    handoffs: [
      { status: "done", owner: "codex-1", createdBy: "user", participants: ["user", "codex-1"], waitingOn: [] },
      { status: "open", owner: "codex-1", createdBy: "user", participants: ["user", "codex-1"], waitingOn: ["user"] },
      { status: "open", owner: "codex-1", createdBy: "user", participants: ["user", "codex-1"], waitingOn: [] },
      { status: "open", createdBy: "user", participants: ["user", "claude-1"], waitingOn: [] },
    ],
  },
  (input) => ({
    scores: input.attentionInputs.map((entry) => attentionScore({}, entry)),
    preferredIndex: getPreferredThreadIndexForParticipant({}, input.participant, input.entries),
    missingIndex: getPreferredThreadIndexForParticipant({}, "missing-1", input.entries),
    handoffStates: input.handoffs.map((thread) => describeHandoffState({}, thread)),
  }),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  sources: [
    "src/multiplexer/dashboard-control.test.ts",
    "src/multiplexer/dashboard-ops.test.ts",
    "src/multiplexer/session-launch.test.ts",
    "src/multiplexer/session-runtime-core.test.ts",
    "src/multiplexer/subscreens.test.ts",
  ],
  subject: "multiplexer dashboard/runtime helper functions",
  generatedBy: "scripts/capture-multiplexer-runtime-helper-contracts.mjs",
  caseCount: cases.length,
  cases,
});
