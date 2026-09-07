#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/services-runtime.json", ROOT);

const { initPaths, getProjectStateDirFor, getStatePath } = await import(new URL("dist/paths.js", ROOT));
const { createService, removeOfflineService, resumeOfflineService, resumeOfflineServiceById, stopService } = await import(
  new URL("dist/multiplexer/services.js", ROOT)
);
const { listTopologyServiceStates } = await import(new URL("dist/runtime-core/topology-services.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function fn(name, impl = () => undefined) {
  const calls = [];
  const wrapped = (...args) => {
    calls.push(normalize(args));
    return impl(...args);
  };
  wrapped.calls = calls;
  return wrapped;
}

function target(id, index, name = "shell") {
  return {
    sessionName: "aimux-repo",
    windowId: id,
    windowIndex: index,
    windowName: name,
  };
}

function createHost(input) {
  const calls = {};
  const targets = input.targets ?? {};
  const existingWindow =
    input.existingWindow === null
      ? null
      : input.existingWindow
        ? { target: input.existingWindow.target, metadata: input.existingWindow.metadata }
        : null;
  const createdTarget = targets.created ?? target("@9", 9, input.createdWindowName ?? "dev");
  const make = (name, impl) => {
    const wrapped = fn(name, impl);
    calls[name] = wrapped.calls;
    return wrapped;
  };
  const host = {
    projectRoot: input.projectRoot,
    offlineServices: structuredClone(input.offlineServices ?? []),
    startedInDashboard: input.startedInDashboard ?? false,
    mode: input.mode ?? "dashboard",
    removedServiceIds: { values: [], add(value) { this.values.push(value); } },
    tmuxRuntimeManager: {
      getProjectSession: make("tmuxRuntimeManager.getProjectSession", () => ({ sessionName: "aimux-repo" })),
      ensureProjectSession: make("tmuxRuntimeManager.ensureProjectSession", () => ({ sessionName: "aimux-repo" })),
      findManagedWindow: make("tmuxRuntimeManager.findManagedWindow", () => existingWindow),
      createWindow: make("tmuxRuntimeManager.createWindow", () => createdTarget),
      setWindowMetadata: make("tmuxRuntimeManager.setWindowMetadata"),
      applyManagedAgentWindowPolicy: make("tmuxRuntimeManager.applyManagedAgentWindowPolicy"),
      killWindow: make("tmuxRuntimeManager.killWindow", () => {
        if (input.killWindowThrows) throw new Error("kill failed");
      }),
      sendKey: make("tmuxRuntimeManager.sendKey"),
      sendText: make("tmuxRuntimeManager.sendText"),
      sendEnter: make("tmuxRuntimeManager.sendEnter"),
      hasWindow: make("tmuxRuntimeManager.hasWindow", () => input.hasWindow ?? false),
      isWindowAlive: make("tmuxRuntimeManager.isWindowAlive", () => input.isWindowAlive ?? false),
      displayMessage: make("tmuxRuntimeManager.displayMessage", () => input.displayPath),
    },
    saveState: make("saveState"),
    invalidateDesktopStateSnapshot: make("invalidateDesktopStateSnapshot"),
    refreshLocalDashboardModel: make("refreshLocalDashboardModel"),
    updateWorktreeSessions: make("updateWorktreeSessions"),
    adjustAfterRemove: make("adjustAfterRemove"),
    noteLastUsedItem: make("noteLastUsedItem"),
    preferDashboardEntrySelection: make("preferDashboardEntrySelection"),
    settleDashboardCreatePending: make("settleDashboardCreatePending"),
    setPendingDashboardServiceAction: make("setPendingDashboardServiceAction"),
  };
  return { host, calls };
}

async function withProject(input, run) {
  const repoRoot = await mkdtemp(join(tmpdir(), "aimux-services-runtime-"));
  const aimuxHome = join(repoRoot, "home");
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  try {
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(aimuxHome, { recursive: true });
    replaceProcessEnv(deterministicEnv(repoRoot, aimuxHome, input.shell ?? "zsh"));
    process.chdir(repoRoot);
    await initPaths(repoRoot);
    if (input.initialState) {
      writeFileSync(getStatePath(), JSON.stringify(denormalize(input.initialState, repoRoot), null, 2));
    }
    const materialized = denormalize({ ...input, projectRoot: "<repo>" }, repoRoot);
    const result = await run(repoRoot, materialized);
    return normalize(result, repoRoot, getProjectStateDirFor(repoRoot));
  } finally {
    process.chdir(previousCwd);
    replaceProcessEnv(previousEnv);
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function readSavedServices() {
  if (!existsSync(getStatePath())) return [];
  return JSON.parse(readFileSync(getStatePath(), "utf-8")).services ?? [];
}

function readSavedState() {
  if (!existsSync(getStatePath())) return null;
  return JSON.parse(readFileSync(getStatePath(), "utf-8"));
}

async function runCase(input) {
  return withProject(input, async (_repoRoot, materialized) => {
    const { host, calls } = createHost(materialized);
    let result = null;
    let thrown = null;
    try {
      switch (input.api) {
        case "createService":
          result = createService(host, materialized.commandLine, materialized.worktreePath, materialized.options);
          break;
        case "stopService":
          result = stopService(host, materialized.serviceId);
          break;
        case "removeOfflineService":
          result = removeOfflineService(host, materialized.serviceId);
          break;
        case "resumeOfflineService":
          result = resumeOfflineService(host, host.offlineServices[materialized.serviceIndex ?? 0]);
          break;
        case "resumeOfflineServiceByState":
          result = resumeOfflineService(host, materialized.service);
          break;
        case "resumeOfflineServiceById":
          result = resumeOfflineServiceById(host, materialized.serviceId);
          break;
        default:
          throw new Error(`unknown api ${input.api}`);
      }
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    return {
      result,
      thrown,
      host: {
        offlineServices: host.offlineServices,
        removedServiceIds: host.removedServiceIds.values,
      },
      calls,
      savedState: readSavedState(),
      savedServices: readSavedServices(),
      topologyServicesAll: listTopologyServiceStates(),
      topologyServicesRunning: listTopologyServiceStates({ statuses: ["running"] }),
      topologyServicesStopped: listTopologyServiceStates({ statuses: ["stopped"] }),
    };
  });
}

function deterministicEnv(repoRoot, aimuxHome, shell) {
  return {
    AIMUX_DAEMON_PORT: "43190",
    AIMUX_ENV: "production",
    AIMUX_HOME: aimuxHome,
    CLICOLOR: "1",
    COLORTERM: "truecolor",
    HOME: join(repoRoot, "user-home"),
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
    SHELL: shell,
    TERM: "xterm-256color",
    USER: "sam",
  };
}

function replaceProcessEnv(next) {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(next)) {
    process.env[key] = value;
  }
}

function normalize(value, repoRoot = "<repo>", projectStateDir = "<project-state>") {
  if (typeof value === "string") {
    return value
      .replaceAll(projectStateDir, "<project-state>")
      .replaceAll(repoRoot, "<repo>")
      .replaceAll(new URL(ROOT).pathname.replace(/\/$/, ""), "<root>")
      .replace(/service-[0-9a-f]{8}/g, "<service-id>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<ts>");
  }
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, repoRoot, projectStateDir));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalize(entry, repoRoot, projectStateDir)]),
    );
  }
  return value;
}

function denormalize(value, repoRoot) {
  if (typeof value === "string") {
    return value.replaceAll("<repo>", repoRoot).replaceAll("<project-state>", getProjectStateDirFor(repoRoot));
  }
  if (Array.isArray(value)) return value.map((entry) => denormalize(entry, repoRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, denormalize(entry, repoRoot)]));
  }
  return value;
}

const staleTarget = target("@12", 12, "dev");
const createdTarget = target("@13", 13, "dev");

const inputs = [
  {
    name: "kills lingering managed tmux windows when removing an offline service",
    api: "removeOfflineService",
    serviceId: "svc-1",
    offlineServices: [{ id: "svc-1", label: "shell", worktreePath: "<repo>" }],
    existingWindow: { target: target("@7", 7), metadata: { kind: "service", sessionId: "svc-1" } },
  },
  {
    name: "preserves unrelated state keys when committing service removals",
    api: "removeOfflineService",
    serviceId: "svc-1",
    offlineServices: [],
    initialState: {
      savedAt: "old",
      cwd: "/old",
      sessions: { "codex-1": { id: "codex-1" } },
      services: [{ id: "svc-1", label: "shell", status: "offline" }],
    },
    existingWindow: null,
  },
  {
    name: "does not resurrect stale state service rows while committing created services",
    api: "createService",
    commandLine: "yarn dev",
    worktreePath: "<repo>",
    options: { serviceId: "svc-live" },
    initialState: {
      savedAt: "old",
      cwd: "/old",
      services: [{ id: "svc-stale", label: "stale", launchCommandLine: "yarn stale" }],
    },
    existingWindow: null,
    targets: { created: target("@9", 9, "dev") },
  },
  {
    name: "stops a running service by killing its tmux window and saving an offline record",
    api: "stopService",
    serviceId: "svc-1",
    offlineServices: [],
    displayPath: "<repo>/apps/web",
    existingWindow: {
      target: target("@7", 7),
      metadata: {
        kind: "service",
        sessionId: "svc-1",
        command: "shell",
        args: ["-l"],
        label: "shell",
        worktreePath: "<repo>",
        createdAt: "2026-05-02T00:00:00.000Z",
      },
    },
  },
  {
    name: "falls back to Ctrl-C when killing a running service window fails",
    api: "stopService",
    serviceId: "svc-1",
    offlineServices: [],
    killWindowThrows: true,
    existingWindow: {
      target: target("@8", 8),
      metadata: { kind: "service", sessionId: "svc-1", command: "shell", args: ["-l"], label: "shell" },
    },
  },
  {
    name: "kills a retained service window when removing an offline service",
    api: "removeOfflineService",
    serviceId: "svc-1",
    offlineServices: [{ id: "svc-1", label: "shell", tmuxTarget: target("@8", 8), retained: true }],
    existingWindow: null,
    hasWindow: true,
  },
  {
    name: "wraps created service commands to drop into an interactive shell on failure",
    api: "createService",
    commandLine: "yarn dev",
    worktreePath: "<repo>",
    options: { serviceId: "svc-live" },
    existingWindow: null,
    targets: { created: target("@9", 9, "dev") },
  },
  {
    name: "wraps resumed service commands to drop into an interactive shell on failure",
    api: "resumeOfflineService",
    serviceIndex: 0,
    offlineServices: [{ id: "svc-1", label: "dev", worktreePath: "<repo>", launchCommandLine: "yarn dev", createdAt: "" }],
    existingWindow: null,
    targets: { created: target("@11", 11, "dev") },
  },
  {
    name: "restarts a legacy retained service command in a fresh tmux window",
    api: "resumeOfflineService",
    serviceIndex: 0,
    offlineServices: [
      {
        id: "svc-1",
        label: "dev",
        worktreePath: "<repo>",
        cwd: "<repo>/apps/web",
        launchCommandLine: "yarn dev",
        createdAt: "2026-05-02T00:00:00.000Z",
        tmuxTarget: staleTarget,
        retained: true,
      },
    ],
    existingWindow: { target: staleTarget, metadata: { kind: "service", sessionId: "svc-1" } },
    isWindowAlive: true,
    targets: { created: createdTarget },
  },
  {
    name: "creates a new window when a retained service window is gone",
    api: "resumeOfflineService",
    serviceIndex: 0,
    offlineServices: [
      {
        id: "svc-1",
        label: "dev",
        worktreePath: "<repo>",
        cwd: "<repo>/apps/web",
        launchCommandLine: "yarn dev",
        tmuxTarget: staleTarget,
        retained: true,
      },
    ],
    existingWindow: null,
    targets: { created: createdTarget },
  },
  {
    name: "resume by id returns running for a live managed service window",
    api: "resumeOfflineServiceById",
    serviceId: "svc-live",
    offlineServices: [],
    existingWindow: {
      target: target("@14", 14, "dev"),
      metadata: {
        kind: "service",
        sessionId: "svc-live",
        command: "zsh",
        args: ["-lc", "yarn dev"],
        label: "dev",
        worktreePath: "<repo>",
        launchCommandLine: "yarn dev",
      },
    },
    isWindowAlive: true,
  },
  {
    name: "resume by id throws when no offline or managed service exists",
    api: "resumeOfflineServiceById",
    serviceId: "svc-missing",
    offlineServices: [],
    existingWindow: null,
  },
  {
    name: "resume by id rebuilds state from a dead managed service window",
    api: "resumeOfflineServiceById",
    serviceId: "svc-dead",
    offlineServices: [],
    existingWindow: {
      target: target("@15", 15, "dev-old"),
      metadata: {
        kind: "service",
        sessionId: "svc-dead",
        command: "zsh",
        args: ["-lc", "pnpm dev"],
        label: "pnpm",
        worktreePath: "<repo>",
        launchCommandLine: "pnpm dev",
      },
    },
    isWindowAlive: false,
    targets: { created: target("@16", 16, "pnpm") },
  },
  {
    name: "seeds an optimistic service row during dashboard create",
    api: "createService",
    commandLine: "yarn dev",
    worktreePath: "<repo>",
    startedInDashboard: true,
    mode: "dashboard",
    existingWindow: null,
    targets: { created: target("@9", 9, "dev") },
  },
  {
    name: "creates a blank interactive shell service",
    api: "createService",
    commandLine: "   ",
    worktreePath: "<repo>",
    options: { serviceId: "svc-shell" },
    existingWindow: null,
    targets: { created: target("@17", 17, "shell") },
  },
  {
    name: "resumes a blank interactive shell service",
    api: "resumeOfflineService",
    serviceIndex: 0,
    offlineServices: [{ id: "svc-shell", label: "shell", worktreePath: "<repo>", launchCommandLine: "   ", createdAt: "" }],
    existingWindow: null,
    targets: { created: target("@18", 18, "shell") },
  },
  {
    name: "stop throws when the matching window metadata is not a service",
    api: "stopService",
    serviceId: "svc-agent",
    offlineServices: [],
    existingWindow: {
      target: target("@19", 19, "codex"),
      metadata: { kind: "agent", sessionId: "svc-agent", command: "codex", args: [] },
    },
  },
  {
    name: "remove skips killing an existing non-service window",
    api: "removeOfflineService",
    serviceId: "svc-agent",
    offlineServices: [{ id: "svc-agent", label: "shell", worktreePath: "<repo>" }],
    existingWindow: {
      target: target("@20", 20, "codex"),
      metadata: { kind: "agent", sessionId: "svc-agent", command: "codex", args: [] },
    },
  },
  {
    name: "resume by id throws when the matching window metadata is not a service",
    api: "resumeOfflineServiceById",
    serviceId: "svc-agent",
    offlineServices: [],
    existingWindow: {
      target: target("@21", 21, "codex"),
      metadata: { kind: "agent", sessionId: "svc-agent", command: "codex", args: [] },
    },
  },
];

const cases = [];
for (const [index, input] of inputs.entries()) {
  const normalizedInput = normalize(input);
  cases.push({
    id: `multiplexer-services-runtime-${String(index + 1).padStart(3, "0")}`,
    name: input.name,
    source: "src/multiplexer/services.test.ts",
    api: input.api,
    input: normalizedInput,
    output: await runCase(normalizedInput),
    inputSha256: hash(normalizedInput),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/services.test.ts",
  generatedBy: "scripts/capture-multiplexer-services-runtime-contract.mjs",
  description:
    "Multiplexer service create/stop/remove/resume side-effect contracts captured by running TypeScript services helpers against deterministic fake tmux hosts and temp state files.",
  normalization: {
    paths: { repoRoot: "<repo>", sourceRoot: "<root>" },
    ids: { generatedServiceIds: "<service-id>" },
    timestamps: "<ts>",
  },
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
