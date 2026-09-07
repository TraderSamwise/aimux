#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/tui-api-runtime-state.json", ROOT);

const { getJsonWithTuiApiRuntime, postJsonWithTuiApiRuntime, TuiApiRuntime } = await import(
  new URL("dist/multiplexer/tui-api-runtime.js", ROOT)
);

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

async function capturesThrow(fn) {
  try {
    return { ok: true, value: normalize(await fn()) };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
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
    case "older-mutation-failure-after-newer-success": {
      const slow = deferred();
      const fast = deferred();
      mutateCalls.length = 0;
      const mutationRuntime = new TuiApiRuntime({
        request,
        mutate: makeSequenceTransport([{ deferred: slow }, { deferred: fast }], mutateCalls),
        onRequestFailure: (caught) => failures.push(normalizeError(caught)),
      });
      const slowMutation = mutationRuntime.mutateJson("/slow", {}, (value) => value);
      const fastMutation = mutationRuntime.mutateJson("/fast", {}, (value) => value);
      fast.resolve({ ok: true });
      result.fast = normalize(await fastMutation);
      slow.reject(error("late timeout"));
      result.slow = normalize(await slowMutation);
      result.snapshot = snapshot(mutationRuntime);
      return { result, states, failures, requestCalls, mutateCalls, snapshot: result.snapshot };
    }
    case "older-refresh-failure-after-newer-direct-success": {
      const slow = deferred();
      const fast = deferred();
      requestCalls.length = 0;
      const mixedRuntime = new TuiApiRuntime({
        request: makeSequenceTransport([{ deferred: slow }, { deferred: fast }], requestCalls),
        onRequestFailure: (caught) => failures.push(normalizeError(caught)),
      });
      const refresh = mixedRuntime.refreshJson("desktop-state", "/desktop-state", (value) => value);
      const read = mixedRuntime.requestJson("/health", (value) => value);
      fast.resolve({ ok: true });
      result.read = normalize(await read);
      slow.reject(error("late timeout"));
      result.refresh = normalize(await refresh);
      result.snapshot = snapshot(mixedRuntime);
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
    case "best-effort-mutation-failure": {
      result.failed = normalize(
        await runtime.mutateJson("/notification-context", { source: "tui" }, (value) => value, {
          timeoutMs: 3000,
          recoverOnFailure: false,
        }),
      );
      break;
    }
    case "superseded-refresh-response": {
      const first = deferred();
      const second = deferred();
      requestCalls.length = 0;
      const supersededRuntime = new TuiApiRuntime({
        request: makeSequenceTransport([{ deferred: first }, { deferred: second }], requestCalls),
      });
      const slow = supersededRuntime.refreshJson("desktop-state", "/desktop-state", (value) => value);
      const fast = supersededRuntime.refreshJson("desktop-state", "/desktop-state", (value) => value, {
        supersede: true,
      });
      second.resolve({ ok: true, value: 2 });
      result.fast = normalize(await fast);
      first.resolve({ ok: true, value: 1 });
      result.slow = normalize(await slow);
      result.snapshot = snapshot(supersededRuntime);
      return { result, states, failures, requestCalls, mutateCalls, snapshot: result.snapshot };
    }
    case "disposed-pending-refresh-success": {
      const pending = deferred();
      requestCalls.length = 0;
      const disposedRuntime = new TuiApiRuntime({
        request: makeSequenceTransport([{ deferred: pending }], requestCalls),
      });
      const refresh = disposedRuntime.refreshJson("desktop-state", "/desktop-state", (value) => value);
      disposedRuntime.dispose();
      pending.resolve({ ok: true, value: 1 });
      result.refresh = normalize(await refresh);
      result.snapshot = snapshot(disposedRuntime);
      return { result, states, failures, requestCalls, mutateCalls, snapshot: result.snapshot };
    }
    case "disposed-pending-refresh-failure": {
      const pending = deferred();
      requestCalls.length = 0;
      const disposedRuntime = new TuiApiRuntime({
        request: makeSequenceTransport([{ deferred: pending }], requestCalls),
        onRequestFailure: (caught) => failures.push(normalizeError(caught)),
      });
      const refresh = disposedRuntime.refreshJson("desktop-state", "/desktop-state", (value) => value);
      disposedRuntime.dispose();
      pending.reject(error("transport failed after teardown"));
      result.refresh = normalize(await refresh);
      result.snapshot = snapshot(disposedRuntime);
      return { result, states, failures, requestCalls, mutateCalls, snapshot: result.snapshot };
    }
    case "disposed-direct-read-success": {
      const pending = deferred();
      requestCalls.length = 0;
      const disposedRuntime = new TuiApiRuntime({
        request: makeSequenceTransport([{ deferred: pending }], requestCalls),
        onConnectionStateChange: (state) => states.push(state),
      });
      const read = disposedRuntime.requestJson("/desktop-state", (value) => value);
      disposedRuntime.dispose();
      pending.resolve({ ok: true });
      result.read = normalize(await read);
      result.snapshot = snapshot(disposedRuntime);
      return { result, states, failures, requestCalls, mutateCalls, snapshot: result.snapshot };
    }
    case "disposed-mutation-success": {
      const pending = deferred();
      mutateCalls.length = 0;
      const disposedRuntime = new TuiApiRuntime({
        request,
        mutate: makeSequenceTransport([{ deferred: pending }], mutateCalls),
        onConnectionStateChange: (state) => states.push(state),
      });
      const mutation = disposedRuntime.mutateJson("/agents/stop", { sessionId: "codex-1" }, (value) => value);
      disposedRuntime.dispose();
      pending.resolve({ ok: true });
      result.mutation = normalize(await mutation);
      result.snapshot = snapshot(disposedRuntime);
      return { result, states, failures, requestCalls, mutateCalls, snapshot: result.snapshot };
    }
    case "wrapper-read-uses-runtime-transport": {
      const host = {};
      const calls = [];
      const requestWrapper = async (targetHost, path, opts) => {
        calls.push({ sameHost: targetHost === host, path, opts: normalize(opts) ?? null });
        return { ok: true, value: 1 };
      };
      result.read = await capturesThrow(() => getJsonWithTuiApiRuntime(host, "/desktop-state", { timeoutMs: 5000 }, requestWrapper));
      result.calls = calls;
      result.connectionState = host.tuiApiRuntime?.getConnectionState?.();
      return { result, states, failures, requestCalls, mutateCalls, snapshot: normalize(host.tuiApiRuntime?.getConnectionSnapshot?.()) };
    }
    case "wrapper-read-failure-thrown": {
      const host = {};
      const calls = [];
      const requestWrapper = async (targetHost, path, opts) => {
        calls.push({ sameHost: targetHost === host, path, opts: normalize(opts) ?? null });
        throw error("offline");
      };
      result.read = await capturesThrow(() => getJsonWithTuiApiRuntime(host, "/desktop-state", undefined, requestWrapper));
      result.calls = calls;
      result.hostConnectionState = host.tuiApiConnectionState;
      return { result, states, failures, requestCalls, mutateCalls, snapshot: normalize(host.tuiApiRuntime?.getConnectionSnapshot?.()) };
    }
    case "wrapper-mutation-uses-runtime-transport": {
      const host = {};
      const calls = [];
      const mutateWrapper = async (targetHost, path, body, opts) => {
        calls.push({ sameHost: targetHost === host, path, body: normalize(body), opts: normalize(opts) ?? null });
        return { ok: true, warning: "kept" };
      };
      result.mutation = await capturesThrow(() =>
        postJsonWithTuiApiRuntime(host, "/agents/resume", { sessionId: "claude-1" }, { timeoutMs: 60000 }, mutateWrapper),
      );
      result.calls = calls;
      result.connectionState = host.tuiApiRuntime?.getConnectionState?.();
      return { result, states, failures, requestCalls, mutateCalls, snapshot: normalize(host.tuiApiRuntime?.getConnectionSnapshot?.()) };
    }
    case "wrapper-mutation-failure-thrown": {
      const host = {};
      const calls = [];
      const mutateWrapper = async (targetHost, path, body, opts) => {
        calls.push({ sameHost: targetHost === host, path, body: normalize(body), opts: normalize(opts) ?? null });
        throw error("offline");
      };
      result.mutation = await capturesThrow(() =>
        postJsonWithTuiApiRuntime(host, "/agents/stop", { sessionId: "claude-1" }, undefined, mutateWrapper),
      );
      result.calls = calls;
      result.hostConnectionState = host.tuiApiConnectionState;
      return { result, states, failures, requestCalls, mutateCalls, snapshot: normalize(host.tuiApiRuntime?.getConnectionSnapshot?.()) };
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
  {
    name: "older wrapper mutation failure does not degrade newer success",
    input: { scenario: "older-mutation-failure-after-newer-success" },
  },
  {
    name: "older resource refresh failure does not degrade newer direct success",
    input: { scenario: "older-refresh-failure-after-newer-direct-success" },
  },
  {
    name: "best effort mutation failures do not enter reconnecting state",
    input: {
      scenario: "best-effort-mutation-failure",
      mutateSteps: [{ throw: { message: "telemetry timeout" } }],
    },
  },
  {
    name: "newer superseded refresh response owns the resource snapshot",
    input: { scenario: "superseded-refresh-response" },
  },
  {
    name: "pending refresh success is ignored after disposal",
    input: { scenario: "disposed-pending-refresh-success" },
  },
  {
    name: "pending refresh failure is ignored after disposal",
    input: { scenario: "disposed-pending-refresh-failure" },
  },
  {
    name: "direct read success is ignored after disposal",
    input: { scenario: "disposed-direct-read-success" },
  },
  {
    name: "mutation success is ignored after disposal",
    input: { scenario: "disposed-mutation-success" },
  },
  {
    name: "wrapper reads route through the shared runtime transport",
    input: { scenario: "wrapper-read-uses-runtime-transport" },
  },
  {
    name: "wrapper read failures stay thrown for existing callers",
    input: { scenario: "wrapper-read-failure-thrown" },
  },
  {
    name: "wrapper mutations route through the shared runtime transport",
    input: { scenario: "wrapper-mutation-uses-runtime-transport" },
  },
  {
    name: "wrapper mutation failures stay thrown for existing callers",
    input: { scenario: "wrapper-mutation-failure-thrown" },
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
