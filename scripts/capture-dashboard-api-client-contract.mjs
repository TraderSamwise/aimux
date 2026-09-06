#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/dashboard-api-client.json", ROOT);

const {
  isDashboardApiMutationBlocked,
  mutateDashboardApi,
  refreshDashboardApiResource,
  refreshDashboardModelThroughApi,
} = await import(new URL("dist/multiplexer/dashboard-api-client.js", ROOT));
const { getOrCreateTuiApiRuntime } = await import(new URL("dist/multiplexer/tui-api-runtime.js", ROOT));

const FIXED_NOW = 1770000000000;
Date.now = () => FIXED_NOW;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function calls() {
  const items = [];
  const fn = async (...args) => {
    items.push(args);
    const step = fn.steps.length ? fn.steps.shift() : fn.defaultStep;
    if (step?.throw) throw makeError(step.throw);
    return step?.value;
  };
  fn.items = items;
  fn.steps = [];
  fn.defaultStep = { value: undefined };
  return fn;
}

function makeError(input) {
  const error = new Error(input.message);
  if (input.code) error.code = input.code;
  if (input.status) error.status = input.status;
  if (input.tuiApiRecoverable !== undefined) error.tuiApiRecoverable = input.tuiApiRecoverable;
  return error;
}

function normalize(value) {
  if (value instanceof Error) {
    const out = { name: value.name, message: value.message };
    if (value.code) out.code = value.code;
    if (value.status) out.status = value.status;
    if (value.connection) out.connection = normalize(value.connection);
    return out;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function connection(host) {
  return normalize(getOrCreateTuiApiRuntime(host).getConnectionSnapshot());
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

const cases = [];
async function record(name, sourceName, input, run) {
  const output = normalize(await run());
  cases.push({
    id: `runtime-state-dashboard-api-client-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/multiplexer/dashboard-api-client.test.ts",
    sourceName,
    api: "dashboard-api-client",
    input,
    output,
    inputSha256: hash(input),
  });
}

await record(
  "applies resource snapshots through the TUI API runtime",
  "applies resource snapshots through the TUI API runtime",
  { path: "/demo", resource: "demo", response: { ok: true, value: 1 } },
  async () => {
    const getFromProjectService = calls();
    getFromProjectService.defaultStep = { value: { ok: true, value: 1 } };
    const apply = calls();
    const ensure = calls();
    const host = { getFromProjectService };
    const result = await refreshDashboardApiResource(host, {
      resource: "demo",
      path: "/demo",
      validate: (value) => value,
      apply: (...args) => apply(...args),
      ensure: (...args) => ensure(...args),
    });
    return {
      result,
      calls: { getFromProjectService: getFromProjectService.items, apply: apply.items, ensure: ensure.items },
      connection: connection(host),
    };
  },
);

await record(
  "does not request or apply a resource for a stale lifecycle",
  "does not request or apply a resource for a stale lifecycle",
  {
    host: { mode: "dashboard", dashboardInputEpoch: 2 },
    lifecycle: { mode: "dashboard", inputEpoch: 1, requiresInputEpoch: true },
  },
  async () => {
    const getFromProjectService = calls();
    getFromProjectService.defaultStep = { value: { ok: true, value: 1 } };
    const apply = calls();
    const ensure = calls();
    const host = { mode: "dashboard", dashboardInputEpoch: 2, getFromProjectService };
    const result = await refreshDashboardApiResource(
      host,
      {
        resource: "demo",
        path: "/demo",
        validate: (value) => value,
        apply: (...args) => apply(...args),
        ensure: (...args) => ensure(...args),
      },
      { lifecycle: { mode: "dashboard", inputEpoch: 1, requiresInputEpoch: true } },
    );
    return {
      result,
      calls: { getFromProjectService: getFromProjectService.items, apply: apply.items, ensure: ensure.items },
    };
  },
);

await record(
  "does not apply a resource if the lifecycle goes stale while loading",
  "does not apply a resource if the lifecycle goes stale while loading",
  {
    hostBefore: { mode: "dashboard", dashboardInputEpoch: 1 },
    lifecycle: { mode: "dashboard", inputEpoch: 1, requiresInputEpoch: true },
    response: { ok: true, value: 1 },
    mutateBeforeResolve: { dashboardInputEpoch: 2 },
  },
  async () => {
    let resolveRequest;
    const getFromProjectService = (...args) => {
      getFromProjectService.items.push(args);
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    };
    getFromProjectService.items = [];
    const apply = calls();
    const ensure = calls();
    const host = { mode: "dashboard", dashboardInputEpoch: 1, getFromProjectService };
    const refresh = refreshDashboardApiResource(
      host,
      {
        resource: "demo",
        path: "/demo",
        validate: (value) => value,
        apply: (...args) => apply(...args),
        ensure: (...args) => ensure(...args),
      },
      { lifecycle: { mode: "dashboard", inputEpoch: 1, requiresInputEpoch: true } },
    );
    host.dashboardInputEpoch = 2;
    resolveRequest({ ok: true, value: 1 });
    return {
      result: await refresh,
      calls: { getFromProjectService: getFromProjectService.items, apply: apply.items, ensure: ensure.items },
      hostAfter: { mode: host.mode, dashboardInputEpoch: host.dashboardInputEpoch },
    };
  },
);

await record(
  "returns a failed dashboard model refresh outcome when no snapshot is usable",
  "returns a failed dashboard model refresh outcome when no snapshot is usable",
  { refreshError: "offline", options: { force: true } },
  async () => {
    const refreshDashboardModelFromService = calls();
    refreshDashboardModelFromService.defaultStep = { throw: { message: "offline" } };
    const host = { refreshDashboardModelFromService };
    const result = await refreshDashboardModelThroughApi(host, { force: true });
    return { result, calls: { refreshDashboardModelFromService: refreshDashboardModelFromService.items } };
  },
);

await record(
  "returns a stale dashboard model refresh outcome when a prior desktop snapshot is usable",
  "returns a stale dashboard model refresh outcome when a prior desktop snapshot is usable",
  { firstDesktopState: { ok: true, sessions: [] }, refreshError: "offline", options: { force: true } },
  async () => {
    const getFromProjectService = calls();
    getFromProjectService.steps = [
      { value: { ok: true, sessions: [] } },
      { throw: { message: "offline", code: "ECONNREFUSED" } },
    ];
    const refreshDashboardModelFromService = calls();
    const host = {
      getFromProjectService,
      refreshDashboardModelFromService: async (...args) => {
        refreshDashboardModelFromService.items.push(args);
        host.dashboardModelServiceRefreshError = makeError({ message: "offline" });
        return false;
      },
    };
    const runtime = getOrCreateTuiApiRuntime(host);
    await runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);
    await runtime.refreshJson("desktop-state", "/desktop-state", (value) => value, { supersede: true });
    const result = await refreshDashboardModelThroughApi(host, { force: true });
    return {
      result,
      calls: {
        getFromProjectService: getFromProjectService.items,
        refreshDashboardModelFromService: refreshDashboardModelFromService.items,
      },
      connection: connection(host),
    };
  },
);

await record(
  "allows model settlement refreshes while inactive even with a stale render lifecycle",
  "allows model settlement refreshes while inactive even with a stale render lifecycle",
  {
    host: { mode: "session", dashboardInputEpoch: 2 },
    options: {
      force: true,
      allowInactive: true,
      lifecycle: { mode: "dashboard", inputEpoch: 1, requiresInputEpoch: true },
    },
  },
  async () => {
    const refreshDashboardModelFromService = calls();
    refreshDashboardModelFromService.defaultStep = { value: true };
    const host = { mode: "session", dashboardInputEpoch: 2, refreshDashboardModelFromService };
    const result = await refreshDashboardModelThroughApi(host, {
      force: true,
      allowInactive: true,
      lifecycle: { mode: "dashboard", inputEpoch: 1, requiresInputEpoch: true },
    });
    return { result, calls: { refreshDashboardModelFromService: refreshDashboardModelFromService.items } };
  },
);

await record(
  "mutates through the shared TUI API runtime",
  "mutates through the shared TUI API runtime",
  { path: "/agents/stop", body: { sessionId: "a" } },
  async () => {
    const getFromProjectService = calls();
    const postToProjectService = async (...args) => {
      postToProjectService.items.push(args);
      return { ok: true, body: args[1] };
    };
    postToProjectService.items = [];
    const host = { getFromProjectService, postToProjectService };
    const result = await mutateDashboardApi(host, "/agents/stop", { sessionId: "a" });
    return { result, calls: { postToProjectService: postToProjectService.items }, connection: connection(host) };
  },
);

await record(
  "blocks mutations while the critical desktop-state resource is reconnecting",
  "blocks mutations while the critical desktop-state resource is reconnecting",
  {
    firstDesktopState: { ok: true, sessions: [] },
    failure: { message: "offline", code: "ECONNREFUSED" },
    mutation: { path: "/agents/stop", body: { sessionId: "a" } },
  },
  async () => {
    const getFromProjectService = calls();
    getFromProjectService.steps = [
      { value: { ok: true, sessions: [] } },
      { throw: { message: "offline", code: "ECONNREFUSED" } },
    ];
    const postToProjectService = calls();
    postToProjectService.defaultStep = { value: { ok: true } };
    const host = { getFromProjectService, postToProjectService };
    const runtime = getOrCreateTuiApiRuntime(host);
    await runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);
    await runtime.refreshJson("desktop-state", "/desktop-state", (value) => value, { supersede: true });
    const blocked = isDashboardApiMutationBlocked(host);
    let mutation;
    try {
      mutation = { ok: true, value: await mutateDashboardApi(host, "/agents/stop", { sessionId: "a" }) };
    } catch (error) {
      mutation = { ok: false, error };
    }
    await settle();
    return {
      blocked,
      mutation,
      calls: { getFromProjectService: getFromProjectService.items, postToProjectService: postToProjectService.items },
      connection: connection(host),
    };
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-api-client.test.ts",
  generatedBy: "scripts/capture-dashboard-api-client-contract.mjs",
  description:
    "Dashboard API client resource refresh, model refresh, mutation, connection-state, and stale lifecycle contracts captured by running TypeScript.",
  normalization: {
    timestamps: `Date.now() is fixed at ${FIXED_NOW} while executing the TypeScript capture.`,
    errors: "Error objects are serialized as name/message plus stable code/status/connection fields.",
  },
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
