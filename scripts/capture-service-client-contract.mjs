#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/service-client/client.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function importWithPrelude(path, prelude) {
  const url = new URL(path, ROOT);
  const source = (await readFile(url, "utf8")).replace(/^import[\s\S]*?;\n/gm, "");
  const transpiled = ts.transpileModule(`${prelude}\n${source}`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: url.pathname,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const daemonClient = await importWithPrelude(
  "src/daemon-client.ts",
  `
let daemonInfo = null;
let requestResult = { status: 200, json: { ok: true } };
let requestCalls = [];
export function __setDaemonClientState(state) {
  daemonInfo = state.daemonInfo ?? null;
  requestResult = state.requestResult ?? { status: 200, json: { ok: true } };
  requestCalls = [];
}
export function __daemonClientCalls() {
  return requestCalls;
}
function getDaemonBaseUrl(port) {
  return "http://127.0.0.1:" + (port ?? 43190);
}
function loadDaemonInfo() {
  return daemonInfo;
}
async function requestJson(url, init) {
  requestCalls.push({ url, init });
  return requestResult;
}
`,
);

const coreClient = await importWithPrelude(
  "src/core-command-client.ts",
  `
let ensureCalls = 0;
let sendCalls = [];
export function __resetCoreClientState() {
  ensureCalls = 0;
  sendCalls = [];
}
export function __coreClientCalls() {
  return { ensureCalls, sendCalls };
}
async function ensureDaemonRunning() {
  ensureCalls += 1;
}
async function sendCoreCommand(command, payload, options) {
  sendCalls.push({ command, payload, options });
  return { ok: true, id: "test", command, issuedAt: "1970-01-01T00:00:00.000Z", result: { pong: true } };
}
`,
);

const restartClient = await importWithPrelude(
  "src/control-plane-restart-client.ts",
  `
let daemonInfo = null;
let daemonState = { version: 1, updatedAt: "1970-01-01T00:00:00.000Z", projects: {} };
let calls = [];
const restartValue = {
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  before: {},
  verification: { status: "skipped", after: null, error: null },
  daemon: {
    previous: null,
    current: { pid: 42, port: 43190, startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  },
  projects: [],
  summary: {
    projects: 0,
    servicesEnsured: 0,
    runtimeRepairs: 0,
    dashboardsReloaded: 0,
    runtimeRebuildRequired: 0,
    failures: 0,
  },
};
export function __setRestartClientState(state) {
  daemonInfo = state.daemonInfo ?? null;
  daemonState = state.daemonState ?? { version: 1, updatedAt: "1970-01-01T00:00:00.000Z", projects: {} };
  calls = [];
}
export function __restartClientCalls() {
  return calls;
}
function loadDaemonInfo() {
  calls.push({ fn: "loadDaemonInfo" });
  return daemonInfo;
}
function loadDaemonState() {
  calls.push({ fn: "loadDaemonState" });
  return daemonState;
}
async function assertNotStoppingNewerDaemon() {
  calls.push({ fn: "assertNotStoppingNewerDaemon" });
}
async function stopDaemonInfo(daemon, state) {
  calls.push({ fn: "stopDaemonInfo", daemon, state });
  return { ...daemon, stoppedProjectServices: Object.values(state.projects ?? {}) };
}
function ensureDaemonRunning(options) {
  calls.push({ fn: "ensureDaemonRunning", options });
}
async function restartAimuxControlPlane(options) {
  calls.push({
    fn: "restartAimuxControlPlane",
    options: {
      reason: options.reason,
      projectRoot: options.projectRoot,
      hasStopDaemon: typeof options.stopDaemon === "function",
      hasEnsureDaemonRunning: typeof options.ensureDaemonRunning === "function",
    },
  });
  options.ensureDaemonRunning?.();
  if (options.stopDaemon) await options.stopDaemon();
  return restartValue;
}
function renderRuntimeRestartResult(restart) {
  calls.push({ fn: "renderRuntimeRestartResult", restart });
  return "restart text";
}
`,
);

async function capture(input, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function run(input) {
  switch (input.api) {
    case "requestDaemonJson":
      daemonClient.__setDaemonClientState(input.state ?? {});
      return capture(input, async () => ({
        result: await daemonClient.requestDaemonJson(input.path, input.init),
        calls: daemonClient.__daemonClientCalls(),
      }));
    case "requestCoreCommand":
      coreClient.__resetCoreClientState();
      return capture(input, async () => ({
        result: await coreClient.requestCoreCommand(input.command, input.payload, input.options),
        calls: coreClient.__coreClientCalls(),
      }));
    case "restartControlPlaneFromCli":
      restartClient.__setRestartClientState(input.state ?? {});
      return capture(input, async () => ({
        result: await restartClient.restartControlPlaneFromCli(input.projectRoot),
        calls: restartClient.__restartClientCalls(),
      }));
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const daemonInfo = {
  pid: 123,
  port: 43210,
  startedAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
};

const daemonState = {
  version: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  projects: {
    alpha: {
      projectId: "alpha",
      projectRoot: "/repo",
      pid: 222,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  },
};

const inputs = [
  {
    name: "throws when the daemon is not running",
    source: "src/daemon-client.test.ts",
    api: "requestDaemonJson",
    path: "/health",
    state: { daemonInfo: null },
  },
  {
    name: "passes request fields to the stored daemon endpoint",
    source: "src/daemon-client.test.ts",
    api: "requestDaemonJson",
    path: "/commands",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "ping" }),
      timeoutMs: 1234,
    },
    state: { daemonInfo, requestResult: { status: 200, json: { ok: true, value: 1 } } },
  },
  {
    name: "throws daemon error payloads for non-2xx responses",
    source: "src/daemon-client.test.ts",
    api: "requestDaemonJson",
    path: "/health",
    state: { daemonInfo, requestResult: { status: 503, json: { error: "daemon unavailable" } } },
  },
  {
    name: "throws daemon error payloads when ok is false",
    source: "src/daemon-client.test.ts",
    api: "requestDaemonJson",
    path: "/commands",
    state: { daemonInfo, requestResult: { status: 200, json: { ok: false, error: "bad command" } } },
  },
  {
    name: "requestCoreCommand ensures the daemon by default",
    source: "src/core-command-client.test.ts",
    api: "requestCoreCommand",
    command: "ping",
  },
  {
    name: "requestCoreCommand can skip daemon startup for read-only diagnostics",
    source: "src/core-command-client.test.ts",
    api: "requestCoreCommand",
    command: "relay.status",
    options: { ensureDaemon: false },
  },
  {
    name: "requestCoreCommand passes command options to pure transport",
    source: "src/core-command-client.test.ts",
    api: "requestCoreCommand",
    command: "relay.status",
    options: { ensureDaemon: false, timeoutMs: 1234 },
  },
  {
    name: "restartControlPlaneFromCli runs restart through local repair orchestration",
    source: "src/control-plane-restart-client.test.ts",
    api: "restartControlPlaneFromCli",
    state: {},
  },
  {
    name: "restartControlPlaneFromCli passes project-scoped restart requests",
    source: "src/control-plane-restart-client.test.ts",
    api: "restartControlPlaneFromCli",
    projectRoot: "/repo",
    state: {},
  },
  {
    name: "restartControlPlaneFromCli preserves stale daemon info for local bootstrap repair",
    source: "src/control-plane-restart-client.test.ts",
    api: "restartControlPlaneFromCli",
    projectRoot: "/repo",
    state: { daemonInfo: { ...daemonInfo, pid: 111, port: 43190 }, daemonState },
  },
];

const cases = [];
for (const input of inputs) {
  cases.push({
    id: `service-client-${String(cases.length + 1).padStart(3, "0")}`,
    name: input.name,
    source: input.source,
    api: input.api,
    input,
    output: await run(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: [
    "src/daemon-client.test.ts",
    "src/core-command-client.test.ts",
    "src/control-plane-restart-client.test.ts",
  ],
  generatedBy: "scripts/capture-service-client-contract.mjs",
  description:
    "Daemon JSON client, core command client, and CLI control-plane restart orchestration contracts captured by running TypeScript client helpers with mocked dependencies.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
