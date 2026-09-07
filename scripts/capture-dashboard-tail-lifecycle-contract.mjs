#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-tail-lifecycle.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const PROJECT_ID_RE = /repo-[0-9a-f]{12}/g;

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value, repoRoot) {
  return JSON.parse(
    JSON.stringify(value).split(repoRoot).join("<REPO>").replace(ISO_RE, "<NOW>").replace(PROJECT_ID_RE, "repo-<id>"),
  );
}

function denormalize(value, repoRoot) {
  return JSON.parse(JSON.stringify(value).split("<REPO>").join(repoRoot));
}

function mapFromObject(value = {}) {
  return new Map(Object.entries(value));
}

function setFromArray(value = []) {
  return new Set(value);
}

function fn(calls, method, impl) {
  return (...args) => {
    calls.push({ method, args });
    return impl?.(...args);
  };
}

function timerStub(timers) {
  return (handler, ms, ...args) => {
    const timer = {
      ms,
      args,
      handler,
      cleared: false,
      unref() {
        timers.push({ ms, unref: true });
      },
    };
    return timer;
  };
}

async function readTopology(projectStateDir, repoRoot) {
  try {
    return normalize(await readFile(join(projectStateDir, "runtime-topology.yaml"), "utf8"), repoRoot);
  } catch {
    return "";
  }
}

async function runCase(input, index) {
  const root = mkdtempSync(join(tmpdir(), "aimux-dashboard-tail-lifecycle-"));
  const repoRoot = join(root, "repo");
  const aimuxHome = join(root, "home");
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
  mkdirSync(aimuxHome, { recursive: true });
  process.env.AIMUX_HOME = aimuxHome;

  const { initPaths, getProjectStateDir } = await import(new URL("dist/paths.js", ROOT));
  const { dashboardTailMethods } = await import(
    new URL(`dist/multiplexer/dashboard-tail-methods.js?lifecycleCase=${index}`, ROOT)
  );
  const { listTopologySessionStates, upsertTopologySession } = await import(
    new URL(`dist/runtime-core/topology-sessions.js?lifecycleCase=${index}`, ROOT)
  );

  await writeFile(join(repoRoot, ".aimux", "config.json"), `${JSON.stringify(input.config, null, 2)}\n`);
  await initPaths(repoRoot);
  process.chdir(repoRoot);
  const projectStateDir = getProjectStateDir();
  for (const setup of input.setupTopologySessions ?? []) {
    const session = denormalize(setup, repoRoot);
    upsertTopologySession(session, session.status, { projectRoot: repoRoot });
  }

  const calls = [];
  const timers = [];
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  global.setTimeout = timerStub(timers);
  global.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
    calls.push({ method: "clearTimeout", args: [timer?.ms ?? null] });
  };

  const pendingActions = {
    setSessionAction: fn(calls, "dashboardPendingActions.setSessionAction", () => input.pendingToken ?? 101),
    clearSessionActionIfToken: fn(calls, "dashboardPendingActions.clearSessionActionIfToken", () => true),
  };
  const host = {
    projectRoot: repoRoot,
    mode: input.host?.mode ?? "dashboard",
    sessions: denormalize(input.host?.sessions ?? [], repoRoot),
    offlineSessions: denormalize(input.host?.offlineSessions ?? [], repoRoot),
    sessionOriginalArgs: mapFromObject(input.host?.sessionOriginalArgs),
    sessionToolKeys: mapFromObject(input.host?.sessionToolKeys),
    sessionWorktreePaths: mapFromObject(input.host?.sessionWorktreePaths),
    sessionStartTimes: mapFromObject(input.host?.sessionStartTimes),
    sessionTeams: mapFromObject(input.host?.sessionTeams),
    stoppingSessionIds: setFromArray(input.host?.stoppingSessionIds),
    graveyardAfterStopSessionIds: setFromArray(input.host?.graveyardAfterStopSessionIds),
    dashboardPendingActions: pendingActions,
    invalidateDesktopStateSnapshot: fn(calls, "invalidateDesktopStateSnapshot"),
    writeStatuslineFile: fn(calls, "writeStatuslineFile"),
    renderCurrentDashboardView: fn(calls, "renderCurrentDashboardView"),
    updateContextWatcherSessions: fn(calls, "updateContextWatcherSessions"),
    restoreTmuxSessionsFromTopology: fn(calls, "restoreTmuxSessionsFromTopology"),
    syncSessionsFromTopology: fn(calls, "syncSessionsFromTopology"),
    applySessionLabel: fn(calls, "applySessionLabel"),
    openLiveTmuxWindowForEntry: fn(calls, "openLiveTmuxWindowForEntry"),
    debug: fn(calls, "debug"),
    metadataServer: { notifyChange: fn(calls, "metadataServer.notifyChange") },
    generateDashboardSessionId: fn(calls, "generateDashboardSessionId", (command) => `${command}-generated`),
  };

  const steps = [];
  try {
    for (const step of input.steps ?? []) {
      try {
        let result;
        if (step.method === "spawnAgent") {
          result = await dashboardTailMethods.spawnAgent.call(host, denormalize(step.options ?? {}, repoRoot));
        } else if (step.method === "stopAgent") {
          result = await dashboardTailMethods.stopAgent.call(host, step.sessionId);
        } else if (step.method === "sendAgentToGraveyard") {
          result = await dashboardTailMethods.sendAgentToGraveyard.call(host, step.sessionId);
        } else {
          throw new Error(`unknown lifecycle step ${step.method}`);
        }
        steps.push({ method: step.method, result: normalize(result, repoRoot), error: null });
      } catch (error) {
        steps.push({ method: step.method, result: null, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return {
      steps,
      calls: normalize(calls, repoRoot),
      timers: normalize(timers, repoRoot),
      topologySessions: normalize(
        listTopologySessionStates({
          statuses: ["running", "idle", "starting", "planned", "offline", "graveyard"],
          projectRoot: repoRoot,
        }),
        repoRoot,
      ),
      offlineSessions: normalize(host.offlineSessions, repoRoot),
      stoppingSessionIds: [...host.stoppingSessionIds].sort(),
      graveyardAfterStopSessionIds: [...host.graveyardAfterStopSessionIds].sort(),
      topologyYaml: await readTopology(projectStateDir, repoRoot),
    };
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
}

const config = {
  defaultTool: "codex",
  tools: {
    codex: {
      command: "codex",
      args: ["--model", "gpt-5"],
      enabled: true,
      preambleFlag: ["--append-system-prompt"],
      sessionIdFlag: ["--session-id", "{sessionId}"],
    },
  },
};

const inputs = [
  {
    name: "stopAgent cancels a queued create and records an offline topology entry",
    input: {
      config,
      host: {},
      steps: [
        { method: "spawnAgent", options: { toolConfigKey: "codex", targetSessionId: "codex-queued-stop" } },
        { method: "stopAgent", sessionId: "codex-queued-stop" },
      ],
    },
  },
  {
    name: "sendAgentToGraveyard cancels a queued create and records a graveyard topology entry",
    input: {
      config,
      host: {},
      steps: [
        { method: "spawnAgent", options: { toolConfigKey: "codex", targetSessionId: "codex-queued-graveyard" } },
        { method: "sendAgentToGraveyard", sessionId: "codex-queued-graveyard" },
      ],
    },
  },
  {
    name: "stopAgent returns offline for an existing offline topology session",
    input: {
      config,
      host: {},
      setupTopologySessions: [
        {
          id: "codex-offline",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          lifecycle: "offline",
          status: "offline",
          worktreePath: "<REPO>/wt",
        },
      ],
      steps: [{ method: "stopAgent", sessionId: "codex-offline" }],
    },
  },
  {
    name: "sendAgentToGraveyard moves an offline topology session to graveyard",
    input: {
      config,
      host: {},
      setupTopologySessions: [
        {
          id: "codex-offline-graveyard",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: ["--resume"],
          lifecycle: "offline",
          status: "offline",
        },
      ],
      steps: [{ method: "sendAgentToGraveyard", sessionId: "codex-offline-graveyard" }],
    },
  },
  {
    name: "stopAgent reports an unknown session when runtime and topology are absent",
    input: {
      config,
      host: {},
      steps: [{ method: "stopAgent", sessionId: "missing-session" }],
    },
  },
  {
    name: "sendAgentToGraveyard is idempotent for an existing graveyard topology session",
    input: {
      config,
      host: {},
      setupTopologySessions: [
        {
          id: "codex-graveyarded",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          lifecycle: "offline",
          status: "graveyard",
        },
      ],
      steps: [{ method: "sendAgentToGraveyard", sessionId: "codex-graveyarded" }],
    },
  },
];

const cases = [];
for (const [index, entry] of inputs.entries()) {
  cases.push({
    id: `dashboard-tail-lifecycle-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-tail-methods.ts",
    api: "dashboardTailMethods.lifecycle",
    input: entry.input,
    output: await runCase(entry.input, index),
    inputSha256: hash(entry.input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-tail-methods.ts",
  generatedBy: "scripts/capture-dashboard-tail-lifecycle-contract.mjs",
  description:
    "Dashboard tail stop/graveyard lifecycle behavior captured by running TypeScript with queued creates and topology-backed sessions.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
