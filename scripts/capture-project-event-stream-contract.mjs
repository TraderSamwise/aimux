#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import prettier from "prettier";
import ts from "typescript";

const ROOT = new URL("../", import.meta.url);
const SOURCE_URL = new URL("src/multiplexer/project-event-stream.ts", ROOT);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/project-event-stream.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function importProjectEventStream() {
  const source = (await readFile(SOURCE_URL, "utf8")).replace(/import\s+[\s\S]*?from\s+["'][^"']+["'];\n/g, "");
  const prelude = `
const TextDecoder = globalThis.TextDecoder;
const PROJECT_API_EVENT_NAMES = {
  ready: "ready",
  alert: "alert",
  agentOutput: "agent_output",
  projectUpdate: "project_update",
  error: "error",
};
const PROJECT_API_VIEWS = [
  "agents",
  "coordination-worklist",
  "desktop-state",
  "graveyard",
  "library",
  "notifications",
  "plans",
  "project-observability",
  "services",
  "team",
  "tasks",
  "threads",
  "topology",
  "work-outline",
  "worktrees",
];
const PROJECT_API_ROUTES = {
  events: "/events",
  projectObservability: "/project-observability",
  topology: "/topology",
  library: "/library",
  graveyard: "/graveyard",
};
let __debugCalls = [];
let __controlCalls = [];
let __endpointResponses = [];
let __fetchResponses = [];
let __fetchCalls = [];
let __streams = new Map();
let __timerNow = 0;
let __nextTimerId = 1;
let __timers = [];
export function __resetHarness(input = {}) {
  __debugCalls = [];
  __controlCalls = [];
  __endpointResponses = (input.endpointResponses ?? [{ type: "null" }]).slice();
  __fetchResponses = (input.fetchResponses ?? []).slice();
  __fetchCalls = [];
  __streams = new Map();
  __timerNow = 0;
  __nextTimerId = 1;
  __timers = [];
}
export function __calls() {
  return { debug: __debugCalls, control: __controlCalls, fetch: __fetchCalls };
}
export function __timerState() {
  return { now: __timerNow, pending: __timers.map((timer) => ({ id: timer.id, at: timer.at })) };
}
export async function __advanceTimersByTimeAsync(ms) {
  const target = __timerNow + ms;
  while (true) {
    const due = __timers
      .filter((timer) => timer.at <= target)
      .sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!due) break;
    __timers = __timers.filter((timer) => timer !== due);
    __timerNow = due.at;
    due.fn();
    await __flushMicrotasks();
  }
  __timerNow = target;
  await __flushMicrotasks();
}
export async function __runAllTimersAsync(limit = 100) {
  let count = 0;
  while (__timers.length > 0 && count < limit) {
    const next = __timers.sort((a, b) => a.at - b.at || a.id - b.id)[0];
    await __advanceTimersByTimeAsync(Math.max(0, next.at - __timerNow));
    count += 1;
  }
  await __flushMicrotasks();
}
export async function __enqueueStream(label, text) {
  const stream = __streams.get(label);
  if (!stream) throw new Error("unknown stream " + label);
  stream.enqueue(new TextEncoder().encode(text));
  await __flushMicrotasks();
}
function setTimeout(fn, delay = 0) {
  const timer = { id: __nextTimerId++, at: __timerNow + delay, fn, unref() {} };
  __timers.push(timer);
  return timer;
}
function clearTimeout(timer) {
  __timers = __timers.filter((item) => item !== timer);
}
async function __flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
function debug(message, scope) {
  __debugCalls.push({ message, scope });
}
async function resolveCurrentProjectServiceEndpointForDashboard(host, timeoutMs) {
  __controlCalls.push({ fn: "resolveCurrentProjectServiceEndpointForDashboard", timeoutMs });
  const next = __endpointResponses.shift() ?? { type: "null" };
  if (next.type === "reject") throw new Error(next.message ?? "metadata stale");
  if (next.type === "endpoint") return next.endpoint;
  return null;
}
function invalidateDashboardProjectServiceEndpointHealth(_host) {
  __controlCalls.push({ fn: "invalidateDashboardProjectServiceEndpointHealth" });
}
function captureDashboardLifecycle(host, opts = {}) {
  return {
    mode: host.mode === undefined || host.mode === "dashboard" ? "dashboard" : "other",
    inputEpoch: opts.inputEpoch && typeof host.dashboardInputEpoch === "number" ? host.dashboardInputEpoch : undefined,
    requiresInputEpoch: opts.inputEpoch ? true : undefined,
    screen: opts.screen,
  };
}
function isDashboardLifecycleCurrent(host, token) {
  if (host.mode !== undefined && host.mode !== "dashboard") return false;
  if (token?.mode && token.mode !== "dashboard") return false;
  if (token?.requiresInputEpoch || token?.inputEpoch !== undefined) {
    if (typeof host.dashboardInputEpoch !== "number") return false;
    if (host.dashboardInputEpoch !== token.inputEpoch) return false;
  }
  if (!token?.screen) return true;
  return host.isDashboardScreen?.(token.screen) === true;
}
function isDashboardTuiVisible(host) {
  return host.visible !== false;
}
async function refreshDashboardModelThroughApi(host, options = {}) {
  host.calls.push({ kind: "dashboard-model", force: options.force === true, lifecycle: options.lifecycle ?? null });
  if (host.modelThrows) throw new Error("model failed");
  if (host.modelPendingLabel) return await host.pending[host.modelPendingLabel].promise;
  return { status: "ok", ok: host.modelResult ?? true };
}
async function refreshProjectObservability(host, options = {}) {
  host.calls.push({ kind: "project", force: options.force === true, lifecycle: options.lifecycle ?? null });
  if (host.rejectResource === "project") throw new Error("project failed");
  const value = host.resourcePendingLabel ? await host.pending[host.resourcePendingLabel].promise : projectPayload();
  if (!isDashboardLifecycleCurrent(host, options.lifecycle)) return false;
  host.projectObservability = value.project;
  host.projectObservabilityLoaded = true;
  return true;
}
async function refreshTopology(host, options = {}) {
  host.calls.push({ kind: "topology", force: options.force === true, lifecycle: options.lifecycle ?? null });
  if (host.rejectResource === "topology") throw new Error("topology failed");
  if (!isDashboardLifecycleCurrent(host, options.lifecycle)) return false;
  host.topology = topologyPayload().topology;
  return true;
}
async function refreshLibrary(host, options = {}) {
  host.calls.push({ kind: "library", force: options.force === true, lifecycle: options.lifecycle ?? null });
  if (host.rejectResource === "library") throw new Error("library failed");
  if (!isDashboardLifecycleCurrent(host, options.lifecycle)) return false;
  host.libraryEntries = libraryPayload().entries;
  return true;
}
async function refreshGraveyardEntriesFromService(host, options = {}) {
  host.calls.push({ kind: "graveyard", force: options.force === true, lifecycle: options.lifecycle ?? null });
  if (host.rejectResource === "graveyard") throw new Error("graveyard failed");
  if (!isDashboardLifecycleCurrent(host, options.lifecycle)) return false;
  host.calls.push({ kind: "graveyard-frame" });
  return true;
}
async function fetch(url, init) {
  __fetchCalls.push({ url, headers: init?.headers ?? null, hasSignal: !!init?.signal });
  const next = __fetchResponses.shift() ?? { type: "reject", message: "ECONNREFUSED" };
  if (next.type === "reject") throw new Error(next.message ?? "ECONNREFUSED");
  if (next.type === "status") return { ok: false, status: next.status ?? 503, body: null };
  if (next.type === "streamError") return { ok: true, body: fakeBody({ error: new Error(next.message ?? "read ECONNRESET") }) };
  if (next.type === "stream") return { ok: true, body: fakeBody({ label: next.label }) };
  return { ok: true, body: fakeBody({ chunks: next.chunks ?? [], closed: true }) };
}
function fakeBody(input) {
  const state = {
    chunks: (input.chunks ?? []).map((chunk) => new TextEncoder().encode(chunk)),
    pending: null,
    error: input.error ?? null,
    closed: input.closed === true,
  };
  if (input.label) __streams.set(input.label, {
    enqueue(chunk) {
      if (state.pending) {
        const pending = state.pending;
        state.pending = null;
        pending.resolve({ done: false, value: chunk });
      } else {
        state.chunks.push(chunk);
      }
    },
  });
  return {
    getReader() {
      return {
        read() {
          if (state.error) return Promise.reject(state.error);
          if (state.chunks.length > 0) return Promise.resolve({ done: false, value: state.chunks.shift() });
          if (state.closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve, reject) => {
            state.pending = { resolve, reject };
          });
        },
        cancel() {
          state.closed = true;
          if (state.pending) {
            const pending = state.pending;
            state.pending = null;
            pending.resolve({ done: true, value: undefined });
          }
          return Promise.resolve();
        },
        releaseLock() {},
      };
    },
  };
}
function projectPayload(title = "SSE project update") {
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
      story: [{ id: "task:1", kind: "task", title, meta: "assigned", createdAt: "now" }],
    },
  };
}
function topologyPayload() {
  return {
    ok: true,
    topology: { projectName: "mobile", health: "active", counts: { worktrees: 1, agents: 1, services: 0 } },
  };
}
function libraryPayload() {
  return { ok: true, entries: [{ id: "doc:1", title: "Readme" }] };
}
`;
  const transpiled = ts.transpileModule(`${prelude}\n${source}`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: SOURCE_URL.pathname,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const api = await importProjectEventStream();
const endpoint = { host: "127.0.0.1", port: 43444, pid: 1234, updatedAt: "2026-09-07T00:00:00.000Z" };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHost(input) {
  const host = {
    mode: input.mode ?? "dashboard",
    dashboardInputEpoch: input.dashboardInputEpoch ?? 0,
    visible: input.visible ?? true,
    screen: input.screen ?? null,
    calls: [],
    renders: 0,
    modelThrows: input.modelThrows === true,
    modelResult: input.modelResult,
    rejectResource: input.rejectResource ?? null,
    pending: {},
    modelPendingLabel: input.modelPendingLabel,
    resourcePendingLabel: input.resourcePendingLabel,
    projectObservability: input.initialProjectTitle
      ? localProjectPayload(input.initialProjectTitle).project
      : undefined,
    projectObservabilityLoaded: input.initialProjectTitle ? true : undefined,
    isDashboardScreen(screen) {
      return this.screen === screen;
    },
    async refreshCoordinationFromService(options = {}) {
      this.calls.push({ kind: "coordination", force: options.force === true, lifecycle: options.lifecycle ?? null });
      if (input.coordinationThrows) throw new Error("coordination unavailable");
      return input.coordinationResult ?? true;
    },
    renderCurrentDashboardView() {
      this.renders += 1;
      this.calls.push({ kind: "render" });
    },
  };
  for (const label of input.pendingLabels ?? []) {
    host.pending[label] = deferred();
  }
  return host;
}

function serializeHost(host) {
  return {
    mode: host.mode,
    screen: host.screen,
    visible: host.visible,
    calls: host.calls,
    renders: host.renders,
    footerFlash: host.footerFlash ?? null,
    footerFlashTicks: host.footerFlashTicks ?? null,
    projectStoryTitle: host.projectObservability?.story?.[0]?.title ?? null,
    projectObservabilityLoaded: host.projectObservabilityLoaded === true,
    hasAdapter: !!host.tuiProjectEventAdapter,
  };
}

function localProjectPayload(title = "SSE project update") {
  return {
    ok: true,
    project: {
      story: [{ title }],
    },
  };
}

async function run(input) {
  api.__resetHarness({
    endpointResponses: input.endpointResponses,
    fetchResponses: input.fetchResponses,
  });
  const host = createHost(input);
  for (const op of input.ops) {
    if (op.op === "schedule") {
      api.scheduleProjectViewRefresh(host, op.views);
    } else if (op.op === "handle") {
      api.handleProjectEvent(host, op.name, op.payload);
    } else if (op.op === "start") {
      api.startDashboardProjectEventStream(host);
    } else if (op.op === "stop") {
      api.stopDashboardProjectEventStream(host);
    } else if (op.op === "applyAlert") {
      api.applyDashboardAlert(host, op.event);
    } else if (op.op === "advance") {
      await api.__advanceTimersByTimeAsync(op.ms);
    } else if (op.op === "runAll") {
      await api.__runAllTimersAsync();
    } else if (op.op === "setMode") {
      host.mode = op.mode;
    } else if (op.op === "setScreen") {
      host.screen = op.screen;
    } else if (op.op === "setVisible") {
      host.visible = op.visible;
    } else if (op.op === "setInputEpoch") {
      host.dashboardInputEpoch = op.value;
    } else if (op.op === "resolvePending") {
      host.pending[op.label].resolve(op.value);
      await api.__advanceTimersByTimeAsync(0);
    } else if (op.op === "rejectPending") {
      host.pending[op.label].reject(new Error(op.message ?? "failed"));
      await api.__advanceTimersByTimeAsync(0);
    } else if (op.op === "enqueue") {
      await api.__enqueueStream(op.label, op.text);
    } else {
      throw new Error(`unknown op ${op.op}`);
    }
  }
  return {
    host: serializeHost(host),
    calls: api.__calls(),
    timers: api.__timerState(),
  };
}

const alertEvent = {
  type: "alert",
  kind: "task_failed",
  projectId: "project",
  title: "Task failed",
  message: "Failure",
  ts: "2026-09-07T00:00:00.000Z",
};

const scenarios = [
  {
    name: "refreshes dashboard model and current coordination view for notification updates",
    screen: "coordination",
    ops: [{ op: "schedule", views: ["notifications", "coordination-worklist"] }, { op: "runAll" }],
  },
  {
    name: "keeps SSE data refreshes when input changes during the request",
    screen: "coordination",
    pendingLabels: ["model"],
    modelPendingLabel: "model",
    ops: [
      { op: "schedule", views: ["notifications", "coordination-worklist"] },
      { op: "advance", ms: 250 },
      { op: "setInputEpoch", value: 1 },
      { op: "resolvePending", label: "model", value: { status: "ok", ok: true } },
      { op: "runAll" },
    ],
  },
  {
    name: "serializes event refreshes that arrive while a refresh is in flight",
    pendingLabels: ["model"],
    modelPendingLabel: "model",
    ops: [
      { op: "schedule", views: ["desktop-state"] },
      { op: "advance", ms: 250 },
      { op: "schedule", views: ["threads"] },
      { op: "advance", ms: 250 },
      { op: "resolvePending", label: "model", value: { status: "ok", ok: true } },
      { op: "runAll" },
    ],
  },
  {
    name: "renders successful view refreshes when another view refresh rejects",
    screen: "coordination",
    coordinationThrows: true,
    ops: [{ op: "schedule", views: ["desktop-state", "coordination-worklist"] }, { op: "runAll" }],
  },
  {
    name: "does not render when event refreshes settle without applying data",
    modelResult: false,
    ops: [{ op: "schedule", views: ["desktop-state"] }, { op: "runAll" }],
  },
  {
    name: "coalesces bursts and cancels pending refreshes on stop",
    ops: [
      { op: "schedule", views: ["desktop-state"] },
      { op: "schedule", views: ["threads"] },
      { op: "stop" },
      { op: "runAll" },
    ],
  },
  {
    name: "queues event refreshes while the tmux dashboard is hidden",
    visible: false,
    ops: [
      { op: "schedule", views: ["desktop-state"] },
      { op: "advance", ms: 250 },
      { op: "schedule", views: ["threads"] },
      { op: "setVisible", visible: true },
      { op: "advance", ms: 10000 },
      { op: "runAll" },
    ],
  },
  {
    name: "drops pending refreshes when the dashboard exits before the timer fires",
    ops: [{ op: "schedule", views: ["desktop-state"] }, { op: "setMode", mode: "session" }, { op: "runAll" }],
  },
  {
    name: "does not render if the dashboard exits while an event refresh is in flight",
    pendingLabels: ["model"],
    modelPendingLabel: "model",
    ops: [
      { op: "schedule", views: ["desktop-state"] },
      { op: "advance", ms: 250 },
      { op: "setMode", mode: "session" },
      { op: "resolvePending", label: "model", value: { status: "ok", ok: true } },
      { op: "runAll" },
    ],
  },
  {
    name: "collapses a burst of project events into one refresh",
    ops: [
      { op: "schedule", views: ["desktop-state"] },
      { op: "advance", ms: 50 },
      { op: "schedule", views: ["desktop-state"] },
      { op: "advance", ms: 50 },
      { op: "schedule", views: ["desktop-state"] },
      { op: "advance", ms: 50 },
      { op: "schedule", views: ["desktop-state"] },
      { op: "advance", ms: 50 },
      { op: "schedule", views: ["desktop-state"] },
      { op: "runAll" },
    ],
  },
  {
    name: "does not render after the event adapter stops during an in-flight refresh",
    pendingLabels: ["model"],
    modelPendingLabel: "model",
    ops: [
      { op: "schedule", views: ["desktop-state"] },
      { op: "advance", ms: 250 },
      { op: "stop" },
      { op: "resolvePending", label: "model", value: { status: "ok", ok: true } },
      { op: "runAll" },
    ],
  },
  {
    name: "keeps active project SSE refresh state when input changes on the same screen",
    screen: "project",
    pendingLabels: ["project"],
    resourcePendingLabel: "project",
    ops: [
      { op: "schedule", views: ["project-observability"] },
      { op: "advance", ms: 250 },
      { op: "setInputEpoch", value: 1 },
      {
        op: "resolvePending",
        label: "project",
        value: { ok: true, project: { story: [{ title: "SSE project update" }] } },
      },
      { op: "runAll" },
    ],
  },
  {
    name: "drops active project SSE refresh state after navigation away",
    screen: "project",
    initialProjectTitle: "old",
    pendingLabels: ["project"],
    resourcePendingLabel: "project",
    ops: [
      { op: "schedule", views: ["project-observability"] },
      { op: "advance", ms: 250 },
      { op: "setScreen", screen: "library" },
      {
        op: "resolvePending",
        label: "project",
        value: { ok: true, project: { story: [{ title: "SSE project update" }] } },
      },
      { op: "runAll" },
    ],
  },
  {
    name: "resyncs API-backed dashboard state when the SSE stream reconnects",
    ops: [{ op: "handle", name: "ready", payload: { ok: true } }, { op: "runAll" }],
  },
  {
    name: "resyncs cached views without repairing when the SSE stream fails",
    endpointResponses: [{ type: "endpoint", endpoint }],
    fetchResponses: [{ type: "reject", message: "socket closed" }],
    ops: [{ op: "start" }, { op: "advance", ms: 250 }, { op: "advance", ms: 250 }, { op: "stop" }],
  },
  {
    name: "resyncs cached views without repairing when the SSE stream wedges without keepalives",
    endpointResponses: [{ type: "endpoint", endpoint }],
    fetchResponses: [{ type: "stream", label: "wedged" }],
    ops: [
      { op: "start" },
      { op: "advance", ms: 0 },
      { op: "advance", ms: 35000 },
      { op: "advance", ms: 250 },
      { op: "stop" },
    ],
  },
  {
    name: "resyncs cached views without repairing when the SSE reader reports ECONNRESET",
    endpointResponses: [{ type: "endpoint", endpoint }],
    fetchResponses: [{ type: "streamError", message: "read ECONNRESET" }],
    ops: [{ op: "start" }, { op: "advance", ms: 250 }, { op: "advance", ms: 250 }, { op: "stop" }],
  },
  {
    name: "backs off SSE reconnect attempts instead of spinning on a dead endpoint",
    endpointResponses: [
      { type: "endpoint", endpoint },
      { type: "endpoint", endpoint },
    ],
    fetchResponses: [
      { type: "reject", message: "ECONNREFUSED" },
      { type: "reject", message: "ECONNREFUSED" },
    ],
    ops: [
      { op: "start" },
      { op: "advance", ms: 250 },
      { op: "advance", ms: 500 },
      { op: "advance", ms: 1000 },
      { op: "stop" },
    ],
  },
  {
    name: "backs off without resyncing cached views when endpoint resolution fails",
    endpointResponses: [{ type: "reject", message: "metadata stale" }],
    ops: [{ op: "start" }, { op: "advance", ms: 250 }, { op: "advance", ms: 250 }, { op: "stop" }],
  },
  {
    name: "applies SSE alert flashes that used to come from the in-process bus",
    ops: [{ op: "applyAlert", event: alertEvent }],
  },
  {
    name: "ignores alerts after the dashboard has exited",
    mode: "session",
    ops: [{ op: "applyAlert", event: alertEvent }],
  },
  {
    name: "ignores buffered events after the event adapter stops",
    endpointResponses: [{ type: "endpoint", endpoint }],
    fetchResponses: [{ type: "stream", label: "buffered" }],
    ops: [
      { op: "start" },
      { op: "advance", ms: 0 },
      { op: "stop" },
      {
        op: "enqueue",
        label: "buffered",
        text: 'event: alert\\ndata: {"type":"alert","kind":"task_failed","projectId":"project","title":"Task failed","message":"Failure","ts":"now"}\\n\\n',
      },
      { op: "runAll" },
    ],
  },
];

const cases = [];
for (const [index, scenario] of scenarios.entries()) {
  const { name, ...input } = scenario;
  cases.push({
    id: `project-event-stream-${String(index + 1).padStart(3, "0")}`,
    name,
    source: "src/multiplexer/project-event-stream.test.ts",
    sourceName: name,
    api: "DashboardProjectEventAdapter",
    input,
    output: await run(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/project-event-stream.test.ts",
  generatedBy: "scripts/capture-project-event-stream-contract.mjs",
  description:
    "Dashboard project event stream debounce, refresh routing, SSE reconnect, idle timeout, alert flash, and disposal behavior captured by running TypeScript project-event-stream with deterministic timers and stream responses.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
