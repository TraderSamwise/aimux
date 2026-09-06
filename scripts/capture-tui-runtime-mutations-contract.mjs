#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import prettier from "prettier";
import ts from "typescript";

const ROOT = new URL("../", import.meta.url);
const SOURCE_URL = new URL("src/multiplexer/tui-runtime-mutations.ts", ROOT);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/tui-runtime-mutations.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function importTuiRuntimeMutations() {
  const source = (await readFile(SOURCE_URL, "utf8")).replace(/^import .+;\n/gm, "");
  const prelude = `
const PROJECT_API_ROUTES = {
  runtime: {
    notificationContext: "/notification-context",
    markSeen: "/mark-seen",
  },
};
let __debugCalls = [];
let __mutationResponses = [];
let __mutationCalls = [];
let __pendingMutations = new Map();
let __timerNow = 0;
let __nextTimerId = 1;
let __timers = [];
export function __resetHarness(responses = []) {
  __debugCalls = [];
  __mutationResponses = responses.slice();
  __mutationCalls = [];
  __pendingMutations = new Map();
  __timerNow = 0;
  __nextTimerId = 1;
  __timers = [];
}
export function __calls() {
  return { mutations: __mutationCalls, debug: __debugCalls };
}
export function __timerState() {
  return { now: __timerNow, pending: __timers.map((timer) => ({ id: timer.id, at: timer.at })) };
}
export async function __resolveMutation(label, value = { ok: true }) {
  const pending = __pendingMutations.get(label);
  if (!pending) throw new Error("unknown pending mutation " + label);
  __pendingMutations.delete(label);
  pending.resolve(value);
  await __flushMicrotasks();
}
export async function __rejectMutation(label, message = "offline") {
  const pending = __pendingMutations.get(label);
  if (!pending) throw new Error("unknown pending mutation " + label);
  __pendingMutations.delete(label);
  pending.reject(new Error(message));
  await __flushMicrotasks();
}
export async function __runOnlyPendingTimersAsync() {
  const pending = __timers.slice().sort((a, b) => a.at - b.at || a.id - b.id);
  for (const timer of pending) {
    if (!__timers.includes(timer)) continue;
    __timers = __timers.filter((item) => item !== timer);
    __timerNow = Math.max(__timerNow, timer.at);
    timer.fn();
    await __flushMicrotasks();
  }
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
export async function __runAllTimersAsync() {
  while (__timers.length > 0) {
    await __runOnlyPendingTimersAsync();
  }
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
}
function debug(message, scope) {
  __debugCalls.push({ message, scope });
}
async function mutateDashboardApi(_host, path, body, options) {
  __mutationCalls.push({ path, body, options: options ?? null });
  const response = __mutationResponses.shift() ?? { type: "resolve", value: { ok: true } };
  if (response.type === "reject") throw new Error(response.message ?? "offline");
  if (response.type === "pending") {
    return await new Promise((resolve, reject) => {
      __pendingMutations.set(response.label, { resolve, reject });
    });
  }
  return response.value ?? { ok: true };
}
`;
  const transpiled = ts.transpileModule(`${prelude}\n${source}`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: SOURCE_URL.pathname,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const api = await importTuiRuntimeMutations();

function serializeQueue(host) {
  const queue = host.tuiRuntimeMutationQueue;
  if (!queue) return null;
  return {
    context: queue.context ?? null,
    seen: [...queue.seen],
    hasTimer: queue.timer != null,
    inFlight: queue.inFlight,
    attempt: queue.attempt,
    disposed: queue.disposed,
  };
}

async function run(input) {
  api.__resetHarness(input.responses ?? []);
  const host = {};
  for (const op of input.ops) {
    if (op.op === "context") {
      api.queueTuiNotificationContext(host, op.patch);
    } else if (op.op === "seen") {
      api.queueTuiSessionSeen(host, op.sessionId);
    } else if (op.op === "clear") {
      api.clearTuiRuntimeMutationQueue(host);
    } else if (op.op === "runPending") {
      await api.__runOnlyPendingTimersAsync();
    } else if (op.op === "advance") {
      await api.__advanceTimersByTimeAsync(op.ms);
    } else if (op.op === "runAll") {
      await api.__runAllTimersAsync();
    } else if (op.op === "resolve") {
      await api.__resolveMutation(op.label, op.value);
    } else if (op.op === "reject") {
      await api.__rejectMutation(op.label, op.message);
    } else {
      throw new Error(`unknown op ${op.op}`);
    }
  }
  return {
    calls: api.__calls(),
    queue: serializeQueue(host),
    timers: api.__timerState(),
  };
}

const scenarios = [
  {
    name: "coalesces notification context updates and marks sessions seen off the hot path",
    ops: [
      { op: "context", patch: { screen: "dashboard", sessionId: "first", panelOpen: true } },
      { op: "context", patch: { screen: "agent", sessionId: "second", panelOpen: false } },
      { op: "seen", sessionId: "first" },
      { op: "seen", sessionId: "second" },
      { op: "runPending" },
    ],
  },
  {
    name: "drops failed telemetry context without overwriting newer context",
    responses: [
      { type: "reject", message: "offline" },
      { type: "resolve", value: { ok: true } },
    ],
    ops: [
      { op: "context", patch: { screen: "dashboard", sessionId: "old" } },
      { op: "runPending" },
      { op: "context", patch: { screen: "coordination", sessionId: "new" } },
      { op: "advance", ms: 250 },
    ],
  },
  {
    name: "clears pending retries during teardown",
    responses: [{ type: "reject", message: "offline" }],
    ops: [{ op: "seen", sessionId: "codex-1" }, { op: "runPending" }, { op: "clear" }, { op: "advance", ms: 10000 }],
  },
  {
    name: "lets fresh context updates preempt a pending mark-seen retry backoff",
    responses: [
      { type: "reject", message: "offline" },
      { type: "resolve", value: { ok: true } },
    ],
    ops: [
      { op: "seen", sessionId: "codex-1" },
      { op: "runPending" },
      { op: "context", patch: { screen: "agent", sessionId: "codex-2" } },
      { op: "advance", ms: 0 },
    ],
  },
  {
    name: "drops failed notification context when no fresh context arrived",
    responses: [{ type: "reject", message: "offline" }],
    ops: [
      { op: "context", patch: { screen: "agent", sessionId: "codex-1" } },
      { op: "runPending" },
      { op: "advance", ms: 10000 },
    ],
  },
  {
    name: "merges partial notification context patches before flushing",
    ops: [
      { op: "context", patch: { screen: "agent", sessionId: "codex-1" } },
      { op: "context", patch: { panelOpen: false } },
      { op: "runPending" },
    ],
  },
  {
    name: "does not reschedule an in-flight failure after teardown",
    responses: [{ type: "pending", label: "mark-seen" }],
    ops: [
      { op: "seen", sessionId: "codex-1" },
      { op: "advance", ms: 0 },
      { op: "clear" },
      { op: "reject", label: "mark-seen", message: "offline" },
      { op: "runAll" },
    ],
  },
  {
    name: "does not recreate the queue when in-flight context fails after teardown",
    responses: [{ type: "pending", label: "context" }],
    ops: [
      { op: "context", patch: { screen: "agent", sessionId: "codex-1" } },
      { op: "advance", ms: 0 },
      { op: "clear" },
      { op: "reject", label: "context", message: "offline" },
      { op: "runAll" },
    ],
  },
  {
    name: "does not continue a mixed batch after teardown",
    responses: [{ type: "pending", label: "context" }],
    ops: [
      { op: "context", patch: { screen: "agent", sessionId: "codex-1" } },
      { op: "seen", sessionId: "codex-1" },
      { op: "advance", ms: 0 },
      { op: "clear" },
      { op: "resolve", label: "context", value: { ok: true } },
      { op: "runAll" },
    ],
  },
];

const cases = [];
for (const [index, scenario] of scenarios.entries()) {
  const input = {
    ops: scenario.ops,
    responses: scenario.responses ?? [],
  };
  cases.push({
    id: `tui-runtime-mutations-${String(index + 1).padStart(3, "0")}`,
    name: scenario.name,
    source: "src/multiplexer/tui-runtime-mutations.test.ts",
    sourceName: scenario.name,
    api: "queueTuiNotificationContext/queueTuiSessionSeen/clearTuiRuntimeMutationQueue",
    input,
    output: await run(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/tui-runtime-mutations.test.ts",
  generatedBy: "scripts/capture-tui-runtime-mutations-contract.mjs",
  description:
    "TUI runtime mutation queue coalescing, retry, and teardown side effects captured by running TypeScript tui-runtime-mutations with deterministic timers and dashboard API mutation responses.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
