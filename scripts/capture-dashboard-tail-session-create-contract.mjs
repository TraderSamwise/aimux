#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-tail-session-create.json", ROOT);

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

function mapFromObject(value = {}) {
  return new Map(Object.entries(value));
}

function setFromArray(value = []) {
  return new Set(value);
}

function timerStub(timers) {
  return (fn, ms, ...args) => {
    const timer = {
      ms,
      args,
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
  const root = mkdtempSync(join(tmpdir(), "aimux-dashboard-tail-create-"));
  const repoRoot = join(root, "repo");
  const aimuxHome = join(root, "home");
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
  mkdirSync(aimuxHome, { recursive: true });
  process.env.AIMUX_HOME = aimuxHome;

  const { initPaths, getProjectStateDir } = await import(new URL("dist/paths.js", ROOT));
  const { dashboardTailMethods } = await import(
    new URL(`dist/multiplexer/dashboard-tail-methods.js?case=${index}`, ROOT)
  );
  const { listTopologySessionStates } = await import(new URL("dist/runtime-core/topology-sessions.js", ROOT));

  await writeFile(join(repoRoot, ".aimux", "config.json"), `${JSON.stringify(input.config, null, 2)}\n`);
  await initPaths(repoRoot);
  process.chdir(repoRoot);
  const projectStateDir = getProjectStateDir();

  const calls = [];
  const timers = [];
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  global.setTimeout = timerStub(timers);
  global.clearTimeout = (timer) => {
    calls.push({ method: "clearTimeout", args: [timer?.ms ?? null] });
  };
  const fn =
    (method, impl) =>
    (...args) => {
      calls.push({ method, args: normalize(args, repoRoot) });
      return impl?.(...args);
    };
  const pendingActions = {
    setSessionAction: fn("dashboardPendingActions.setSessionAction", () => input.pendingToken ?? 101),
    clearSessionActionIfToken: fn("dashboardPendingActions.clearSessionActionIfToken", () => true),
  };
  const host = {
    projectRoot: repoRoot,
    mode: input.host.mode ?? "dashboard",
    sessions: input.host.sessions ?? [],
    offlineSessions: input.host.offlineSessions ?? [],
    sessionOriginalArgs: mapFromObject(input.host.sessionOriginalArgs),
    sessionToolKeys: mapFromObject(input.host.sessionToolKeys),
    sessionWorktreePaths: mapFromObject(input.host.sessionWorktreePaths),
    stoppingSessionIds: setFromArray(input.host.stoppingSessionIds),
    graveyardAfterStopSessionIds: setFromArray(input.host.graveyardAfterStopSessionIds),
    dashboardPendingActions: pendingActions,
    invalidateDesktopStateSnapshot: fn("invalidateDesktopStateSnapshot"),
    writeStatuslineFile: fn("writeStatuslineFile"),
    renderCurrentDashboardView: fn("renderCurrentDashboardView"),
    updateContextWatcherSessions: fn("updateContextWatcherSessions"),
    restoreTmuxSessionsFromTopology: fn("restoreTmuxSessionsFromTopology"),
    syncSessionsFromTopology: fn("syncSessionsFromTopology"),
    metadataServer: { notifyChange: fn("metadataServer.notifyChange") },
    generateDashboardSessionId: fn("generateDashboardSessionId", (command) => `${command}-generated`),
  };

  try {
    const method = dashboardTailMethods[input.method];
    const result = await method.call(host, input.options);
    return {
      result: normalize(result, repoRoot),
      error: null,
      calls: normalize(calls, repoRoot),
      timers: normalize(timers, repoRoot),
      topologySessions: normalize(listTopologySessionStates({ projectRoot: repoRoot }), repoRoot),
      topologyYaml: await readTopology(projectStateDir, repoRoot),
    };
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error.message : String(error),
      calls: normalize(calls, repoRoot),
      timers: normalize(timers, repoRoot),
      topologySessions: normalize(listTopologySessionStates({ projectRoot: repoRoot }), repoRoot),
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
    claude: {
      command: "claude",
      args: ["--dangerously-skip-permissions"],
      enabled: true,
      preambleFlag: ["--append-system-prompt"],
    },
  },
};

const inputs = [
  {
    name: "spawnAgent records a starting detached agent and queued pending seed",
    input: {
      method: "spawnAgent",
      config,
      host: {},
      options: {
        toolConfigKey: "codex",
        targetSessionId: "codex-new",
        targetWorktreePath: "<REPO>/.aimux/worktrees/rust",
        open: false,
      },
    },
  },
  {
    name: "spawnAgent generates ids and marks scribe session metadata",
    input: {
      method: "spawnAgent",
      config,
      host: {},
      options: {
        toolConfigKey: "claude",
        scribe: true,
        open: true,
      },
    },
  },
  {
    name: "createTeammateAgent records teammate team metadata and merged args",
    input: {
      method: "createTeammateAgent",
      config,
      host: {},
      options: {
        parentSessionId: "codex-parent",
        role: "reviewer",
        label: "Review",
        order: 2,
        extraArgs: ["--model", "sonnet"],
        targetSessionId: "claude-reviewer",
        targetWorktreePath: "<REPO>/.aimux/worktrees/review",
        open: true,
      },
    },
  },
  {
    name: "spawnAgent rejects an id already present in live runtimes",
    input: {
      method: "spawnAgent",
      config,
      host: {
        sessions: [{ id: "codex-new", command: "codex" }],
      },
      options: {
        toolConfigKey: "codex",
        targetSessionId: "codex-new",
      },
    },
  },
];

const cases = [];
for (const [index, entry] of inputs.entries()) {
  cases.push({
    id: `dashboard-tail-session-create-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-tail-methods.ts",
    api: "dashboardTailMethods.sessionCreate",
    input: entry.input,
    output: await runCase(entry.input, index),
    inputSha256: hash(entry.input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-tail-methods.ts",
  generatedBy: "scripts/capture-dashboard-tail-session-create-contract.mjs",
  description: "Dashboard tail session creation enqueue behavior captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
