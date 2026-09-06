#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/dashboard-lifecycle.json", ROOT);

const {
  captureDashboardLifecycle,
  isDashboardLifecycleCurrent,
  renderDashboardIfCurrent,
  startDashboardLifecycleTask,
} = await import(new URL("dist/multiplexer/dashboard-lifecycle.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushLifecycleTask() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const cases = [];
function record(name, sourceName, input, run) {
  const output = run();
  cases.push({
    id: `runtime-state-dashboard-lifecycle-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/multiplexer/dashboard-lifecycle.test.ts",
    sourceName,
    api: "dashboard-lifecycle",
    input,
    output,
    inputSha256: hash(input),
  });
}

async function recordAsync(name, sourceName, input, run) {
  const output = await run();
  cases.push({
    id: `runtime-state-dashboard-lifecycle-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/multiplexer/dashboard-lifecycle.test.ts",
    sourceName,
    api: "dashboard-lifecycle",
    input,
    output,
    inputSha256: hash(input),
  });
}

record(
  "keeps unscoped dashboard lifecycle tokens current while the host stays in dashboard mode",
  "keeps unscoped dashboard lifecycle tokens current while the host stays in dashboard mode",
  { host: { mode: "dashboard" }, opts: {} },
  () => {
    const host = { mode: "dashboard" };
    const token = captureDashboardLifecycle(host);
    return { token, current: isDashboardLifecycleCurrent(host, token) };
  },
);

record(
  "fails closed when an input epoch was requested but the host cannot verify it",
  "fails closed when an input epoch was requested but the host cannot verify it",
  { host: { mode: "dashboard" }, opts: { inputEpoch: true } },
  () => {
    const host = { mode: "dashboard" };
    const token = captureDashboardLifecycle(host, { inputEpoch: true });
    return { token, current: isDashboardLifecycleCurrent(host, token) };
  },
);

record(
  "rejects stale input epoch tokens",
  "rejects stale input epoch tokens",
  {
    hostBefore: { mode: "dashboard", dashboardInputEpoch: 3 },
    opts: { inputEpoch: true },
    mutate: { dashboardInputEpoch: 4 },
  },
  () => {
    const host = { mode: "dashboard", dashboardInputEpoch: 3 };
    const token = captureDashboardLifecycle(host, { inputEpoch: true });
    host.dashboardInputEpoch = 4;
    return { token, currentAfterMutation: isDashboardLifecycleCurrent(host, token), hostAfter: host };
  },
);

record(
  "fails closed when a screen token cannot be verified",
  "fails closed when a screen token cannot be verified",
  { host: { mode: "dashboard" }, opts: { screen: "coordination" } },
  () => {
    const host = { mode: "dashboard" };
    const token = captureDashboardLifecycle(host, { screen: "coordination" });
    return { token, current: isDashboardLifecycleCurrent(host, token) };
  },
);

record(
  "renders only when the requested screen still matches",
  "renders only when the requested screen still matches",
  {
    hostBefore: { mode: "dashboard", dashboardState: { screen: "coordination" } },
    opts: { screen: "coordination" },
    mutate: { dashboardState: { screen: "project" } },
  },
  () => {
    const calls = [];
    const host = { mode: "dashboard", dashboardState: { screen: "coordination" } };
    const token = captureDashboardLifecycle(host, { screen: "coordination" });
    renderDashboardIfCurrent(host, token, () => calls.push({ screen: host.dashboardState.screen }));
    host.dashboardState.screen = "project";
    renderDashboardIfCurrent(host, token, () => calls.push({ screen: host.dashboardState.screen }));
    return { token, calls, hostAfter: host };
  },
);

await recordAsync(
  "runs lifecycle task success handlers only while the token is current",
  "runs lifecycle task success handlers only while the token is current",
  {
    hostBefore: { mode: "dashboard", dashboardInputEpoch: 1, dashboardState: { screen: "project" } },
    opts: { inputEpoch: true, screen: "project" },
    mutateBeforeResolve: { dashboardInputEpoch: 2 },
    resolution: "done",
  },
  async () => {
    const pending = deferred();
    const calls = [];
    const host = { mode: "dashboard", dashboardInputEpoch: 1, dashboardState: { screen: "project" } };
    startDashboardLifecycleTask(host, { inputEpoch: true, screen: "project" }, () => pending.promise, {
      onSuccess: (value, token) => calls.push({ kind: "success", value, token }),
      onFinally: (token) => calls.push({ kind: "finally", token }),
    });
    host.dashboardInputEpoch = 2;
    pending.resolve("done");
    await pending.promise;
    await flushLifecycleTask();
    return { calls, hostAfter: host };
  },
);

await recordAsync(
  "runs lifecycle task error handlers only while the token is current",
  "runs lifecycle task error handlers only while the token is current",
  {
    hostBefore: { mode: "dashboard", dashboardInputEpoch: 1, dashboardState: { screen: "coordination" } },
    opts: { inputEpoch: true, screen: "coordination" },
    mutateBeforeReject: { mode: "session" },
    rejection: "late failure",
  },
  async () => {
    const pending = deferred();
    const calls = [];
    const host = { mode: "dashboard", dashboardInputEpoch: 1, dashboardState: { screen: "coordination" } };
    startDashboardLifecycleTask(host, { inputEpoch: true, screen: "coordination" }, () => pending.promise, {
      onError: (error, token) =>
        calls.push({ kind: "error", error: error instanceof Error ? error.message : String(error), token }),
    });
    host.mode = "session";
    pending.reject(new Error("late failure"));
    await pending.promise.catch(() => undefined);
    await Promise.resolve();
    return { calls, hostAfter: host };
  },
);

await recordAsync(
  "runs lifecycle task handlers when the token remains current",
  "runs lifecycle task handlers when the token remains current",
  {
    host: { mode: "dashboard", dashboardInputEpoch: 1, dashboardState: { screen: "library" } },
    opts: { inputEpoch: true, screen: "library" },
    resolution: "ok",
  },
  async () => {
    const calls = [];
    const host = { mode: "dashboard", dashboardInputEpoch: 1, dashboardState: { screen: "library" } };
    startDashboardLifecycleTask(host, { inputEpoch: true, screen: "library" }, async () => "ok", {
      onSuccess: (value, token) => calls.push({ kind: "success", value, token }),
      onFinally: (token) => calls.push({ kind: "finally", token }),
    });
    await flushLifecycleTask();
    return { calls, hostAfter: host };
  },
);

await recordAsync(
  "does not route success handler exceptions to the error handler",
  "does not route success handler exceptions to the error handler",
  {
    host: { mode: "dashboard", dashboardState: { screen: "library" } },
    opts: { screen: "library" },
    successThrows: "render failed",
  },
  async () => {
    const calls = [];
    const host = { mode: "dashboard", dashboardState: { screen: "library" } };
    startDashboardLifecycleTask(host, { screen: "library" }, async () => "ok", {
      onSuccess: () => {
        calls.push({ kind: "success" });
        throw new Error("render failed");
      },
      onError: (error, token) =>
        calls.push({ kind: "error", error: error instanceof Error ? error.message : String(error), token }),
    });
    await flushLifecycleTask();
    return { calls, hostAfter: host };
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-lifecycle.test.ts",
  generatedBy: "scripts/capture-dashboard-lifecycle-guard-contract.mjs",
  description:
    "Dashboard lifecycle token capture, currentness checks, render gating, and async handler guards captured by running TypeScript.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
