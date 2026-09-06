#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("src/multiplexer/dashboard-project-event-refresh.contract.v1.json", ROOT);
const { EVENT_REFRESH_DEBOUNCE_MS, handleProjectEvent, scheduleProjectViewRefresh, stopDashboardProjectEventStream } =
  await import(new URL("dist/multiplexer/project-event-stream.js", ROOT));
const { PROJECT_API_ROUTES, PROJECT_API_VIEWS } = await import(new URL("dist/project-api-contract.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function projectPayload() {
  return {
    ok: true,
    project: {
      summary: {
        agentsRunning: 1,
        agentsWaiting: 0,
        agentsOffline: 0,
        services: 0,
        worktrees: 1,
        openTasks: 1,
        doneTasks: 0,
        unreadNotifications: 0,
      },
      progress: { pending: 0, assigned: 1, in_progress: 0, blocked: 0, done: 0, failed: 0, total: 1 },
      story: [{ id: "task:1", kind: "task", title: "Task", meta: "assigned", createdAt: "now" }],
    },
  };
}

function topologyPayload() {
  return {
    ok: true,
    topology: {
      projectName: "mobile",
      health: "active",
      counts: { worktrees: 1, agents: 1, services: 0 },
      worktrees: [{ name: "mobile", branch: "master", health: "active", agents: 1, services: 0, path: "/repo/mobile" }],
      rows: [{ kind: "worktree", depth: 0, label: "mobile", health: "active", detail: "master" }],
    },
  };
}

function libraryPayload() {
  return {
    ok: true,
    entries: [{ id: "doc:1", kind: "doc", title: "Readme", path: "README.md", updatedAt: "now", preview: "hello" }],
  };
}

function createHost(input) {
  const calls = [];
  let renders = 0;
  return {
    mode: input.mode ?? "dashboard",
    dashboardInputEpoch: 0,
    calls,
    get renders() {
      return renders;
    },
    dashboardState: { detailsSidebarVisible: false },
    isDashboardTuiVisible: () => input.visible !== false,
    isDashboardScreen: (screen) => screen === input.screen,
    getViewportSize: () => ({ cols: 120, rows: 40 }),
    centerInWidth: (text) => text,
    writeFrame: () => {
      calls.push({ kind: `${input.screen}-frame` });
    },
    wrapKeyValue: (key, value) => [`${key}: ${value}`],
    refreshDashboardModelFromService: async (force, options) => {
      calls.push({ kind: "dashboard-model", force, lifecycle: options?.lifecycle ?? null });
      if (input.modelThrows) throw new Error("model failed");
      return input.modelResult ?? true;
    },
    refreshCoordinationFromService: async (options) => {
      calls.push({ kind: "coordination", force: options?.force === true, lifecycle: options?.lifecycle ?? null });
      if (input.coordinationThrows) throw new Error("coordination failed");
      return input.coordinationResult ?? true;
    },
    getFromProjectService: async (path, options) => {
      const kind =
        path === PROJECT_API_ROUTES.projectObservability
          ? "project"
          : path === PROJECT_API_ROUTES.topology
            ? "topology"
            : path === PROJECT_API_ROUTES.library
              ? "library"
              : path === PROJECT_API_ROUTES.graveyard
                ? "graveyard"
                : path;
      calls.push({ kind, path, timeoutMs: options?.timeoutMs ?? null });
      if (input.rejectResource === kind) throw new Error(`${kind} failed`);
      if (kind === "project") return projectPayload();
      if (kind === "topology") return topologyPayload();
      if (kind === "library") return libraryPayload();
      if (kind === "graveyard")
        return { ok: true, entries: [], worktrees: [], viewModel: { rows: [], selectableRows: [] } };
      return { ok: true };
    },
    renderCurrentDashboardView: () => {
      renders += 1;
      calls.push({ kind: "render" });
    },
  };
}

async function runInput(input) {
  const host = createHost(input);
  if (input.eventName === "ready") {
    handleProjectEvent(host, "ready", { ok: true });
  } else {
    scheduleProjectViewRefresh(host, input.views ?? []);
  }
  await new Promise((resolve) => setTimeout(resolve, EVENT_REFRESH_DEBOUNCE_MS + 20));
  stopDashboardProjectEventStream(host);
  return {
    calls: host.calls.map((call) => call.kind),
    renders: host.renders,
  };
}

const cases = [];

async function record(name, input) {
  const fullInput = { name, ...input };
  cases.push({
    id: `dashboard-project-event-refresh-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/multiplexer/project-event-stream.ts",
    api: "scheduleProjectViewRefresh",
    input: fullInput,
    output: await runInput(input),
    inputSha256: hash(fullInput),
  });
}

await record("notification updates refresh model and visible coordination screen", {
  screen: "coordination",
  views: ["notifications", "coordination-worklist"],
});
await record("project observability refreshes only the project screen", {
  screen: "project",
  views: ["project-observability"],
});
await record("agent updates refresh model and visible topology screen", {
  screen: "topology",
  views: ["agents"],
});
await record("library updates refresh only the visible library screen", {
  screen: "library",
  views: ["library"],
});
await record("graveyard updates refresh only the visible graveyard screen", {
  screen: "graveyard",
  views: ["graveyard"],
});
await record("team plan and work-outline updates do not trigger dashboard refresh work", {
  screen: "coordination",
  views: ["team", "plans", "work-outline"],
});
await record("skips render when model refresh reports no applied data", {
  screen: "coordination",
  views: ["desktop-state"],
  modelResult: false,
});
await record("renders successful model refresh when coordination refresh rejects", {
  screen: "coordination",
  views: ["desktop-state", "coordination-worklist"],
  coordinationThrows: true,
});
await record("ready event refreshes every routed view for the visible screen", {
  eventName: "ready",
  screen: "library",
  views: PROJECT_API_VIEWS,
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-dashboard-project-event-refresh-contract.mjs",
  source: "src/multiplexer/project-event-stream.ts",
  subject: "DashboardProjectEventAdapter.refreshViews",
  description: "Dashboard project event refresh routing captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
