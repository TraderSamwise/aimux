#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyntheticModule, SourceTextModule, createContext } from "node:vm";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/runtime-guard-repair-start.json", ROOT);
const DASHBOARD_CONTROL_URL = new URL("dist/multiplexer/dashboard-control.js", ROOT);
const FIXED_NOW = 1_700_000_000_000;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

const mocks = {
  restartCalls: [],
  isRuntimeRestartInProgress: () => false,
  restartAimuxControlPlane(options) {
    mocks.restartCalls.push({
      reason: options.reason ?? null,
      projectRoot: options.projectRoot ?? null,
      reloadDashboards: options.reloadDashboards ?? null,
      verifyDashboards: options.verifyDashboards ?? null,
      abortSignalAborted: options.abortSignal?.aborted ?? null,
    });
    const behavior = mocks.restartBehavior ?? { kind: "pending" };
    if (behavior.kind === "resolve") return Promise.resolve(successfulRepairResult(options.projectRoot));
    if (behavior.kind === "reject") return Promise.reject(new Error(behavior.message));
    return new Promise(() => {});
  },
};

function successfulRepairResult(projectRoot = "/repo/app") {
  return {
    startedAt: "2026-06-21T00:00:00.000Z",
    finishedAt: "2026-06-21T00:00:01.000Z",
    before: null,
    verification: { status: "ok", after: null, error: null },
    daemon: { previous: null, current: { pid: 1, port: 43190, startedAt: "after", updatedAt: "after" } },
    orphanCleanup: { processes: [], tmuxSessions: [] },
    projects: [
      {
        projectRoot,
        runtimeRebuildRequired: false,
        runtime: { status: "skipped", error: null },
        service: { status: "ensured", state: null, error: null },
        dashboard: { status: "skipped", sessionName: null, target: null, error: null },
      },
    ],
    summary: {
      projects: 1,
      servicesEnsured: 1,
      runtimeRepairs: 0,
      dashboardsReloaded: 0,
      runtimeRebuildRequired: 0,
      orphanProcessesCleaned: 0,
      orphanTmuxSessionsCleaned: 0,
      failures: 0,
    },
  };
}

async function syntheticFromNamespace(namespace, identifier, context) {
  const names = Object.keys(namespace);
  const module = new SyntheticModule(
    names,
    function initialize() {
      for (const name of names) this.setExport(name, namespace[name]);
    },
    { context, identifier },
  );
  await module.link(() => {
    throw new Error(`synthetic module ${identifier} has no imports`);
  });
  await module.evaluate();
  return module;
}

async function loadDashboardControl() {
  const context = createContext({
    AbortController,
    Buffer,
    clearTimeout,
    console,
    Date,
    Error,
    process,
    setTimeout,
    URL,
  });
  const cache = new Map();
  const linker = async (specifier, referencingModule) => {
    const resolved = specifier.startsWith("node:")
      ? specifier
      : new URL(specifier, referencingModule.identifier).href;
    if (cache.has(resolved)) return cache.get(resolved);
    if (resolved.endsWith("/runtime-restart.js")) {
      const module = await syntheticFromNamespace(
        {
          isRuntimeRestartInProgress: (...args) => mocks.isRuntimeRestartInProgress(...args),
          restartAimuxControlPlane: (...args) => mocks.restartAimuxControlPlane(...args),
        },
        resolved,
        context,
      );
      cache.set(resolved, module);
      return module;
    }
    const namespace = await import(resolved);
    const module = await syntheticFromNamespace(namespace, resolved, context);
    cache.set(resolved, module);
    return module;
  };
  const module = new SourceTextModule(readFileSync(DASHBOARD_CONTROL_URL, "utf8"), {
    context,
    identifier: DASHBOARD_CONTROL_URL.href,
    initializeImportMeta(meta) {
      meta.url = DASHBOARD_CONTROL_URL.href;
    },
  });
  await module.link(linker);
  await module.evaluate();
  return module.namespace;
}

async function withTempAimuxHome(work) {
  const previous = process.env.AIMUX_HOME;
  const home = mkdtempSync(join(tmpdir(), "aimux-runtime-guard-repair-start-"));
  process.env.AIMUX_HOME = home;
  try {
    return await work(home);
  } finally {
    if (previous === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

async function flushMicrotasks(count = 8) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function createHost(scenario, calls) {
  const host = {
    mode: scenario.mode ?? "dashboard",
    projectRoot: scenario.projectRoot,
    runtimeGuardRepairing: false,
    runtimeGuardRepairTimedOutPending: false,
    runtimeGuardRepairFailedKey: undefined,
    runtimeGuardRepairBusy: false,
    dashboardBusyState: null,
    dashboardErrorState: null,
    runtimeGuardState: clone(scenario.runtimeGuardState ?? scenario.state),
    renderCurrentDashboardView: () => calls.push({ method: "renderCurrentDashboardView", args: [] }),
    reloadDashboardAfterRuntimeGuardRepair: (...args) =>
      calls.push({ method: "reloadDashboardAfterRuntimeGuardRepair", args: clone(args) }),
    showDashboardError(title, lines) {
      host.dashboardErrorState = { title, lines: clone(lines) };
      calls.push({ method: "showDashboardError", args: [title, clone(lines)] });
    },
  };
  return host;
}

function snapshotHost(host) {
  return {
    runtimeGuardRepairing: host.runtimeGuardRepairing ?? null,
    runtimeGuardRepairBusy: host.runtimeGuardRepairBusy ?? null,
    runtimeGuardRepairFailedKey: host.runtimeGuardRepairFailedKey ?? null,
    runtimeGuardRepairRetryAt: host.runtimeGuardRepairRetryAt ?? null,
    runtimeGuardRepairTimedOutPending: host.runtimeGuardRepairTimedOutPending ?? null,
    dashboardBusyState: clone(host.dashboardBusyState ?? null),
    dashboardErrorState: clone(host.dashboardErrorState ?? null),
    runtimeGuardState: clone(host.runtimeGuardState ?? null),
    footerFlash: host.footerFlash ?? null,
    footerFlashTicks: host.footerFlashTicks ?? null,
    dashboardRepairNotices: clone(host.dashboardRepairNotices ?? []),
    runtimeGuardRepairAttempts: clone(host.runtimeGuardRepairAttempts ?? []),
  };
}

async function capture(input, dashboardControl) {
  return Promise.all(
    input.scenarios.map((scenario) =>
      withTempAimuxHome(async (home) => {
        const calls = [];
        mocks.restartCalls = [];
        mocks.restartBehavior = scenario.restartBehavior ?? { kind: "pending" };
        const host = createHost(scenario, calls);
        dashboardControl.startRuntimeGuardRepair(host, clone(scenario.state));
        await flushMicrotasks(scenario.flushMicrotasks ?? 1);
        const lockPath = join(home, "locks", "dashboard-control-plane-repair");
        return {
          name: scenario.name,
          host: snapshotHost(host),
          calls,
          restartCalls: clone(mocks.restartCalls),
          lockExists: existsSync(lockPath),
        };
      }),
    ),
  );
}

const scenarios = [
  {
    name: "owned stale repair starts restart and leaves dashboard busy while pending",
    projectRoot: "/repo/app",
    state: { kind: "stale", reason: "service-mismatch" },
    restartBehavior: { kind: "pending" },
  },
  {
    name: "self drift success reloads dashboard after cleanup",
    projectRoot: "/repo/app",
    state: { kind: "stale", reason: "self-drift" },
    restartBehavior: { kind: "resolve" },
    flushMicrotasks: 8,
  },
  {
    name: "restart rejection records failure and retry cooldown",
    projectRoot: "/repo/app",
    state: { kind: "runtime-rebuild-required" },
    restartBehavior: { kind: "reject", message: "repair failed" },
    flushMicrotasks: 8,
  },
];

const previousNow = Date.now;
Date.now = () => FIXED_NOW;
try {
  const dashboardControl = await loadDashboardControl();
  const input = { scenarios };
  const output = await capture(input, dashboardControl);
  const contract = {
    version: 1,
    sources: ["src/multiplexer/dashboard-control.test.ts"],
    subject: "runtime guard repair start branch",
    generatedBy: "scripts/capture-runtime-guard-repair-start-contract.mjs",
    caseCount: 1,
    cases: [
      {
        id: "runtime-guard-repair-start-001",
        name: "captures owned repair start, success reload, and failure cooldown without live restart",
        source: "src/multiplexer/dashboard-control.test.ts",
        api: "startRuntimeGuardRepairStartBranch",
        input,
        output,
        inputSha256: hash(input),
      },
    ],
  };
  const prettierOptions = (await prettier.resolveConfig(FIXTURE_PATH.pathname)) ?? {};
  mkdirSync(new URL("./", FIXTURE_PATH), { recursive: true });
  writeFileSync(
    FIXTURE_PATH,
    await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }),
  );
} finally {
  Date.now = previousNow;
}
