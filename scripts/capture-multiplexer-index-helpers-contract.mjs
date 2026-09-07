#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/index-helpers.json", ROOT);
const FIXED_NOW = "2026-06-01T00:00:00.000Z";

const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { Multiplexer } = await import(new URL("dist/multiplexer/index.js", ROOT));
const { dashboardActionMethods } = await import(new URL("dist/multiplexer/dashboard-actions-methods.js", ROOT));
const { agentIoMethods } = await import(new URL("dist/multiplexer/agent-io-methods.js", ROOT));
const { dashboardInteractionMethods } = await import(new URL("dist/multiplexer/dashboard-interaction.js", ROOT));
const { dashboardStateMethods } = await import(new URL("dist/multiplexer/dashboard-state-methods.js", ROOT));
const { persistenceMethods } = await import(new URL("dist/multiplexer/persistence-methods.js", ROOT));
const { dashboardTailMethods } = await import(new URL("dist/multiplexer/dashboard-tail-methods.js", ROOT));
const { runtimeLifecycleMethods } = await import(new URL("dist/multiplexer/runtime-lifecycle-methods.js", ROOT));
const { dashboardViewMethods } = await import(new URL("dist/multiplexer/dashboard-view-methods.js", ROOT));
const { saveMetadataState } = await import(new URL("dist/metadata-store.js", ROOT));
const { createRuntimeTopologyStore, emptyRuntimeTopology } = await import(
  new URL("dist/runtime-core/topology-store.js", ROOT)
);
const { createRuntimeExchangeStore } = await import(new URL("dist/runtime-core/exchange-store.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function gitInit(cwd) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  execFileSync("git", ["init"], { cwd, env, stdio: "ignore" });
}

function normalize(value, repoRoot, aimuxHome) {
  return JSON.parse(
    JSON.stringify(value)
      .split(repoRoot)
      .join("<REPO>")
      .split(aimuxHome)
      .join("<AIMUX_HOME>")
      .replaceAll(/aimux-index-helpers-[^/"\s]+/g, "<REPO_NAME>")
      .replaceAll(/thread-[a-z0-9]+/g, "<THREAD_ID>")
      .replaceAll(/msg-[a-z0-9]+/g, "<MESSAGE_ID>")
      .replaceAll(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/g, "<ISO_DATE>"),
  );
}

function recorder(repoRoot, aimuxHome) {
  const calls = [];
  return {
    calls,
    fn(method, impl) {
      return (...args) => {
        calls.push({ method, args: normalize(args, repoRoot, aimuxHome) });
        return impl?.(...args);
      };
    },
  };
}

function seedTopology(input) {
  const store = createRuntimeTopologyStore();
  store.write({
    ...emptyRuntimeTopology(FIXED_NOW),
    rigs: [{ id: "rig-1", name: "test", projectRoot: "<REPO>", createdAt: FIXED_NOW, updatedAt: FIXED_NOW }],
    nodes: [
      {
        id: "node-source",
        rigId: "rig-1",
        logicalId: "source",
        runtime: "agent",
        toolConfigKey: input.topologyToolConfigKey ?? "codex",
        createdAt: FIXED_NOW,
      },
    ],
    sessions: (input.topologySessions ?? []).map((session) => ({
      nodeId: "node-source",
      status: "running",
      tool: session.tool ?? session.toolConfigKey ?? "codex",
      command: session.command ?? session.toolConfigKey ?? "codex",
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      ...session,
    })),
  });
}

function makeMux(input, repoRoot, aimuxHome, rec) {
  const mux = new Multiplexer({ contextWatcherEnabled: false, projectRoot: repoRoot });
  mux.sessions = clone(input.sessions ?? []);
  mux.offlineSessions = clone(input.offlineSessions ?? []);
  mux.dashboardSessionsCache = clone(input.dashboardSessionsCache ?? []);
  mux.dashboardServicesCache = clone(input.dashboardServicesCache ?? []);
  mux.offlineServices = clone(input.offlineServices ?? []);
  mux.dashboardWorktreeGroupsCache = clone(input.dashboardWorktreeGroupsCache ?? []);
  mux.sessionToolKeys = new Map(input.sessionToolKeys ?? []);
  mux.sessionOriginalArgs = new Map(input.sessionOriginalArgs ?? []);
  mux.sessionWorktreePaths = new Map(input.sessionWorktreePaths ?? []);
  mux.sessionTmuxTargets = new Map(input.sessionTmuxTargets ?? []);
  mux.eventBus = { publishAlert: rec.fn("eventBus.publishAlert", (alert) => normalize(alert, repoRoot, aimuxHome)) };
  mux.showDashboardError = rec.fn("showDashboardError");
  mux.getSessionLabel = rec.fn("getSessionLabel", (sessionId) => input.sessionLabels?.[sessionId]);
  mux.contextWatcher = { syncNow: rec.fn("contextWatcher.syncNow", async () => undefined) };
  mux.sessionBootstrap = {
    composeToolArgs: rec.fn("sessionBootstrap.composeToolArgs", (_toolCfg, forkArgs, overrideArgs) => [
      ...(overrideArgs ?? []),
      ...forkArgs,
    ]),
    readForkSourceSnapshot: rec.fn("sessionBootstrap.readForkSourceSnapshot", () =>
      clone(input.sourceSnapshot ?? { historyText: "history", liveText: "live" }),
    ),
    seedForkArtifacts: rec.fn("sessionBootstrap.seedForkArtifacts"),
    buildForkPreamble: rec.fn("sessionBootstrap.buildForkPreamble", () => input.forkPreamble ?? "fork preamble"),
  };
  mux.createSession = rec.fn("createSession", (...args) => {
    const transport = { id: args[8] ?? "created-session" };
    mux.sessionTmuxTargets.set(transport.id, {
      sessionName: "aimux-test",
      windowId: "@1",
      windowName: "agent",
    });
    return transport;
  });
  mux.agentTracker = { emit: rec.fn("agentTracker.emit") };
  return mux;
}

function summarizeMultiplexer(mux) {
  return {
    projectRoot: mux.projectRoot,
    mode: mux.mode,
    sessionCount: mux.sessionCount,
    activeIndex: mux.activeIndex,
    activeSession: mux.activeSession ? { id: mux.activeSession.id, command: mux.activeSession.command } : null,
    startedInDashboard: mux.startedInDashboard,
    overlayKind: mux.dashboardOverlayState?.kind ?? null,
    pickerMode: mux.pickerMode,
    toolPickerIndex: mux.toolPickerIndex,
    worktreeInputBuffer: mux.worktreeInputBuffer,
    serviceInputBuffer: mux.serviceInputBuffer,
    labelInputBuffer: mux.labelInputBuffer,
    orchestrationInputBuffer: mux.orchestrationInputBuffer,
    dashboardMainCheckoutInfoCache: mux.dashboardMainCheckoutInfoCache,
    runtimeGuardState: mux.runtimeGuardState,
    runtimeGuardActiveMs: mux.runtimeGuardActiveMs,
    footerFlash: mux.footerFlash,
    footerFlashTicks: mux.footerFlashTicks,
    methodTypes: {
      run: typeof mux.run,
      runDashboard: typeof mux.runDashboard,
      startProjectServiceHost: typeof mux.startProjectServiceHost,
      runProjectService: typeof mux.runProjectService,
      createSession: typeof mux.createSession,
      resumeSessions: typeof mux.resumeSessions,
      restoreSessions: typeof mux.restoreSessions,
    },
  };
}

function summarizeMethodSurface(mux) {
  const groups = {
    dashboardInteractionMethods,
    dashboardViewMethods,
    dashboardActionMethods,
    dashboardTailMethods,
    persistenceMethods,
    dashboardStateMethods,
    agentIoMethods,
    runtimeLifecycleMethods,
  };
  const delegatedGroups = Object.fromEntries(
    Object.entries(groups).map(([name, methods]) => [name, Object.keys(methods).sort()]),
  );
  const delegatedMethods = [...new Set(Object.values(delegatedGroups).flat())].sort();
  const ownPrototypeMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(mux)).sort();
  const ownPrototypeSet = new Set(ownPrototypeMethods);
  return {
    delegatedGroups,
    delegatedMethodCount: delegatedMethods.length,
    missingDelegatedMethods: delegatedMethods.filter((name) => !ownPrototypeSet.has(name)),
    nonFunctionDelegatedMethods: delegatedMethods.filter((name) => typeof mux[name] !== "function"),
    corePrototypeMethods: ownPrototypeMethods.filter((name) => !delegatedMethods.includes(name)),
  };
}

async function withProject(input, runCase) {
  const repoRoot = join(tmpdir(), `aimux-index-helpers-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const aimuxHome = join(repoRoot, "home");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(aimuxHome, { recursive: true });
  gitInit(repoRoot);
  const previousHome = process.env.AIMUX_HOME;
  const previousCwd = process.cwd();
  try {
    process.env.AIMUX_HOME = aimuxHome;
    process.chdir(repoRoot);
    await initPaths(repoRoot);
    saveMetadataState(clone(input.metadata ?? { version: 1, sessions: {} }));
    seedTopology(input);
    createRuntimeExchangeStore().write({
      version: 1,
      generatedAt: FIXED_NOW,
      threads: [],
      messages: [],
      tasks: [],
      reviews: [],
      plans: [],
      waits: [],
      attachments: [],
      indexes: { bySession: {}, byThread: {}, byTask: {}, unreadBySession: {} },
    });
    const rec = recorder(repoRoot, aimuxHome);
    const mux = makeMux(input, repoRoot, aimuxHome, rec);
    return normalize(await runCase(mux, rec), repoRoot, aimuxHome);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

async function runCase(input) {
  return withProject(input, async (mux, rec) => {
    if (input.api === "Multiplexer") {
      if (Array.isArray(input.postConstructSessions)) {
        mux.sessions = clone(input.postConstructSessions);
      }
      if (typeof input.postConstructActiveIndex === "number") {
        mux.activeIndex = input.postConstructActiveIndex;
      }
      return {
        result: summarizeMultiplexer(mux),
        calls: rec.calls,
      };
    }
    if (input.api === "MultiplexerMethodSurface") {
      return {
        result: summarizeMethodSurface(mux),
        calls: rec.calls,
      };
    }
    if (input.api === "resolveNativeForkLaunch") {
      return {
        result: mux.resolveNativeForkLaunch(
          input.sourceSessionId,
          input.targetToolConfigKey,
          input.toolCfg,
          input.launchOverride,
        ),
        calls: rec.calls,
      };
    }
    if (input.api === "resolveSessionAlertDisplayContext") {
      return {
        result: mux.resolveSessionAlertDisplayContext(input.sessionId, input.worktreePath),
        calls: rec.calls,
      };
    }
    if (input.api === "publishAlert") {
      mux.publishAlert(clone(input.alert));
      return { result: null, calls: rec.calls };
    }
    if (input.api === "forkSessionFromSource") {
      const result = await mux.forkSessionFromSource(
        input.sourceSessionId,
        input.targetToolConfigKey,
        input.requestedTargetSessionId,
        input.instruction,
        input.targetWorktreePath,
        input.launchOverride,
      );
      const exchange = createRuntimeExchangeStore().read();
      return {
        result,
        calls: rec.calls,
        exchange: {
          threads: exchange.threads,
          messages: exchange.messages,
        },
      };
    }
    throw new Error(`unknown multiplexer index helper api ${input.api}`);
  });
}

const cases = [
  {
    name: "constructor initializes inert dashboard state for an explicit project root",
    input: {
      api: "Multiplexer",
    },
  },
  {
    name: "session getters reflect post construction session state",
    input: {
      api: "Multiplexer",
      postConstructSessions: [
        { id: "claude-1", command: "claude" },
        { id: "codex-2", command: "codex" },
      ],
      postConstructActiveIndex: 1,
    },
  },
  {
    name: "prototype exposes all delegated multiplexer method groups",
    input: {
      api: "MultiplexerMethodSurface",
    },
  },
  {
    name: "native fork launch composes backend fork args when source tool and command match",
    input: {
      api: "resolveNativeForkLaunch",
      sourceSessionId: "codex-1",
      targetToolConfigKey: "codex",
      sessionToolKeys: [["codex-1", "codex"]],
      topologySessions: [{ id: "codex-1", toolConfigKey: "codex", backendSessionId: "backend-abc" }],
      toolCfg: {
        command: "codex",
        args: ["--dangerously-bypass-approvals-and-sandbox"],
        forkArgs: ["fork", "{sessionId}"],
      },
      launchOverride: { args: ["--model", "gpt-5"] },
    },
  },
  {
    name: "native fork launch refuses missing backend session id",
    input: {
      api: "resolveNativeForkLaunch",
      sourceSessionId: "codex-1",
      targetToolConfigKey: "codex",
      sessionToolKeys: [["codex-1", "codex"]],
      topologySessions: [{ id: "codex-1", toolConfigKey: "codex" }],
      toolCfg: { command: "codex", args: [], forkArgs: ["fork", "{sessionId}"] },
    },
  },
  {
    name: "native fork launch refuses cross-tool and command override forks",
    input: {
      api: "resolveNativeForkLaunch",
      sourceSessionId: "claude-1",
      targetToolConfigKey: "codex",
      sessionToolKeys: [["claude-1", "claude"]],
      topologySessions: [{ id: "claude-1", toolConfigKey: "claude", backendSessionId: "backend-abc" }],
      toolCfg: { command: "codex", args: [], forkArgs: ["fork", "{sessionId}"] },
      launchOverride: { command: "other-codex" },
    },
  },
  {
    name: "alert display context merges metadata, live session, worktree, and label cache",
    input: {
      api: "resolveSessionAlertDisplayContext",
      sessionId: "codex-1",
      metadata: {
        version: 1,
        sessions: {
          "codex-1": {
            updatedAt: FIXED_NOW,
            context: { worktreePath: "<REPO>/.aimux/worktrees/old", worktreeName: "old", branch: "old-branch" },
          },
        },
      },
      sessionLabels: { "codex-1": "Review Agent" },
      dashboardSessionsCache: [{ id: "codex-1", command: "codex", worktreePath: "<REPO>/.aimux/worktrees/review" }],
      dashboardWorktreeGroupsCache: [
        { path: "<REPO>/.aimux/worktrees/review", name: "review", branch: "feature/review" },
      ],
    },
  },
  {
    name: "publish alert contextualizes service rows with live worktree context",
    input: {
      api: "publishAlert",
      alert: {
        kind: "task_failed",
        sessionId: "svc-1",
        title: "Service failed",
        message: "exit 1",
        dedupeKey: "svc-1:error",
      },
      dashboardServicesCache: [
        { id: "svc-1", label: "web", launchCommandLine: "pnpm dev", worktreePath: "<REPO>/app" },
      ],
      dashboardWorktreeGroupsCache: [{ path: "<REPO>/app", name: "app", branch: "app-branch" }],
    },
  },
  {
    name: "fork session reports missing source before creating thread",
    input: {
      api: "forkSessionFromSource",
      sourceSessionId: "missing",
      targetToolConfigKey: "codex",
      requestedTargetSessionId: "codex-child",
    },
  },
  {
    name: "fork session uses handoff preamble when target tool differs",
    input: {
      api: "forkSessionFromSource",
      sourceSessionId: "claude-1",
      targetToolConfigKey: "codex",
      requestedTargetSessionId: "codex-child",
      instruction: "Take over this task.",
      sessionLabels: { "claude-1": "Claude Lead" },
      sessions: [{ id: "claude-1", command: "claude" }],
      sessionToolKeys: [["claude-1", "claude"]],
      sessionWorktreePaths: [["claude-1", "<REPO>/.aimux/worktrees/ui"]],
      targetWorktreePath: "<REPO>/.aimux/worktrees/ui",
    },
  },
  {
    name: "fork session uses native fork args when same tool backend id exists",
    input: {
      api: "forkSessionFromSource",
      sourceSessionId: "codex-1",
      targetToolConfigKey: "codex",
      requestedTargetSessionId: "codex-child",
      instruction: "Keep going.",
      launchOverride: { args: ["--model", "gpt-5"], env: { CODEX_ENV: "1" } },
      sessionLabels: { "codex-1": "Codex Lead" },
      sessions: [{ id: "codex-1", command: "codex" }],
      sessionToolKeys: [["codex-1", "codex"]],
      sessionWorktreePaths: [["codex-1", "<REPO>/.aimux/worktrees/review"]],
      topologySessions: [{ id: "codex-1", toolConfigKey: "codex", backendSessionId: "backend-xyz" }],
      targetWorktreePath: "<REPO>/.aimux/worktrees/review",
    },
  },
];

const realDate = Date;
const realRandom = Math.random;
let randomIndex = 0;
const randomValues = [0.111111111, 0.222222222, 0.333333333, 0.444444444];
globalThis.Date = class FixedDate extends realDate {
  constructor(...args) {
    super(...(args.length ? args : [FIXED_NOW]));
  }
  static now() {
    return realDate.parse(FIXED_NOW);
  }
  static parse(value) {
    return realDate.parse(value);
  }
  static UTC(...args) {
    return realDate.UTC(...args);
  }
};
Math.random = () => randomValues[randomIndex++ % randomValues.length];

const outputCases = [];
try {
  for (const [index, entry] of cases.entries()) {
    randomIndex = 0;
    const input = clone(entry.input);
    const output = await runCase(input);
    outputCases.push({
      id: `multiplexer-index-helpers-${String(index + 1).padStart(3, "0")}`,
      name: entry.name,
      source: "src/multiplexer/index.ts",
      api: input.api,
      input,
      output,
      inputSha256: hash(input),
    });
  }
} finally {
  globalThis.Date = realDate;
  Math.random = realRandom;
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/index.ts",
  generatedBy: "scripts/capture-multiplexer-index-helpers-contract.mjs",
  description:
    "Multiplexer class-local helper behavior for native fork launch selection, alert context publication, and fork-session orchestration captured by running TypeScript index.ts with inert fake hosts.",
  cases: outputCases,
});

console.log(`${FIXTURE_PATH.pathname}: ${outputCases.length} cases`);
