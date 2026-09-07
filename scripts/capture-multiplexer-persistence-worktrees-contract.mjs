#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/persistence-worktrees.json", ROOT);
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

const { persistenceMethods } = await import(new URL("dist/multiplexer/persistence-methods.js", ROOT));
const paths = await import(new URL("dist/paths.js", ROOT));
const topologySessions = await import(new URL("dist/runtime-core/topology-sessions.js", ROOT));
const topologyServices = await import(new URL("dist/runtime-core/topology-services.js", ROOT));
const topologyWorktrees = await import(new URL("dist/runtime-core/topology-worktrees.js", ROOT));
const operationFailures = await import(new URL("dist/dashboard/operation-failures.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function gitInit(projectRoot) {
  mkdirSync(projectRoot, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.email", "fixture@example.test"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: projectRoot });
  writeFileSync(join(projectRoot, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: projectRoot });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: projectRoot });
}

function normalize(value, ctx) {
  return normalizeGeneratedIds(
    normalizeWorktreeCreatedAt(
      JSON.parse(
        JSON.stringify(value, (_key, nested) => {
          if (typeof nested !== "string") return nested;
          return nested.replaceAll(ctx.projectRoot, "<repo>").replaceAll(ctx.tmpRoot, "<tmp>");
        }),
      ),
    ),
  );
}

function normalizeWorktreeCreatedAt(value) {
  if (Array.isArray(value)) return value.map(normalizeWorktreeCreatedAt);
  if (!value || typeof value !== "object") return value;
  const out = Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, normalizeWorktreeCreatedAt(nested)]),
  );
  if (out.path === "<repo>" && typeof out.createdAt === "string") out.createdAt = "<createdAt:main>";
  return out;
}

function normalizeGeneratedIds(value) {
  const generatedIds = new Map();
  const collect = (nested) => {
    if (Array.isArray(nested)) {
      for (const item of nested) collect(item);
      return;
    }
    if (!nested || typeof nested !== "object") return;
    if (typeof nested.id === "string" && typeof nested.path === "string") {
      if (nested.id.startsWith("worktree-graveyard:")) {
        generatedIds.set(nested.id, `<worktree-graveyard-id:${nested.path}>`);
      } else if (nested.id.startsWith("worktree:")) {
        generatedIds.set(nested.id, `<worktree-id:${nested.path}>`);
      }
    }
    if (typeof nested.worktreeId === "string" && typeof nested.path === "string") {
      generatedIds.set(nested.worktreeId, `<worktree-id:${nested.path}>`);
    }
    if (
      typeof nested.id === "string" &&
      typeof nested.targetKind === "string" &&
      typeof nested.operation === "string" &&
      typeof nested.message === "string"
    ) {
      generatedIds.set(nested.id, `<operation-failure-id:${generatedIds.size + 1}>`);
    }
    for (const item of Object.values(nested)) collect(item);
  };
  const visit = (nested) => {
    if (Array.isArray(nested)) return nested.map(visit);
    if (nested && typeof nested === "object") {
      return Object.fromEntries(Object.entries(nested).map(([key, item]) => [key, visit(item)]));
    }
    if (typeof nested !== "string") return nested;
    if (generatedIds.has(nested)) return generatedIds.get(nested);
    if (nested.startsWith("worktree-graveyard:")) return "<worktree-graveyard-id:unknown>";
    if (nested.startsWith("worktree:")) return "<worktree-id:unknown>";
    return nested;
  };
  collect(value);
  return visit(value);
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

function pendingActionsFor(calls) {
  const worktreeActions = new Map();
  return {
    setWorktreeAction(path, kind, opts = {}) {
      calls.push({ method: "dashboardPendingActions.setWorktreeAction", args: clone([path, kind, opts]) });
      worktreeActions.set(path, {
        kind,
        timeoutMs: opts.timeoutMs ?? null,
        worktreeSeed: opts.worktreeSeed ? clone(opts.worktreeSeed) : null,
      });
      return worktreeActions.size;
    },
    clearWorktreeAction(path) {
      calls.push({ method: "dashboardPendingActions.clearWorktreeAction", args: clone([path]) });
      worktreeActions.delete(path);
    },
    snapshot() {
      return [...worktreeActions.entries()].map(([path, entry]) => ({ path, ...clone(entry) }));
    },
  };
}

function hostFor(input) {
  const calls = [];
  const dashboardPendingActions = pendingActionsFor(calls);
  const host = {
    projectRoot: input.projectRoot,
    mode: input.mode ?? "project-service",
    graveyardCleanupInterval: input.graveyardCleanupInterval ?? null,
    graveyardCleanupRunning: input.graveyardCleanupRunning ?? false,
    inboxCleanupInterval: input.inboxCleanupInterval ?? null,
    inboxCleanupRunning: input.inboxCleanupRunning ?? false,
    sessions: clone(input.sessions ?? []),
    offlineSessions: clone(input.offlineSessions ?? []),
    offlineServices: clone(input.offlineServices ?? []),
    sessionWorktreePaths: new Map(input.sessionWorktreePaths ?? []),
    listDesktopWorktrees: callRecorder(calls, "listDesktopWorktrees", () => {
      if (input.listDesktopWorktreesError) throw new Error(input.listDesktopWorktreesError);
      return clone(input.worktrees ?? []);
    }),
    deleteGraveyardWorktree: callRecorder(calls, "deleteGraveyardWorktree", async (path) => ({
      path,
      status: "removed",
    })),
    isSessionRuntimeLive: callRecorder(
      calls,
      "isSessionRuntimeLive",
      (session) => input.liveSessionIds?.includes(session.id) ?? false,
    ),
    saveState: callRecorder(calls, "saveState"),
    syncSessionsFromTopology: callRecorder(calls, "syncSessionsFromTopology"),
    loadOfflineTopologySessions: callRecorder(calls, "loadOfflineTopologySessions"),
    invalidateDesktopStateSnapshot: callRecorder(calls, "invalidateDesktopStateSnapshot"),
    refreshLocalDashboardModel: callRecorder(calls, "refreshLocalDashboardModel"),
    writeStatuslineFile: callRecorder(calls, "writeStatuslineFile"),
    renderCurrentDashboardView: callRecorder(calls, "renderCurrentDashboardView"),
    renderDashboard: callRecorder(calls, "renderDashboard"),
    refreshDashboardWorktreeProjection: callRecorder(calls, "refreshDashboardWorktreeProjection"),
    noteLastUsedItem: callRecorder(calls, "noteLastUsedItem"),
    publishAlert: callRecorder(calls, "publishAlert"),
    showDashboardError: callRecorder(calls, "showDashboardError"),
    dashboardPendingActions,
    pendingWorktreeCreates: new Map(input.pendingWorktreeCreates ?? []),
    pendingWorktreeRemovals: new Map(
      (input.pendingWorktreeRemovals ?? []).map(([path, value]) => [path, Promise.resolve(clone(value))]),
    ),
    dashboardWorktreeGroupsCache: clone(input.dashboardWorktreeGroupsCache ?? []),
    metadataServer: { notifyChange: callRecorder(calls, "metadataServer.notifyChange") },
    tmuxRuntimeManager: {
      listProjectManagedWindows: callRecorder(calls, "tmuxRuntimeManager.listProjectManagedWindows", () =>
        clone(input.managedWindows ?? []),
      ),
      killWindow: callRecorder(calls, "tmuxRuntimeManager.killWindow"),
    },
  };
  return { host, calls };
}

function snapshotTopology() {
  return {
    worktrees: topologyWorktrees.listTopologyWorktreeStates(),
    visibleGraveyard: topologyWorktrees.listTopologyWorktreeGraveyard(),
    allGraveyard: topologyWorktrees.listTopologyWorktreeGraveyard({ includeDeleted: true }),
    sessions: topologySessions.listTopologySessionStates(),
    services: topologyServices.listTopologyServiceStates(),
  };
}

function normalizeIntervalHandle(handle) {
  if (handle && typeof handle === "object" && typeof handle.id === "string") return handle.id;
  return handle ?? null;
}

function snapshotHost(host, calls, timers = []) {
  return {
    offlineSessions: clone(host.offlineSessions ?? []),
    offlineServices: clone(host.offlineServices ?? []),
    footerFlash: host.footerFlash ?? null,
    footerFlashTicks: host.footerFlashTicks ?? null,
    graveyardCleanupInterval: normalizeIntervalHandle(host.graveyardCleanupInterval),
    graveyardCleanupRunning: host.graveyardCleanupRunning ?? false,
    inboxCleanupInterval: normalizeIntervalHandle(host.inboxCleanupInterval),
    inboxCleanupRunning: host.inboxCleanupRunning ?? false,
    pendingWorktreeCreatePaths: [...(host.pendingWorktreeCreates?.keys?.() ?? [])],
    pendingWorktreeRemovalPaths: [...(host.pendingWorktreeRemovals?.keys?.() ?? [])],
    dashboardWorktreeActions: host.dashboardPendingActions?.snapshot?.() ?? [],
    calls: clone(calls),
    timers: clone(timers),
  };
}

async function withTimerCapture(fn) {
  const timers = [];
  globalThis.setInterval = (callback, delayMs, ...args) => {
    const handle = { id: `<interval:${timers.length + 1}>`, callback };
    timers.push({ id: handle.id, delayMs, args: clone(args), cleared: false, fired: false });
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    const id = normalizeIntervalHandle(handle);
    const timer = timers.find((candidate) => candidate.id === id);
    if (timer) {
      timer.cleared = true;
    } else {
      timers.push({ id, delayMs: null, args: [], cleared: true, fired: false, unknown: true });
    }
  };
  try {
    return await fn(timers);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

async function withFixture(label, fn) {
  const tmpRoot = mkdtempSync(join(tmpdir(), `aimux-persistence-worktrees-${label}-`));
  mkdirSync(join(tmpRoot, "repo"), { recursive: true });
  const projectRoot = realpathSync(join(tmpRoot, "repo"));
  const previousHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = join(tmpRoot, "home");
  try {
    gitInit(projectRoot);
    await paths.initPaths(projectRoot);
    return await fn({ tmpRoot, projectRoot, worktreeRoot: join(projectRoot, ".aimux", "worktrees") });
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function invoke(api, ctx, input) {
  const actualInput = denormalize(input, ctx);
  const { host, calls } = hostFor(actualInput);
  return withTimerCapture(async (timers) => {
    try {
    if (api === "listDesktopWorktrees") {
      const returned = persistenceMethods.listDesktopWorktrees.call(host);
      return normalize(
        {
          ok: true,
          returned,
          completion: null,
          checkedPaths: checkedPaths(actualInput),
          host: snapshotHost(host, calls, timers),
          topology: snapshotTopology(),
          operationFailures: operationFailures.listDashboardOperationFailures(),
        },
        ctx,
      );
    }
    const arg =
      api === "createDesktopWorktree"
        ? actualInput.name
        : api === "cleanupGraveyard"
          ? actualInput.cleanupInput
          : api === "cleanupWorktreeCaches"
            ? actualInput.cleanupInput
            : api === "resurrectGraveyardSession"
              ? actualInput.sessionId
              : api === "startGraveyardCleanup" ||
                  api === "stopGraveyardCleanup" ||
                  api === "startInboxCleanup" ||
                  api === "stopInboxCleanup"
                ? undefined
                : actualInput.path;
    const returned = await persistenceMethods[api].call(host, arg);
    let immediate;
    let completion = null;
    if (api === "createDesktopWorktree") {
      immediate = { host: snapshotHost(host, calls, timers), topology: snapshotTopology() };
      const pending = host.pendingWorktreeCreates.get(returned.path);
      if (pending) {
        try {
          completion = { ok: true, returned: await pending };
        } catch (error) {
          completion = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    return normalize(
      {
        ok: true,
        returned,
        immediate,
        completion,
        checkedPaths: checkedPaths(actualInput),
        host: snapshotHost(host, calls, timers),
        topology: snapshotTopology(),
        operationFailures: operationFailures.listDashboardOperationFailures(),
      },
      ctx,
    );
    } catch (error) {
    return normalize(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        checkedPaths: checkedPaths(denormalize(input, ctx)),
        host: snapshotHost(host, calls, timers),
        topology: snapshotTopology(),
        operationFailures: operationFailures.listDashboardOperationFailures(),
      },
      ctx,
    );
    }
  });
}

function checkedPaths(input) {
  if (!Array.isArray(input.checkPaths)) return {};
  return Object.fromEntries(input.checkPaths.map((entry) => [entry.label, existsSync(entry.path)]));
}

async function record(cases, name, api, label, prepare) {
  await withFixture(label, async (ctx) => {
    const rawInput = await prepare(ctx);
    rawInput.initialTopology = snapshotTopology();
    if (rawInput.path !== undefined) {
      rawInput.checkoutExists = existsSync(rawInput.path);
    }
    const input = normalize(rawInput, ctx);
    const output = await invoke(api, ctx, input);
    cases.push({
      id: `multiplexer-persistence-worktrees-${String(cases.length + 1).padStart(3, "0")}`,
      name,
      source: "src/multiplexer/persistence-methods.test.ts",
      api,
      input,
      output,
      inputSha256: hash(input),
    });
  });
}

const cases = [];

await record(
  cases,
  "lists desktop worktrees from the host project root",
  "listDesktopWorktrees",
  "list-host-root",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "demo");
    return {
      projectRoot,
      worktrees: [
        { name: "repo", branch: "master", path: projectRoot, isBare: false },
        { name: "demo", branch: "demo", path: worktreePath, isBare: false },
      ],
    };
  },
);

await record(
  cases,
  "graveyards a worktree into topology",
  "graveyardDesktopWorktree",
  "graveyard",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "demo");
    topologySessions.upsertTopologySession(
      { id: "codex-demo", tool: "codex", command: "codex", args: [], worktreePath },
      "offline",
    );
    topologyServices.upsertTopologyService({ id: "service-demo", command: "zsh", worktreePath }, "stopped");
    return {
      projectRoot,
      path: worktreePath,
      worktrees: [{ name: "demo", branch: "demo", path: worktreePath, createdAt: "2026-05-01T00:00:00.000Z" }],
      sessions: [],
      sessionWorktreePaths: [],
      managedWindows: [],
    };
  },
);

await record(
  cases,
  "stops live worktree services without deleting their topology records when graveyarding",
  "graveyardDesktopWorktree",
  "graveyard-services",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "demo");
    const target = { sessionName: "aimux-test", windowId: "@service", windowIndex: 1, windowName: "shell" };
    return {
      projectRoot,
      path: worktreePath,
      worktrees: [{ name: "demo", branch: "demo", path: worktreePath }],
      sessions: [],
      sessionWorktreePaths: [],
      offlineServices: [],
      managedWindows: [
        {
          target,
          metadata: {
            kind: "service",
            sessionId: "service-demo",
            command: "zsh",
            args: ["-l"],
            toolConfigKey: "service",
            createdAt: "2026-05-01T00:00:00.000Z",
            worktreePath,
            label: "shell",
            launchCommandLine: "yarn web",
          },
        },
      ],
    };
  },
);

await record(
  cases,
  "blocks graveyarding while a live agent is attached",
  "graveyardDesktopWorktree",
  "graveyard-live-agent",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "demo");
    return {
      projectRoot,
      path: worktreePath,
      worktrees: [{ name: "demo", branch: "demo", path: worktreePath }],
      sessions: [{ id: "codex-live", label: "Codex Live" }],
      liveSessionIds: ["codex-live"],
      sessionWorktreePaths: [["codex-live", worktreePath]],
      managedWindows: [],
    };
  },
);

await record(
  cases,
  "creates a desktop worktree and settles topology active",
  "createDesktopWorktree",
  "create",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "demo");
    mkdirSync(worktreeRoot, { recursive: true });
    return {
      projectRoot,
      name: "demo",
      path: worktreePath,
      worktrees: [],
      sessions: [],
      sessionWorktreePaths: [],
      managedWindows: [],
    };
  },
);

await record(
  cases,
  "creates worktrees relative to the host project root",
  "createDesktopWorktree",
  "create-host-root",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "smoke");
    mkdirSync(worktreeRoot, { recursive: true });
    return {
      projectRoot,
      name: "smoke",
      path: worktreePath,
      worktrees: [],
      sessions: [],
      sessionWorktreePaths: [],
      managedWindows: [],
    };
  },
);

await record(
  cases,
  "records duplicate worktree create failures through the service owner",
  "createDesktopWorktree",
  "create-duplicate",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "demo");
    return {
      projectRoot,
      name: "demo",
      path: worktreePath,
      worktrees: [
        {
          name: "demo",
          branch: "demo",
          path: worktreePath,
          status: "offline",
          sessions: [],
          services: [],
        },
      ],
      sessions: [],
      sessionWorktreePaths: [],
      managedWindows: [],
    };
  },
);

await record(
  cases,
  "removes an existing desktop worktree and dependent topology",
  "removeDesktopWorktree",
  "remove",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "demo");
    mkdirSync(worktreeRoot, { recursive: true });
    execFileSync("git", ["worktree", "add", "-q", "-b", "demo", worktreePath], { cwd: projectRoot });
    topologyWorktrees.upsertTopologyWorktree(
      { path: worktreePath, name: "demo", branch: "demo", createdAt: "2026-05-01T00:00:00.000Z" },
      "active",
    );
    topologySessions.upsertTopologySession(
      { id: "codex-demo", tool: "codex", command: "codex", args: [], worktreePath },
      "offline",
    );
    topologyServices.upsertTopologyService({ id: "service-demo", command: "zsh", worktreePath }, "stopped");
    return {
      projectRoot,
      path: worktreePath,
      worktrees: [{ name: "demo", branch: "demo", path: worktreePath, createdAt: "2026-05-01T00:00:00.000Z" }],
      sessions: [],
      sessionWorktreePaths: [],
      offlineSessions: [{ id: "codex-demo", worktreePath }],
      offlineServices: [{ id: "service-demo", worktreePath }],
      managedWindows: [],
    };
  },
);

await record(
  cases,
  "removes orphaned generated worktree records when checkout is already missing",
  "removeDesktopWorktree",
  "remove-orphaned-missing-checkout",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "orphan");
    topologyWorktrees.upsertTopologyWorktree(
      { path: worktreePath, name: "orphan", branch: "orphan", createdAt: "2026-05-01T00:00:00.000Z" },
      "active",
    );
    topologySessions.upsertTopologySession(
      { id: "codex-orphan", tool: "codex", command: "codex", args: [], worktreePath },
      "offline",
    );
    topologyServices.upsertTopologyService({ id: "service-orphan", command: "zsh", worktreePath }, "stopped");
    return {
      projectRoot,
      path: worktreePath,
      worktrees: [],
      sessions: [],
      sessionWorktreePaths: [],
      offlineSessions: [{ id: "codex-orphan", worktreePath }],
      offlineServices: [{ id: "service-orphan", worktreePath }],
      managedWindows: [],
    };
  },
);

await record(
  cases,
  "refuses to remove the main checkout",
  "removeDesktopWorktree",
  "remove-main-checkout",
  ({ projectRoot }) => ({
    projectRoot,
    path: projectRoot,
    worktrees: [{ name: "Main Checkout", branch: "main", path: projectRoot, createdAt: "2026-05-01T00:00:00.000Z" }],
    sessions: [],
    sessionWorktreePaths: [],
    managedWindows: [],
  }),
);

await record(
  cases,
  "blocks removing a worktree while a live agent is attached",
  "removeDesktopWorktree",
  "remove-live-agent",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "demo");
    mkdirSync(worktreeRoot, { recursive: true });
    execFileSync("git", ["worktree", "add", "-q", "-b", "demo", worktreePath], { cwd: projectRoot });
    return {
      projectRoot,
      path: worktreePath,
      worktrees: [{ name: "demo", branch: "demo", path: worktreePath, createdAt: "2026-05-01T00:00:00.000Z" }],
      sessions: [{ id: "codex-live", label: "Codex Live" }],
      liveSessionIds: ["codex-live"],
      sessionWorktreePaths: [["codex-live", worktreePath]],
      managedWindows: [],
    };
  },
);

await record(
  cases,
  "keeps existing worktree removal pending when fallback worktree listing fails",
  "removeDesktopWorktree",
  "remove-existing-pending-list-fails",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "demo");
    return {
      projectRoot,
      path: worktreePath,
      listDesktopWorktreesError: "worktree list unavailable",
      pendingWorktreeRemovals: [[worktreePath, { path: worktreePath, status: "removed" }]],
      worktrees: [],
      dashboardWorktreeGroupsCache: [],
      sessions: [],
      sessionWorktreePaths: [],
      managedWindows: [],
    };
  },
);

await record(
  cases,
  "refuses to graveyard the main checkout",
  "graveyardDesktopWorktree",
  "graveyard-main-checkout",
  ({ projectRoot }) => ({
    projectRoot,
    path: projectRoot,
    worktrees: [{ name: "Main Checkout", branch: "main", path: projectRoot, createdAt: "2026-05-01T00:00:00.000Z" }],
    sessions: [],
    sessionWorktreePaths: [],
    managedWindows: [],
  }),
);

await record(
  cases,
  "does not detach worktree services when graveyarding is blocked by a live agent",
  "graveyardDesktopWorktree",
  "graveyard-live-agent-keeps-service",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "demo");
    const service = {
      id: "service-1",
      command: "shell",
      label: "shell",
      worktreePath,
    };
    const serviceTarget = { sessionName: "aimux", windowId: "@service", windowIndex: 1, windowName: "service" };
    return {
      projectRoot,
      path: worktreePath,
      worktrees: [{ name: "demo", branch: "demo", path: worktreePath, isBare: false }],
      sessions: [{ id: "claude-1", command: "claude", label: "claude" }],
      liveSessionIds: ["claude-1"],
      sessionWorktreePaths: [["claude-1", worktreePath]],
      offlineServices: [service],
      managedWindows: [
        {
          target: serviceTarget,
          metadata: { kind: "service", sessionId: service.id, worktreePath },
        },
      ],
    };
  },
);

await record(
  cases,
  "resurrects topology worktree graveyard entries",
  "resurrectGraveyardWorktree",
  "resurrect",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "demo");
    mkdirSync(worktreePath, { recursive: true });
    topologyWorktrees.upsertTopologyWorktree({ path: worktreePath, name: "demo", branch: "demo" }, "active");
    topologyWorktrees.moveTopologyWorktreeToGraveyard(worktreePath);
    return { projectRoot, path: worktreePath };
  },
);

await record(
  cases,
  "does not resurrect graveyarded worktrees when the checkout is missing",
  "resurrectGraveyardWorktree",
  "resurrect-missing",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "missing");
    topologyWorktrees.upsertTopologyWorktree({ path: worktreePath, name: "missing", branch: "missing" }, "active");
    topologyWorktrees.moveTopologyWorktreeToGraveyard(worktreePath);
    return { projectRoot, path: worktreePath };
  },
);

await record(
  cases,
  "reports missing graveyard entries when deleting a worktree",
  "deleteGraveyardWorktree",
  "delete-graveyard-missing-entry",
  ({ projectRoot, worktreeRoot }) => ({
    projectRoot,
    path: join(worktreeRoot, "missing"),
    offlineSessions: [],
    offlineServices: [],
  }),
);

await record(
  cases,
  "deletes missing graveyarded worktree topology and dependent assets",
  "deleteGraveyardWorktree",
  "delete-missing",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "gone");
    topologyWorktrees.upsertTopologyWorktree({ path: worktreePath, name: "gone", branch: "gone" }, "active");
    topologySessions.upsertTopologySession(
      { id: "codex-gone", tool: "codex", command: "codex", args: [], worktreePath },
      "offline",
    );
    topologyServices.upsertTopologyService({ id: "service-gone", command: "zsh", worktreePath }, "stopped");
    topologyWorktrees.moveTopologyWorktreeToGraveyard(worktreePath);
    return {
      projectRoot,
      path: worktreePath,
      offlineSessions: [{ id: "codex-gone", worktreePath }],
      offlineServices: [{ id: "service-gone", worktreePath }],
    };
  },
);

await record(
  cases,
  "deletes existing graveyarded worktree checkouts even when hidden from active lists",
  "deleteGraveyardWorktree",
  "delete-existing-hidden-checkout",
  ({ projectRoot, tmpRoot }) => {
    const externalRoot = join(tmpRoot, "external-worktrees");
    mkdirSync(externalRoot, { recursive: true });
    const worktreePath = join(externalRoot, "demo");
    execFileSync("git", ["worktree", "add", "-q", "-b", "external-demo", worktreePath], { cwd: projectRoot });
    topologyWorktrees.upsertTopologyWorktree({ path: worktreePath, name: "demo", branch: "external-demo" }, "active");
    topologySessions.upsertTopologySession(
      { id: "codex-demo", tool: "codex", command: "codex", args: [], worktreePath },
      "offline",
    );
    topologyServices.upsertTopologyService({ id: "service-demo", command: "zsh", worktreePath }, "stopped");
    topologyWorktrees.moveTopologyWorktreeToGraveyard(worktreePath);
    return {
      projectRoot,
      path: worktreePath,
      worktrees: [],
      offlineSessions: [{ id: "codex-demo", worktreePath }],
      offlineServices: [{ id: "service-demo", worktreePath }],
    };
  },
);

await record(
  cases,
  "keeps graveyard entries visible when delete physical removal fails",
  "deleteGraveyardWorktree",
  "delete-physical-removal-fails",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "physical-fails");
    mkdirSync(worktreePath, { recursive: true });
    topologyWorktrees.upsertTopologyWorktree(
      { path: worktreePath, name: "physical-fails", branch: "physical-fails" },
      "active",
    );
    topologySessions.upsertTopologySession(
      { id: "codex-physical-fails", tool: "codex", command: "codex", args: [], worktreePath },
      "offline",
    );
    topologyWorktrees.moveTopologyWorktreeToGraveyard(worktreePath);
    const contextDir = join(paths.getContextDir(), "codex-physical-fails");
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(paths.getRecordingsDir(), { recursive: true });
    const recording = join(paths.getRecordingsDir(), "codex-physical-fails.log");
    writeFileSync(join(contextDir, "live.md"), "live\n");
    writeFileSync(recording, "raw\n");
    return {
      projectRoot,
      path: worktreePath,
      pathExistsButNotGitWorktree: true,
      offlineSessions: [{ id: "codex-physical-fails", worktreePath }],
      offlineServices: [],
      checkPaths: [
        { label: "context", path: contextDir },
        { label: "recording", path: recording },
      ],
    };
  },
);

await record(
  cases,
  "resurrects graveyard sessions into offline topology state",
  "resurrectGraveyardSession",
  "resurrect-session-parent",
  ({ projectRoot }) => {
    const parent = { id: "claude-parent", command: "claude", toolConfigKey: "claude", args: [] };
    const teammate = {
      id: "codex-reviewer",
      command: "codex",
      toolConfigKey: "codex",
      args: [],
      team: { teamId: "team-claude-parent", parentSessionId: "claude-parent", role: "reviewer" },
    };
    const nested = {
      id: "claude-nested",
      command: "claude",
      toolConfigKey: "claude",
      args: [],
      team: { teamId: "team-codex-reviewer", parentSessionId: "codex-reviewer", role: "reviewer" },
    };
    const independent = { id: "codex-independent", command: "codex", toolConfigKey: "codex", args: [] };
    for (const session of [parent, teammate, nested, independent]) {
      topologySessions.upsertTopologySession(
        { ...session, tool: session.command, lifecycle: "offline", worktreePath: projectRoot },
        "graveyard",
      );
    }
    return {
      projectRoot,
      sessionId: "claude-parent",
      offlineSessions: [],
      mode: "project-service",
    };
  },
);

await record(
  cases,
  "blocks graveyard session resurrection when its worktree is missing",
  "resurrectGraveyardSession",
  "resurrect-session-missing-worktree",
  ({ projectRoot }) => {
    const missingWorktree = join(projectRoot, "deleted-worktree");
    topologySessions.upsertTopologySession(
      {
        id: "codex-missing-worktree",
        tool: "codex",
        toolConfigKey: "codex",
        command: "codex",
        args: [],
        lifecycle: "offline",
        worktreePath: missingWorktree,
      },
      "graveyard",
    );
    return {
      projectRoot,
      sessionId: "codex-missing-worktree",
      offlineSessions: [],
      mode: "project-service",
    };
  },
);

await record(
  cases,
  "resurrects teammate graveyard sessions without resurrecting the parent",
  "resurrectGraveyardSession",
  "resurrect-session-teammate",
  ({ projectRoot }) => {
    const parent = { id: "claude-parent", command: "claude", toolConfigKey: "claude", args: [] };
    const teammate = {
      id: "codex-reviewer",
      command: "codex",
      toolConfigKey: "codex",
      args: [],
      team: { teamId: "team-claude-parent", parentSessionId: "claude-parent", role: "reviewer" },
    };
    for (const session of [parent, teammate]) {
      topologySessions.upsertTopologySession(
        { ...session, tool: session.command, lifecycle: "offline", worktreePath: projectRoot },
        "graveyard",
      );
    }
    return {
      projectRoot,
      sessionId: "codex-reviewer",
      offlineSessions: [],
      mode: "project-service",
    };
  },
);

await record(
  cases,
  "cleans up expired standalone graveyard agents and refreshes projections",
  "cleanupGraveyard",
  "cleanup-graveyard-agent",
  () => {
    topologySessions.upsertTopologySession(
      {
        id: "codex-old",
        tool: "codex",
        toolConfigKey: "codex",
        command: "codex",
        args: [],
        createdAt: "2026-05-01T00:00:00.000Z",
      },
      "offline",
      { now: "2026-05-01T00:00:00.000Z" },
    );
    topologySessions.moveTopologySessionToGraveyard("codex-old", { now: "2026-05-30T00:00:00.000Z" });
    return {
      cleanupInput: { now: "2026-06-14T00:00:00.000Z" },
      offlineSessions: [{ id: "codex-old" }],
      mode: "project-service",
    };
  },
);

await record(
  cases,
  "cleans generated cache directories from inactive Aimux worktrees",
  "cleanupWorktreeCaches",
  "cleanup-cache-inactive",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "cache");
    const cachePath = join(worktreePath, "apps", "web", ".next");
    mkdirSync(cachePath, { recursive: true });
    writeFileSync(join(cachePath, "build.txt"), "cache\n");
    return {
      projectRoot,
      cleanupInput: { dryRun: false },
      worktrees: [{ name: "cache", branch: "cache", path: worktreePath, isBare: false }],
      checkPaths: [{ label: "cache", path: cachePath }],
    };
  },
);

await record(
  cases,
  "skips cache cleanup for worktrees with active runtime",
  "cleanupWorktreeCaches",
  "cleanup-cache-topology-active",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "live");
    const cachePath = join(worktreePath, "node_modules");
    mkdirSync(cachePath, { recursive: true });
    writeFileSync(join(cachePath, "dep.txt"), "cache\n");
    topologySessions.upsertTopologySession(
      { id: "codex-live", tool: "codex", command: "codex", args: [], worktreePath },
      "running",
      { projectRoot },
    );
    return {
      projectRoot,
      cleanupInput: { dryRun: false },
      worktrees: [{ name: "live", branch: "live", path: worktreePath, isBare: false }],
      checkPaths: [{ label: "cache", path: cachePath }],
    };
  },
);

await record(
  cases,
  "skips cache cleanup when host-local live sessions have not reached topology yet",
  "cleanupWorktreeCaches",
  "cleanup-cache-host-live",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "host-live");
    const cachePath = join(worktreePath, ".next");
    mkdirSync(cachePath, { recursive: true });
    writeFileSync(join(cachePath, "build.txt"), "cache\n");
    return {
      projectRoot,
      cleanupInput: { dryRun: false },
      worktrees: [{ name: "host-live", branch: "host-live", path: worktreePath, isBare: false }],
      sessions: [{ id: "codex-host-live", command: "codex" }],
      sessionWorktreePaths: [["codex-host-live", worktreePath]],
      liveSessionIds: ["codex-host-live"],
      checkPaths: [{ label: "cache", path: cachePath }],
    };
  },
);

await record(
  cases,
  "starts scheduled graveyard cleanup with the configured interval",
  "startGraveyardCleanup",
  "start-graveyard-cleanup",
  () => ({}),
);

await record(
  cases,
  "does not start a second scheduled graveyard cleanup interval",
  "startGraveyardCleanup",
  "start-graveyard-cleanup-existing",
  () => ({ graveyardCleanupInterval: "<existing-graveyard-interval>" }),
);

await record(
  cases,
  "stops scheduled graveyard cleanup and clears the host interval",
  "stopGraveyardCleanup",
  "stop-graveyard-cleanup",
  () => ({ graveyardCleanupInterval: "<existing-graveyard-interval>" }),
);

await record(
  cases,
  "starts scheduled inbox cleanup with the configured interval",
  "startInboxCleanup",
  "start-inbox-cleanup",
  () => ({}),
);

await record(
  cases,
  "does not start a second scheduled inbox cleanup interval",
  "startInboxCleanup",
  "start-inbox-cleanup-existing",
  () => ({ inboxCleanupInterval: "<existing-inbox-interval>" }),
);

await record(
  cases,
  "stops scheduled inbox cleanup and clears the host interval",
  "stopInboxCleanup",
  "stop-inbox-cleanup",
  () => ({ inboxCleanupInterval: "<existing-inbox-interval>" }),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/persistence-methods.test.ts",
  generatedBy: "scripts/capture-multiplexer-persistence-worktrees-contract.mjs",
  description:
    "Multiplexer persistence worktree create, remove, graveyard, resurrection, deletion, session resurrection, host side effects, operation failures, and topology transitions captured by running TypeScript persistenceMethods against temp git repos and topology state.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
