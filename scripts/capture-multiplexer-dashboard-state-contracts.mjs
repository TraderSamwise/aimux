#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-state-helpers.json", ROOT);

const { refreshGraveyardEntriesFromService } = await import(new URL("dist/multiplexer/archives.js", ROOT));
const { dashboardTailMethods } = await import(new URL("dist/multiplexer/dashboard-tail-methods.js", ROOT));
const { dashboardViewMethods } = await import(new URL("dist/multiplexer/dashboard-view-methods.js", ROOT));
const { persistenceMethods } = await import(new URL("dist/multiplexer/persistence-methods.js", ROOT));
const { buildLiveServiceStates, DASHBOARD_HIDDEN_VISIBILITY_RECHECK_TICKS } = await import(
  new URL("dist/multiplexer/runtime-state.js", ROOT)
);
const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { getWorktreeGitCallCount, resetWorktreeGitCallCount } = await import(new URL("dist/worktree.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const cwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "aimux-dashboard-state-contract-"));
mkdirSync(join(tempRoot, ".git"), { recursive: true });
await initPaths(tempRoot);

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalizeValue(value) {
  return JSON.parse(JSON.stringify(value).split(cwd).join("<REPO>").split(tempRoot).join("<TMP>"));
}

function mapFromPairs(pairs) {
  return new Map(pairs ?? []);
}

function snapshot(host, fields) {
  const out = {};
  for (const field of fields) out[field] = clone(host[field] ?? null);
  return out;
}

function runGit(args, cwd) {
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: "pipe",
  });
}

function createGitFixtureRepo() {
  const repoRoot = join(tempRoot, "repo");
  const worktreeA = join(tempRoot, "wt-alpha");
  const worktreeB = join(tempRoot, "wt-beta");
  mkdirSync(repoRoot, { recursive: true });
  runGit(["init", "-b", "master"], repoRoot);
  runGit(["-c", "user.email=aimux@example.test", "-c", "user.name=Aimux Fixture", "commit", "--allow-empty", "-m", "init"], repoRoot);
  runGit(["worktree", "add", "-b", "alpha", worktreeA], repoRoot);
  runGit(["worktree", "add", "-b", "beta", worktreeB], repoRoot);
  return { repoRoot, worktreeA, worktreeB };
}

function summarizeWorktrees(worktrees) {
  return worktrees.map((worktree) => ({
    name: worktree.name,
    path: worktree.path,
    branch: worktree.branch,
    isBare: worktree.isBare,
    hasCreatedAt: typeof worktree.createdAt === "string" && worktree.createdAt.length > 0,
  }));
}

async function record(cases, name, source, api, input, run) {
  const normalizedInput = normalizeValue(input);
  const output = normalizeValue(await run(clone(input)));
  cases.push({
    id: `multiplexer-dashboard-state-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source,
    api,
    input: normalizedInput,
    output,
    inputSha256: hash(normalizedInput),
  });
}

function graveyardPayload() {
  const agent = {
    id: "codex-old",
    tool: "codex",
    command: "codex",
    status: "graveyard",
    reason: "stale runtime",
  };
  const worktree = {
    name: "feature-old",
    path: "/repo/.aimux/worktrees/feature-old",
    branch: "feature-old",
    status: "graveyard",
  };
  const agentRow = { kind: "orphan-agent", entry: agent, actionIndex: 0, actionNumber: 1 };
  const worktreeRow = { kind: "worktree", entry: worktree, actionIndex: 1, actionNumber: 2 };
  return {
    ok: true,
    entries: [agent],
    worktrees: [worktree],
    viewModel: {
      rows: [{ kind: "section", label: "Orphaned Agents" }, agentRow, { kind: "section", label: "Worktrees" }, worktreeRow],
      selectableRows: [agentRow, worktreeRow],
    },
  };
}

const cases = [];

await record(
  cases,
  "refreshes graveyard view model from project service without rebuilding local stores",
  "src/multiplexer/archives.test.ts",
  "refreshGraveyardEntriesFromService",
  { initialHost: { graveyardIndex: -1 }, servicePayload: graveyardPayload(), isDashboardScreen: false },
  async (input) => {
    const calls = [];
    const host = {
      ...clone(input.initialHost),
      getFromProjectService: async (path, opts) => {
        calls.push({ method: "getFromProjectService", args: [path, opts] });
        return clone(input.servicePayload);
      },
      isDashboardScreen: (screen) => {
        calls.push({ method: "isDashboardScreen", args: [screen] });
        return input.isDashboardScreen;
      },
    };
    const returned = await refreshGraveyardEntriesFromService(host);
    return {
      returned,
      host: snapshot(host, ["graveyardEntries", "worktreeGraveyardEntries", "graveyardViewModel", "graveyardIndex"]),
      calls,
    };
  },
);

await record(
  cases,
  "initializes empty graveyard model for invalid first service payload",
  "src/multiplexer/archives.test.ts",
  "refreshGraveyardEntriesFromService",
  { initialHost: {}, servicePayload: { ok: true, entries: [], worktrees: [] } },
  async (input) => {
    const calls = [];
    const host = {
      ...clone(input.initialHost),
      getFromProjectService: async (path, opts) => {
        calls.push({ method: "getFromProjectService", args: [path, opts] });
        return clone(input.servicePayload);
      },
    };
    const returned = await refreshGraveyardEntriesFromService(host);
    return {
      returned,
      host: snapshot(host, ["graveyardEntries", "worktreeGraveyardEntries", "graveyardViewModel", "graveyardIndex"]),
      calls,
    };
  },
);

await record(
  cases,
  "selects cached dashboard sessions, services, and visual session order",
  "src/multiplexer/dashboard-tail-methods.test.ts",
  "dashboardTailMethods.getDashboardSessions+getDashboardServices+getDashboardSessionsInVisualOrder",
  {
    host: {
      mode: "dashboard",
      dashboardState: { hideOfflineAgents: true },
      dashboardSessionsCache: [
        { id: "main-1", status: "running" },
        { id: "wt-late", status: "running", worktreePath: "/repo/wt" },
        { id: "offline-1", status: "offline", worktreePath: "/repo/wt" },
        { id: "wt-first", status: "idle", worktreePath: "/repo/wt" },
      ],
      dashboardServicesCache: [{ id: "svc-1", status: "running" }],
      dashboardWorktreeGroupsCache: [{ path: "/repo/wt", sessions: [{ id: "wt-first", status: "idle", worktreePath: "/repo/wt" }] }],
    },
  },
  (input) => {
    const host = clone(input.host);
    host.getDashboardSessions = dashboardTailMethods.getDashboardSessions;
    host.getDashboardServices = dashboardTailMethods.getDashboardServices;
    return {
      sessions: dashboardTailMethods.getDashboardSessions.call(host),
      services: dashboardTailMethods.getDashboardServices.call(host),
      visualOrder: dashboardTailMethods.getDashboardSessionsInVisualOrder.call(host).map((session) => session.id),
    };
  },
);

await record(
  cases,
  "delegates project-service dashboard tail selectors to compute methods",
  "src/multiplexer/dashboard-tail-methods.test.ts",
  "dashboardTailMethods.getDashboardSessions+getDashboardServices",
  { host: { mode: "project-service", computedSessions: [{ id: "computed-1" }], computedServices: [{ id: "service-computed" }] } },
  (input) => {
    const calls = [];
    const host = {
      mode: input.host.mode,
      computeDashboardSessions: () => {
        calls.push({ method: "computeDashboardSessions", args: [] });
        return clone(input.host.computedSessions);
      },
      computeDashboardServices: () => {
        calls.push({ method: "computeDashboardServices", args: [] });
        return clone(input.host.computedServices);
      },
    };
    return {
      sessions: dashboardTailMethods.getDashboardSessions.call(host),
      services: dashboardTailMethods.getDashboardServices.call(host),
      calls,
    };
  },
);

const gitFixture = createGitFixtureRepo();

await record(
  cases,
  "orders non-dashboard sessions by discovered main checkout and worktree paths",
  "src/multiplexer/dashboard-tail-methods.test.ts",
  "dashboardTailMethods.getDashboardSessionsInVisualOrder",
  {
    cwd: gitFixture.repoRoot,
    host: {
      mode: "project-service",
      computedSessions: [
        { id: "beta", status: "running", worktreePath: gitFixture.worktreeB },
        { id: "main-explicit", status: "running", worktreePath: gitFixture.repoRoot },
        { id: "unknown", status: "running", worktreePath: join(tempRoot, "outside") },
        { id: "alpha", status: "idle", worktreePath: gitFixture.worktreeA },
        { id: "main-implicit", status: "running" },
      ],
    },
  },
  (input) => {
    const originalCwd = process.cwd();
    const calls = [];
    const host = {
      mode: input.host.mode,
      getDashboardSessions: dashboardTailMethods.getDashboardSessions,
      computeDashboardSessions: () => {
        calls.push({ method: "computeDashboardSessions", args: [] });
        return clone(input.host.computedSessions);
      },
    };
    process.chdir(input.cwd);
    resetWorktreeGitCallCount();
    try {
      return {
        visualOrder: dashboardTailMethods.getDashboardSessionsInVisualOrder.call(host).map((session) => session.id),
        gitCallCount: getWorktreeGitCallCount(),
        calls,
      };
    } finally {
      process.chdir(originalCwd);
    }
  },
);

await record(
  cases,
  "keeps non-dashboard visual order when git worktree discovery is unavailable",
  "src/multiplexer/dashboard-tail-methods.test.ts",
  "dashboardTailMethods.getDashboardSessionsInVisualOrder",
  {
    cwd: tempRoot,
    host: {
      mode: "project-service",
      computedSessions: [
        { id: "first", status: "running", worktreePath: "/missing/a" },
        { id: "second", status: "offline" },
      ],
    },
  },
  (input) => {
    const originalCwd = process.cwd();
    const calls = [];
    const host = {
      mode: input.host.mode,
      getDashboardSessions: dashboardTailMethods.getDashboardSessions,
      computeDashboardSessions: () => {
        calls.push({ method: "computeDashboardSessions", args: [] });
        return clone(input.host.computedSessions);
      },
    };
    process.chdir(input.cwd);
    resetWorktreeGitCallCount();
    try {
      return {
        visualOrder: dashboardTailMethods.getDashboardSessionsInVisualOrder.call(host).map((session) => session.id),
        gitCallCount: getWorktreeGitCallCount(),
        calls,
      };
    } finally {
      process.chdir(originalCwd);
    }
  },
);

await record(
  cases,
  "lists git worktrees through the dashboard tail delegate",
  "src/multiplexer/dashboard-tail-methods.test.ts",
  "dashboardTailMethods.listAllWorktrees",
  { cwd: gitFixture.repoRoot },
  (input) => {
    const originalCwd = process.cwd();
    process.chdir(input.cwd);
    resetWorktreeGitCallCount();
    try {
      return {
        worktrees: summarizeWorktrees(dashboardTailMethods.listAllWorktrees.call({})),
        gitCallCount: getWorktreeGitCallCount(),
      };
    } finally {
      process.chdir(originalCwd);
    }
  },
);

await record(
  cases,
  "derives dashboard view service labels and pending-settlement options",
  "src/multiplexer/dashboard-view-methods.test.ts",
  "dashboardViewMethods.serviceLabelForCommand+settleDashboardCreatePending+preferDashboardEntrySelection",
  {
    commands: ["yarn dev --host 0.0.0.0", "python -m http.server 8000", "  "],
    settle: {
      itemId: "worktree:/repo/.aimux/worktrees/demo",
      target: "worktree",
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", pending: false }],
    },
  },
  (input) => {
    const calls = [];
    const host = {
      startedInDashboard: true,
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardWorktreeGroupsCache: clone(input.settle.dashboardWorktreeGroupsCache),
      dashboardPendingActions: {
        settleCreatePending: (target, itemId, _onSettled, opts) => {
          calls.push({
            method: "dashboardPendingActions.settleCreatePending",
            args: [target, itemId, { timeoutMs: opts.timeoutMs ?? null, hasIsSettled: typeof opts.isSettled === "function" }],
          });
        },
      },
      dashboardUiStateStore: {
        preferEntrySelection: (...args) => calls.push({ method: "dashboardUiStateStore.preferEntrySelection", args: clone(args) }),
      },
      dashboardState: { screen: "dashboard" },
      getDashboardSessions: () => [],
      getDashboardServices: () => [],
    };
    dashboardViewMethods.settleDashboardCreatePending.call(host, input.settle.itemId, input.settle.target);
    dashboardViewMethods.preferDashboardEntrySelection.call(host, "session", "codex-1", "/repo/wt");
    return {
      labels: input.commands.map((command) => dashboardViewMethods.serviceLabelForCommand.call(host, command)),
      calls,
    };
  },
);

await record(
  cases,
  "centers ANSI text and applies pending worktree projection without mutating source rows",
  "src/multiplexer/persistence-methods.test.ts",
  "persistenceMethods.centerInWidth+stripAnsi+listProjectedDesktopWorktrees",
  {
    text: "\u001b[32mReady\u001b[0m",
    width: 11,
    worktrees: [
      { name: "main", path: "/repo", branch: "main", isBare: false },
      { name: "old", path: "/repo/old", branch: "old", isBare: false },
    ],
  },
  (input) => {
    const host = {
      stripAnsi: persistenceMethods.stripAnsi,
      listDesktopWorktrees: () => clone(input.worktrees),
      dashboardPendingActions: {
        applyToWorktrees: (rows) => [
          ...rows.filter((row) => row.path !== "/repo/old"),
          { name: "new", path: "/repo/new", branch: "new", isBare: false, pending: true, pendingAction: "creating" },
        ],
      },
    };
    return {
      stripped: persistenceMethods.stripAnsi.call(host, input.text),
      centered: persistenceMethods.centerInWidth.call(host, input.text, input.width),
      projected: persistenceMethods.listProjectedDesktopWorktrees.call(host),
      sourceRowsAfterProjection: input.worktrees,
    };
  },
);

await record(
  cases,
  "builds live service states from managed tmux service windows",
  "src/multiplexer/runtime-state.test.ts",
  "buildLiveServiceStates+DASHBOARD_HIDDEN_VISIBILITY_RECHECK_TICKS",
  {
    projectRoot: "/repo",
    windows: [
      {
        target: { sessionName: "aimux-repo", windowId: "@1", windowIndex: 1, windowName: "svc-one" },
        metadata: {
          kind: "service",
          sessionId: "service-1",
          label: "API",
          createdAt: "2026-01-01T00:00:00.000Z",
          launchCommandLine: "yarn dev",
        },
        cwd: "/repo",
        alive: true,
      },
      {
        target: { sessionName: "aimux-repo", windowId: "@2", windowIndex: 2, windowName: "agent" },
        metadata: { kind: "agent", sessionId: "codex-1" },
        cwd: "/repo",
        alive: true,
      },
      {
        target: { sessionName: "aimux-repo", windowId: "@3", windowIndex: 3, windowName: "svc-dead" },
        metadata: { kind: "service", sessionId: "service-dead", launchCommand: { command: "node", args: ["server.js"] } },
        cwd: "/repo",
        alive: false,
      },
    ],
  },
  (input) => {
    const host = {
      projectRoot: input.projectRoot,
      tmuxRuntimeManager: {
        listProjectManagedWindows: () => clone(input.windows).map(({ target, metadata }) => ({ target, metadata })),
        isWindowAlive: (target) => input.windows.find((entry) => entry.target.windowId === target.windowId)?.alive ?? false,
        displayMessage: (_format, windowId) => input.windows.find((entry) => entry.target.windowId === windowId)?.cwd,
      },
    };
    return {
      hiddenVisibilityRecheckTicks: DASHBOARD_HIDDEN_VISIBILITY_RECHECK_TICKS,
      services: buildLiveServiceStates(host),
    };
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  sources: [
    "src/multiplexer/archives.test.ts",
    "src/multiplexer/dashboard-tail-methods.test.ts",
    "src/multiplexer/dashboard-view-methods.test.ts",
    "src/multiplexer/persistence-methods.test.ts",
    "src/multiplexer/runtime-state.test.ts",
  ],
  subject: "multiplexer dashboard state helpers",
  generatedBy: "scripts/capture-multiplexer-dashboard-state-contracts.mjs",
  caseCount: cases.length,
  cases,
});

rmSync(tempRoot, { recursive: true, force: true });
