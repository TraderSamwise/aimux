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

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

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

async function withFixture(label, fn) {
  const tmpRoot = mkdtempSync(join(tmpdir(), `aimux-runtime-state-methods-${label}-`));
  const projectRoot = join(tmpRoot, "repo");
  const previousHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = join(tmpRoot, "home");
  try {
    mkdirSync(projectRoot, { recursive: true });
    await paths.initPaths(projectRoot);
    return await fn({ tmpRoot, projectRoot });
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
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

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/runtime-state.test.ts",
  generatedBy: "scripts/capture-multiplexer-runtime-state-methods-contract.mjs",
  description:
    "Multiplexer runtime-state state transition contracts for dashboard removal adjustment, stop-to-offline topology persistence, graveyard session mutation, and live tmux metadata checks captured by running TypeScript runtime-state helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
