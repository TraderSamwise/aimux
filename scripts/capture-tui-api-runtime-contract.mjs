#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/tui-api-runtime.json", ROOT);
const {
  hasTuiApiRuntimeReadTransport,
  isRecoverableTuiApiError,
  isTuiApiConnectionMutationBlocked,
  scheduleTuiApiRecovery,
} = await import(new URL("dist/multiplexer/tui-api-runtime.js", ROOT));

const FIXED_NOW = 1_700_000_000_000;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function materializeError(input) {
  if (input.errorKind === "null") return null;
  const error = new Error(input.message ?? "error");
  for (const [key, value] of Object.entries(input.error ?? {})) {
    error[key] = value;
  }
  return error;
}

function materializeHost(input) {
  if (input.host === "with-read-transport") return { getFromProjectService: () => undefined };
  if (input.host === "with-nonfunction-read-transport") return { getFromProjectService: true };
  return {};
}

function normalize(value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]));
}

function error(message) {
  return new Error(message);
}

async function runScheduleCase(input) {
  const realDateNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let nextTimerId = 1;
  const callbacks = new Map();
  const timers = [];
  const cleared = [];
  const unref = [];
  const calls = [];
  function fakeTimer(delay, existing = false) {
    const timer = {
      id: existing ? 0 : nextTimerId++,
      delay,
      unref() {
        unref.push(this.id);
      },
    };
    return timer;
  }
  try {
    Date.now = () => input.now ?? FIXED_NOW;
    globalThis.setTimeout = (callback, delay) => {
      const timer = fakeTimer(delay);
      timers.push({ id: timer.id, delay });
      callbacks.set(timer.id, callback);
      return timer;
    };
    globalThis.clearTimeout = (timer) => {
      cleared.push(timer?.id ?? null);
      if (timer?.id) callbacks.delete(timer.id);
    };
    const host = {
      mode: input.mode,
      tuiApiRecoveryFailureStreak: input.failureStreak,
      tuiApiLastRecoveryAt: input.lastRecoveryAt,
      tuiApiRecoveryInFlight: input.inFlight,
      runtimeGuardProbing: input.runtimeGuardProbing,
      runtimeGuardState: input.runtimeGuardState,
      tuiApiRecoveryTimer:
        input.existingTimerDelay === undefined ? undefined : fakeTimer(input.existingTimerDelay, true),
      tuiApiRecoveryDueAt: input.existingDueAt,
      renderCurrentDashboardView: () => calls.push({ method: "renderCurrentDashboardView", args: [] }),
      refreshRuntimeGuard: () => {
        calls.push({ method: "refreshRuntimeGuard", args: [] });
        if (input.refreshRuntimeGuardThrows) throw error(input.refreshRuntimeGuardThrows);
      },
      tuiApiRuntime: {
        beginRecovery: () => calls.push({ method: "tuiApiRuntime.beginRecovery", args: [] }),
        finishRecovery: () => calls.push({ method: "tuiApiRuntime.finishRecovery", args: [] }),
        markRecoveryFailed: (caught) =>
          calls.push({ method: "tuiApiRuntime.markRecoveryFailed", args: [normalize(caught)] }),
        refreshCriticalResources: async () => {
          calls.push({ method: "tuiApiRuntime.refreshCriticalResources", args: [] });
          if (input.refreshCriticalThrows) throw error(input.refreshCriticalThrows);
          return (
            input.refreshCriticalResources ?? {
              attemptedResources: ["desktop-state"],
              missingResources: [],
              failedResources: [],
            }
          );
        },
        getConnectionSnapshot: () =>
          input.connectionSnapshot ?? {
            state: "ready",
            failedCriticalResources: [],
            lastError: undefined,
          },
      },
    };
    scheduleTuiApiRecovery(host, input.options ?? {});
    if (input.fireScheduled) {
      for (const [id, callback] of [...callbacks.entries()]) {
        callbacks.delete(id);
        callback();
        await new Promise((resolve) => realSetTimeout(resolve, 0));
      }
    }
    return normalize({
      host: {
        tuiApiRecoveryPending: host.tuiApiRecoveryPending ?? false,
        tuiApiRecoveryInFlight: host.tuiApiRecoveryInFlight ?? false,
        tuiApiRecoveryDueAt: host.tuiApiRecoveryDueAt,
        tuiApiRecoveryTimer: host.tuiApiRecoveryTimer
          ? { id: host.tuiApiRecoveryTimer.id, delay: host.tuiApiRecoveryTimer.delay }
          : null,
        tuiApiRecoveryFailureStreak: host.tuiApiRecoveryFailureStreak,
        tuiApiLastRecoveryAt: host.tuiApiLastRecoveryAt,
        tuiApiRecoveryLastError: host.tuiApiRecoveryLastError,
        dashboardRepairNotices: host.dashboardRepairNotices ?? [],
        footerFlash: host.footerFlash,
        footerFlashTicks: host.footerFlashTicks,
      },
      timers,
      cleared,
      unref,
      calls,
    });
  } finally {
    Date.now = realDateNow;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

async function run(input) {
  switch (input.api) {
    case "isTuiApiConnectionMutationBlocked":
      return isTuiApiConnectionMutationBlocked(input.snapshot, input.options ?? {});
    case "isRecoverableTuiApiError":
      return isRecoverableTuiApiError(materializeError(input));
    case "hasTuiApiRuntimeReadTransport":
      return hasTuiApiRuntimeReadTransport(materializeHost(input));
    case "scheduleTuiApiRecovery":
      return runScheduleCase(input);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const inputs = [
  {
    name: "allows mutations while ready",
    api: "isTuiApiConnectionMutationBlocked",
    snapshot: { state: "ready", failedCriticalResources: [] },
  },
  {
    name: "blocks mutations while reconnecting",
    api: "isTuiApiConnectionMutationBlocked",
    snapshot: { state: "reconnecting", failedCriticalResources: [] },
  },
  {
    name: "allows explicit recovery probes while reconnecting",
    api: "isTuiApiConnectionMutationBlocked",
    snapshot: { state: "reconnecting", failedCriticalResources: [] },
    options: { allowDuringReconnect: true },
  },
  {
    name: "blocks ready mutations when critical resources failed",
    api: "isTuiApiConnectionMutationBlocked",
    snapshot: { state: "ready", failedCriticalResources: ["desktop-state"] },
  },
  {
    name: "blocks stale repairing and failed states",
    api: "isTuiApiConnectionMutationBlocked",
    snapshots: [
      { state: "stale", failedCriticalResources: [] },
      { state: "repairing", failedCriticalResources: [] },
      { state: "failed", failedCriticalResources: [] },
    ],
  },
  {
    name: "honors explicit recoverable error override",
    api: "isRecoverableTuiApiError",
    error: { tuiApiRecoverable: true, status: 400 },
  },
  {
    name: "honors explicit nonrecoverable error override",
    api: "isRecoverableTuiApiError",
    error: { tuiApiRecoverable: false, status: 503 },
  },
  {
    name: "treats retryable HTTP statuses as recoverable",
    api: "isRecoverableTuiApiError",
    errors: [{ status: 408 }, { status: 409 }, { status: 425 }, { status: 429 }, { status: 500 }, { status: 503 }],
  },
  {
    name: "treats most 4xx statuses as semantic failures",
    api: "isRecoverableTuiApiError",
    errors: [{ status: 400 }, { status: 401 }, { status: 404 }],
  },
  {
    name: "treats transient socket codes as recoverable",
    api: "isRecoverableTuiApiError",
    errors: [{ code: "ETIMEDOUT" }, { code: "ECONNREFUSED" }, { code: "ECONNRESET" }, { code: "EPIPE" }],
  },
  {
    name: "defaults unknown errors to recoverable",
    api: "isRecoverableTuiApiError",
    errors: [{ code: "UNKNOWN" }, {}, null],
  },
  {
    name: "detects host read transport presence",
    api: "hasTuiApiRuntimeReadTransport",
    hosts: ["with-read-transport", "with-nonfunction-read-transport", "empty"],
  },
  {
    name: "does not schedule recovery outside dashboard mode",
    api: "scheduleTuiApiRecovery",
    mode: "project-service",
  },
  {
    name: "debounces first dashboard recovery request",
    api: "scheduleTuiApiRecovery",
    mode: "dashboard",
  },
  {
    name: "immediate recovery replaces later pending timer",
    api: "scheduleTuiApiRecovery",
    mode: "dashboard",
    options: { immediate: true },
    existingTimerDelay: 250,
    existingDueAt: FIXED_NOW + 250,
  },
  {
    name: "failure streak and last recovery time throttle retries",
    api: "scheduleTuiApiRecovery",
    mode: "dashboard",
    options: { immediate: true },
    failureStreak: 2,
    lastRecoveryAt: FIXED_NOW - 100,
  },
  {
    name: "scheduled recovery success clears pending retry state",
    api: "scheduleTuiApiRecovery",
    mode: "dashboard",
    options: { immediate: true },
    failureStreak: 3,
    fireScheduled: true,
  },
  {
    name: "scheduled recovery waits and reschedules when critical resources are unverified",
    api: "scheduleTuiApiRecovery",
    mode: "dashboard",
    options: { immediate: true },
    fireScheduled: true,
    refreshCriticalResources: {
      attemptedResources: [],
      missingResources: ["desktop-state"],
      failedResources: [],
    },
    connectionSnapshot: {
      state: "reconnecting",
      failedCriticalResources: ["desktop-state"],
      lastError: "desktop-state unavailable",
    },
  },
  {
    name: "scheduled recovery failure records error and backs off",
    api: "scheduleTuiApiRecovery",
    mode: "dashboard",
    options: { immediate: true },
    fireScheduled: true,
    refreshCriticalThrows: "desktop-state timeout",
  },
];

async function expandRun(input) {
  if (input.snapshots) {
    return input.snapshots.map((snapshot) => ({
      snapshot,
      blocked: isTuiApiConnectionMutationBlocked(snapshot, input.options ?? {}),
    }));
  }
  if (input.errors) {
    return input.errors.map((error) => ({ error, recoverable: isRecoverableTuiApiError(materializeError({ error })) }));
  }
  if (input.hosts) {
    return input.hosts.map((host) => ({
      host,
      hasReadTransport: hasTuiApiRuntimeReadTransport(materializeHost({ host })),
    }));
  }
  return run(input);
}

const cases = [];
for (const [index, input] of inputs.entries()) {
  cases.push({
    id: `tui-api-runtime-${String(index + 1).padStart(3, "0")}`,
    name: input.name,
    source:
      input.api === "scheduleTuiApiRecovery"
        ? "src/multiplexer/tui-api-runtime.ts"
        : "src/multiplexer/tui-api-runtime.test.ts",
    api: input.api,
    input,
    output: await expandRun(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/tui-api-runtime.test.ts",
  generatedBy: "scripts/capture-tui-api-runtime-contract.mjs",
  description:
    "TUI API runtime pure connection policy and scheduler contracts captured by running TypeScript mutation-blocking, recoverable-error, read-transport, and recovery helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
