#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
  reconcileAgentActivity,
  resolveRunningSession,
  stripSgr,
} = await import(new URL("dist/multiplexer/session-runtime-core.js", ROOT));
const { attentionScore, describeHandoffState, getPreferredThreadIndexForParticipant } = await import(
  new URL("dist/multiplexer/subscreens.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const cwd = process.cwd();

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

function normalizeValue(value) {
  return JSON.parse(JSON.stringify(value).split(cwd).join("<REPO>"));
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
