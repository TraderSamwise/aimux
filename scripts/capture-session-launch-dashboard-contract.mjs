#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/session-launch-dashboard.json", ROOT);

const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { runDashboard } = await import(new URL("dist/multiplexer/session-launch.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function gitInit(cwd) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  execFileSync("git", ["init"], { cwd, stdio: "ignore", env });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function simplifyError(value) {
  if (!value) return null;
  if (value instanceof Error) return value.message;
  return String(value);
}

function normalizeBuffer(value) {
  if (Buffer.isBuffer(value)) return { type: "Buffer", data: [...value] };
  if (Array.isArray(value)) return value.map(normalizeBuffer);
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, nested] of Object.entries(value)) output[key] = normalizeBuffer(nested);
    return output;
  }
  return value;
}

function normalize(value, repoRoot) {
  let normalized = normalizeBuffer(value);
  normalized = JSON.parse(JSON.stringify(normalized).split(repoRoot).join("<REPO>"));
  if (normalized && typeof normalized === "object" && Array.isArray(normalized.calls)) {
    for (const call of normalized.calls) {
      if (call.method !== "tmuxRuntimeManager.setWindowOption") continue;
      if (call.args?.[1] === "@aimux-dashboard-build") call.args[2] = "<DASHBOARD_BUILD_STAMP>";
      if (call.args?.[1] === "@aimux-dashboard-ready") call.args[2] = "<DASHBOARD_BUILD_STAMP>";
      if (call.args?.[1] === "@aimux-dashboard-owner") call.args[2] = "<RUNTIME_OWNER>";
    }
  }
  return normalized;
}

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function recorder(renderSnapshots) {
  const calls = [];
  const fn =
    (method, impl) =>
    (...args) => {
      calls.push({ method, args: clone(normalizeBuffer(args)) });
      return impl?.(...args);
    };
  const render = (host) => {
    calls.push({ method: "renderCurrentDashboardView", args: [] });
    renderSnapshots.push({
      mode: host.mode ?? null,
      screen: host.dashboardState?.screen ?? null,
      inputEpoch: host.dashboardInputEpoch ?? null,
      busy: host.dashboardBusyState
        ? {
            title: host.dashboardBusyState.title ?? null,
            lines: host.dashboardBusyState.lines ?? [],
            spinnerFrame: host.dashboardBusyState.spinnerFrame ?? null,
          }
        : null,
      startupPriming: host.dashboardStartupPriming ?? null,
    });
  };
  return { calls, fn, render };
}

function makeHost(input, repoRoot) {
  const renderSnapshots = [];
  const rec = recorder(renderSnapshots);
  const refreshResponses = [...(input.refreshResponses ?? [{ result: true }])];
  const screen = input.host?.dashboardState?.screen ?? "dashboard";
  const host = {
    projectRoot: repoRoot,
    mode: input.host?.mode ?? "session",
    startedInDashboard: input.host?.startedInDashboard ?? false,
    defaultCommand: input.host?.defaultCommand,
    defaultArgs: input.host?.defaultArgs,
    dashboardInputEpoch: input.host?.dashboardInputEpoch,
    dashboardRunGeneration: input.host?.dashboardRunGeneration,
    dashboardModelServiceRefreshedAt: input.host?.dashboardModelServiceRefreshedAt ?? 0,
    dashboardModelServiceRefreshError: input.host?.dashboardModelServiceRefreshError ?? undefined,
    dashboardState: { screen },
    terminalHost: {
      enterRawMode: rec.fn("terminalHost.enterRawMode"),
      enterAlternateScreen: rec.fn("terminalHost.enterAlternateScreen"),
    },
    tmuxRuntimeManager: {
      setWindowOption: rec.fn("tmuxRuntimeManager.setWindowOption"),
    },
    dashboardCoreCommandRequest: async () => undefined,
    startHeartbeat: rec.fn("startHeartbeat"),
    syncSessionsFromTopology: rec.fn("syncSessionsFromTopology"),
    writeInstructionFiles: rec.fn("writeInstructionFiles"),
    startStatusRefresh: rec.fn("startStatusRefresh"),
    getViewportKey: rec.fn("getViewportKey", () => input.viewportKey ?? "120x40"),
    invalidateDashboardFrame: rec.fn("invalidateDashboardFrame"),
    renderCurrentDashboardView: () => rec.render(host),
    renderDashboard: rec.fn("renderDashboard"),
    loadDashboardUiState: rec.fn("loadDashboardUiState", () => {
      if (input.loadDashboardUiScreen) host.dashboardState.screen = input.loadDashboardUiScreen;
    }),
    hydrateDashboardScreenState: rec.fn("hydrateDashboardScreenState"),
    writeDashboardClientStatuslineFile: rec.fn("writeDashboardClientStatuslineFile"),
    isFocusInReport: rec.fn("isFocusInReport", (data) => data.includes(Buffer.from("\x1b[I"))),
    handleDashboardFocusIn: rec.fn("handleDashboardFocusIn"),
    handleActiveDashboardOverlayKey: rec.fn(
      "handleActiveDashboardOverlayKey",
      () => input.keyHandling?.activeOverlayConsumes === true,
    ),
    handleRuntimeGuardKey: rec.fn("handleRuntimeGuardKey", () => input.keyHandling?.runtimeGuardConsumes === true),
    isDashboardScreen: rec.fn("isDashboardScreen", (candidate) => host.dashboardState.screen === candidate),
    handleCoordinationKey: rec.fn("handleCoordinationKey"),
    handleProjectKey: rec.fn("handleProjectKey"),
    handleLibraryKey: rec.fn("handleLibraryKey"),
    handleTopologyKey: rec.fn("handleTopologyKey"),
    handleHelpKey: rec.fn("handleHelpKey"),
    handleGraveyardKey: rec.fn("handleGraveyardKey"),
    handleDashboardKey: rec.fn("handleDashboardKey"),
    refreshLocalDashboardModel: rec.fn("refreshLocalDashboardModel"),
    ensureDashboardControlPlane: rec.fn("ensureDashboardControlPlane", async () => {
      if (input.ensureEffect === "input") host.dashboardInputEpoch = (host.dashboardInputEpoch ?? 0) + 1;
      if (input.ensureEffect === "generation") host.dashboardRunGeneration = (host.dashboardRunGeneration ?? 0) + 1;
    }),
    showDashboardError: rec.fn("showDashboardError"),
    refreshDashboardModelFromService: rec.fn("refreshDashboardModelFromService", async () => {
      const response = refreshResponses.shift() ?? { result: true };
      if (response.errorMessage !== undefined) host.dashboardModelServiceRefreshError = new Error(response.errorMessage);
      if (response.clearError) host.dashboardModelServiceRefreshError = undefined;
      if (response.refreshedAt !== undefined) host.dashboardModelServiceRefreshedAt = response.refreshedAt;
      return response.result;
    }),
    teardown: rec.fn("teardown", () => {
      if (host.onStdinData) process.stdin.off("data", host.onStdinData);
      if (host.onResize) process.stdout.off("resize", host.onResize);
      if (host.dashboardViewportPollInterval) clearInterval(host.dashboardViewportPollInterval);
      host.tuiProjectEventAdapter?.dispose?.();
      host.tuiProjectEventAdapter = null;
    }),
  };
  return { host, calls: rec.calls, renderSnapshots };
}

async function withProject(input, runCase) {
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-dashboard-"));
  const previousCwd = process.cwd();
  const previousHome = process.env.AIMUX_HOME;
  const previousTmuxPane = process.env.TMUX_PANE;
  const aimuxHome = join(repoRoot, "home");
  try {
    gitInit(repoRoot);
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    mkdirSync(aimuxHome, { recursive: true });
    writeFileSync(join(repoRoot, ".aimux", "config.json"), `${JSON.stringify(input.config ?? {}, null, 2)}\n`);
    process.chdir(repoRoot);
    process.env.AIMUX_HOME = aimuxHome;
    if (input.tmuxPane) process.env.TMUX_PANE = input.tmuxPane;
    else delete process.env.TMUX_PANE;
    await initPaths(repoRoot);
    return normalize(await runCase(repoRoot), repoRoot);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    if (previousTmuxPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = previousTmuxPane;
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

async function runCase(input) {
  return withProject(input, async (repoRoot) => {
    const { host, calls, renderSnapshots } = makeHost(input, repoRoot);
    const pending = runDashboard(host);
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const action of input.actions ?? []) {
      if (action.stdinHex) host.onStdinData(Buffer.from(action.stdinHex, "hex"));
      if (action.setInputEpoch !== undefined) host.dashboardInputEpoch = action.setInputEpoch;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.resolveRun(input.exitCode ?? 0);
    const result = await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      result,
      host: {
        mode: host.mode,
        startedInDashboard: host.startedInDashboard,
        defaultCommand: host.defaultCommand ?? null,
        defaultArgs: host.defaultArgs ?? null,
        dashboardInputEpoch: host.dashboardInputEpoch ?? null,
        dashboardRunGeneration: host.dashboardRunGeneration ?? null,
        dashboardStartupPriming: host.dashboardStartupPriming ?? null,
        dashboardBusyState: host.dashboardBusyState
          ? {
              title: host.dashboardBusyState.title ?? null,
              lines: host.dashboardBusyState.lines ?? [],
              spinnerFrame: host.dashboardBusyState.spinnerFrame ?? null,
            }
          : null,
        dashboardModelServiceRefreshedAt: host.dashboardModelServiceRefreshedAt ?? null,
        dashboardModelServiceRefreshError: simplifyError(host.dashboardModelServiceRefreshError),
        eventStreamStarted: Boolean(host.tuiProjectEventAdapter),
      },
      calls,
      renderSnapshots,
    };
  });
}

const baseConfig = {
  defaultTool: "codex",
  tools: {
    codex: {
      command: "codex",
      args: ["--model", "gpt-5"],
      enabled: true,
    },
  },
  scribe: { defaultAgent: null },
};

const casesInput = [
  {
    name: "runDashboard hydrates restored subscreens and syncs footer state",
    input: {
      config: baseConfig,
      loadDashboardUiScreen: "graveyard",
      refreshResponses: [{ result: true, refreshedAt: 1 }],
    },
  },
  {
    name: "runDashboard lets active overlays own keys before the runtime guard",
    input: {
      config: baseConfig,
      keyHandling: { activeOverlayConsumes: true, runtimeGuardConsumes: true },
      actions: [{ stdinHex: Buffer.from("n").toString("hex") }],
      refreshResponses: [{ result: true, refreshedAt: 1 }],
    },
  },
  {
    name: "runDashboard continues processing keys after a tmux FocusIn report",
    input: {
      config: baseConfig,
      actions: [{ stdinHex: Buffer.concat([Buffer.from("\x1b[I"), Buffer.from("\r")]).toString("hex") }],
      refreshResponses: [{ result: true, refreshedAt: 1 }],
    },
  },
  {
    name: "runDashboard ignores a pure tmux FocusIn report as dashboard input",
    input: {
      config: baseConfig,
      actions: [{ stdinHex: Buffer.from("\x1b[I").toString("hex") }],
      refreshResponses: [{ result: true, refreshedAt: 1 }],
    },
  },
  {
    name: "runDashboard routes dashboard input to the active subscreen handler",
    input: {
      config: baseConfig,
      host: { dashboardState: { screen: "project" } },
      actions: [{ stdinHex: Buffer.from("x").toString("hex") }],
      refreshResponses: [{ result: true, refreshedAt: 1 }],
    },
  },
  {
    name: "runDashboard clears startup busy state after successful repair without a fresh model change",
    input: {
      config: baseConfig,
      host: { dashboardModelServiceRefreshedAt: 1 },
      refreshResponses: [{ result: false }, { result: false }],
    },
  },
  {
    name: "runDashboard reports repair failure when the service remains unavailable",
    input: {
      config: baseConfig,
      host: { dashboardModelServiceRefreshedAt: 1 },
      refreshResponses: [
        { result: false, errorMessage: "service still unavailable" },
        { result: false, errorMessage: "service still unavailable" },
      ],
    },
  },
  {
    name: "runDashboard suppresses stale startup repair after later dashboard input",
    input: {
      config: baseConfig,
      host: { dashboardModelServiceRefreshedAt: 1 },
      ensureEffect: "input",
      refreshResponses: [{ result: false }, { result: true, refreshedAt: 2, clearError: true }],
    },
  },
  {
    name: "runDashboard marks tmux dashboards ready after the first startup frame",
    input: {
      config: baseConfig,
      tmuxPane: "%42",
      refreshResponses: [{ result: true, refreshedAt: 1 }],
    },
  },
  {
    name: "runDashboard suppresses stale startup repair after a newer dashboard run starts",
    input: {
      config: baseConfig,
      host: { dashboardModelServiceRefreshedAt: 1 },
      ensureEffect: "generation",
      refreshResponses: [{ result: false }, { result: false }],
    },
  },
];

const cases = [];
for (const entry of casesInput) {
  const input = clone(entry.input);
  cases.push({
    id: `session-launch-dashboard-${String(cases.length + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/session-launch.ts",
    api: "runDashboard",
    input,
    output: await runCase(clone(input)),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/session-launch.ts",
  generatedBy: "scripts/capture-session-launch-dashboard-contract.mjs",
  description:
    "Dashboard launch startup, input dispatch, startup repair, and tmux-ready side effects captured by running TypeScript runDashboard with deterministic fake hosts.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
