#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/tui-api-runtime-state.json", ROOT);

const { TuiApiRuntime } = await import(new URL("dist/multiplexer/tui-api-runtime.js", ROOT));

const FIXED_NOW = 1_700_000_000_000;
Date.now = () => FIXED_NOW;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function error(message, props = {}) {
  return Object.assign(new Error(message), props);
}

function normalizeError(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: value.code,
      status: value.status,
      tuiApiRecoverable: value.tuiApiRecoverable,
      connection: value.connection ? normalize(value.connection) : undefined,
    };
  }
  return value;
}

function normalize(value) {
  if (value instanceof Error) return normalizeError(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]));
}

function makeSequenceTransport(steps, calls) {
  const queue = [...steps];
  return async (path, bodyOrOpts, maybeOpts) => {
    calls.push(
      maybeOpts === undefined
        ? { path, opts: normalize(bodyOrOpts) ?? null }
        : { path, body: normalize(bodyOrOpts), opts: normalize(maybeOpts) ?? null },
    );
    const step = queue.shift() ?? { value: null };
    if (step.deferred) return step.deferred.promise;
    if (step.throw) throw error(step.throw.message, step.throw);
    return step.value;
  };
}

function snapshot(runtime, resource = "desktop-state") {
  return normalize({
    state: runtime.getConnectionState(),
    connection: runtime.getConnectionSnapshot(),
    resource: runtime.getSnapshot(resource),
  });
}

async function runCase(input) {
  const states = [];
  const failures = [];
  const requestCalls = [];
  const mutateCalls = [];
  const request = makeSequenceTransport(input.requestSteps ?? [], requestCalls);
  const mutate = makeSequenceTransport(input.mutateSteps ?? [], mutateCalls);
  const runtime = new TuiApiRuntime({
    request,
    mutate,
    criticalResources: input.criticalResources ?? [],
    onConnectionStateChange: (state) => states.push(state),
    onRequestFailure: (caught) => failures.push(normalizeError(caught)),
  });

  const result = {};
  switch (input.scenario) {
    case "coalesced-refresh": {
      const first = runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);
      const second = runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);
      result.results = normalize(await Promise.all([first, second]));
      break;
    }
    case "stale-refresh-failure": {
      result.first = normalize(await runtime.refreshJson("desktop-state", "/desktop-state", (value) => value));
      result.second = normalize(await runtime.refreshJson("desktop-state", "/desktop-state", (value) => value));
      break;
    }
    case "parallel-mutations": {
      const first = runtime.mutateJson("/notifications/read", { id: "one" }, (value) => value);
      const second = runtime.mutateJson("/notifications/read", { id: "two" }, (value) => value);
      result.results = normalize(await Promise.all([first, second]));
      break;
    }
    case "blocked-follow-up-mutation": {
      result.failed = normalize(await runtime.mutateJson("/notifications/read", {}, (value) => value));
      result.blocked = normalize(await runtime.mutateJson("/agents/stop", {}, (value) => value));
      result.allowed = normalize(
        await runtime.mutateJson("/controls/open-notification-target", {}, (value) => value, {
          allowDuringReconnect: true,
        }),
      );
      break;
    }
    case "semantic-mutation-failure": {
      result.failed = normalize(await runtime.mutateJson("/agents/stop", {}, (value) => value));
      break;
    }
    case "older-read-failure-after-newer-success": {
      const slow = deferred();
      const fast = deferred();
      runtime.optionsForContract = { slow, fast };
      requestCalls.length = 0;
      const slowRuntime = new TuiApiRuntime({
        request: makeSequenceTransport([{ deferred: slow }, { deferred: fast }], requestCalls),
        onRequestFailure: (caught) => failures.push(normalizeError(caught)),
      });
      const slowRead = slowRuntime.requestJson("/slow", (value) => value);
      const fastRead = slowRuntime.requestJson("/fast", (value) => value);
      fast.resolve({ ok: true });
      result.fast = normalize(await fastRead);
      slow.reject(error("late timeout"));
      result.slow = normalize(await slowRead);
      result.snapshot = snapshot(slowRuntime);
      result.states = states;
      return { result, states, failures, requestCalls, mutateCalls, snapshot: result.snapshot };
    }
    case "critical-resource-recovers": {
      const critical = deferred();
      const health = deferred();
      const recovered = deferred();
      requestCalls.length = 0;
      const criticalRuntime = new TuiApiRuntime({
        request: makeSequenceTransport([{ deferred: critical }, { deferred: health }, { deferred: recovered }], requestCalls),
        criticalResources: ["desktop-state"],
        onConnectionStateChange: (state) => states.push(state),
        onRequestFailure: (caught) => failures.push(normalizeError(caught)),
      });
      const refresh = criticalRuntime.refreshJson("desktop-state", "/desktop-state", (value) => value);
      const read = criticalRuntime.requestJson("/health", (value) => value);
      health.resolve({ ok: true });
      result.health = normalize(await read);
      critical.reject(error("late desktop-state timeout"));
      result.refresh = normalize(await refresh);
      result.afterFailure = snapshot(criticalRuntime);
      const recovery = criticalRuntime.refreshJson("desktop-state", "/desktop-state", (value) => value);
      recovered.resolve({ ok: true, recovered: true });
      result.recovery = normalize(await recovery);
      result.afterRecovery = snapshot(criticalRuntime);
      return { result, states, failures, requestCalls, mutateCalls, snapshot: result.afterRecovery };
    }
    default:
      throw new Error(`unknown scenario ${input.scenario}`);
  }

  return {
    result,
    states,
    failures,
    requestCalls,
    mutateCalls,
    snapshot: snapshot(runtime),
  };
}

const cases = [
  {
    name: "coalesces concurrent refreshes for the same resource",
    input: {
      scenario: "coalesced-refresh",
      requestSteps: [{ value: { ok: true, value: 1 } }],
    },
  },
  {
    name: "keeps the last good value when a refresh fails",
    input: {
      scenario: "stale-refresh-failure",
      requestSteps: [{ value: { ok: true, value: 1 } }, { throw: { message: "timeout" } }],
    },
  },
  {
    name: "does not coalesce mutations",
    input: {
      scenario: "parallel-mutations",
      mutateSteps: [{ value: { ok: true, body: { id: "one" } } }, { value: { ok: true, body: { id: "two" } } }],
    },
  },
  {
    name: "blocks follow-up mutations while reconnecting unless allowed",
    input: {
      scenario: "blocked-follow-up-mutation",
      mutateSteps: [{ throw: { message: "offline", code: "ECONNREFUSED" } }, { value: { ok: true } }],
    },
  },
  {
    name: "semantic mutation failures do not enter reconnecting state",
    input: {
      scenario: "semantic-mutation-failure",
      mutateSteps: [{ throw: { message: "session is already stopped", status: 400, tuiApiRecoverable: false } }],
    },
  },
  {
    name: "older wrapper read failure does not degrade newer success",
    input: { scenario: "older-read-failure-after-newer-success" },
  },
  {
    name: "critical resource failures keep reconnecting until the resource refreshes",
    input: { scenario: "critical-resource-recovers" },
  },
];

const outputCases = [];
for (const [index, entry] of cases.entries()) {
  outputCases.push({
    id: `tui-api-runtime-state-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/tui-api-runtime.ts",
    api: "TuiApiRuntime",
    input: entry.input,
    output: await runCase(entry.input),
    inputSha256: hash(entry.input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/tui-api-runtime.ts",
  generatedBy: "scripts/capture-tui-api-runtime-state-contract.mjs",
  description:
    "Stateful TuiApiRuntime refresh, mutation, reconnect, stale-cache, critical-resource, and generation-watermark behavior captured by running TypeScript.",
  cases: outputCases,
});

console.log(`${FIXTURE_PATH.pathname}: ${outputCases.length} cases`);
