#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const TEMP_DIR = new URL("node_modules/.contract-capture-runtime-guard-sync/", ROOT);
const GUARD_FIXTURE = new URL("testdata/contracts/v1/runtime-state/runtime-guard.json", ROOT);
const SYNC_FIXTURE = new URL("testdata/contracts/v1/runtime-state/runtime-sync.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(
    url,
    await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }),
  );
}

async function writeTempModule(name, sourcePath, rewrite = (source) => source) {
  const source = rewrite(await readFile(new URL(sourcePath, ROOT), "utf8"));
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    },
    fileName: sourcePath,
  }).outputText;
  const url = new URL(name, TEMP_DIR);
  await writeFile(url, transpiled);
  return url;
}

function rewriteRuntimeGuard(source) {
  return source
    .replace(/from "\.\.\/http-client\.js"/g, 'from "./http-client.mjs"')
    .replace(/from "\.\.\/metadata-store\.js"/g, 'from "./metadata-store.mjs"')
    .replace(/from "\.\.\/paths\.js"/g, 'from "./paths.mjs"')
    .replace(/from "\.\.\/runtime-owner\.js"/g, 'from "./runtime-owner.mjs"')
    .replace(/from "\.\.\/tmux\/runtime-manager\.js"/g, 'from "./tmux-runtime-manager.mjs"')
    .replace(/from "\.\.\/tmux\/session-names\.js"/g, 'from "./tmux-session-names.mjs"')
    .replace(/from "\.\.\/project-service-manifest\.js"/g, 'from "./project-service-manifest.mjs"');
}

await rm(TEMP_DIR, { force: true, recursive: true });
await mkdir(TEMP_DIR, { recursive: true });
await writeFile(new URL("http-client.mjs", TEMP_DIR), "export async function requestJson() { throw new Error('not used'); }\n");
await writeFile(new URL("metadata-store.mjs", TEMP_DIR), "export function loadMetadataEndpoint() { return null; }\n");
await writeFile(new URL("paths.mjs", TEMP_DIR), "export function getProjectStateDirFor(path) { return `${path}/.aimux`; }\n");
await writeFile(
  new URL("runtime-owner.mjs", TEMP_DIR),
  [
    "export const AIMUX_TMUX_RUNTIME_CONTRACT_VERSION = 'contract-v1';",
    "export const TMUX_RUNTIME_CONTRACT_OPTION = '@aimux-runtime-contract';",
    "export const TMUX_RUNTIME_REBUILD_REQUIRED_OPTION = '@aimux-runtime-rebuild-required';",
  ].join("\n"),
);
await writeFile(
  new URL("tmux-runtime-manager.mjs", TEMP_DIR),
  "export class TmuxRuntimeManager { isAvailable() { return false; } }\n",
);
await writeFile(
  new URL("tmux-session-names.mjs", TEMP_DIR),
  "export function isTmuxClientSessionForHost() { return false; }\n",
);
await writeFile(
  new URL("project-service-manifest.mjs", TEMP_DIR),
  [
    "export const PROJECT_SERVICE_API_VERSION = 5;",
    "export const PROJECT_SERVICE_CAPABILITIES = { parsedAgentOutput: true, attachmentRead: true, chatEventStream: true, agentTranscriptMessages: true, agentActivityState: true };",
    "export function getProjectServiceManifest() { return { apiVersion: PROJECT_SERVICE_API_VERSION, capabilities: { ...PROJECT_SERVICE_CAPABILITIES }, buildStamp: '<build-stamp>' }; }",
    "export function hasProjectServiceBuildDrift() { return false; }",
    "export function manifestsMatch(expected, actual) {",
    "  if (!actual) return false;",
    "  if (Number(actual.apiVersion || 0) !== expected.apiVersion) return false;",
    "  if (String(actual.buildStamp || '') !== expected.buildStamp) return false;",
    "  const actualCapabilities = actual.capabilities || {};",
    "  return Object.entries(expected.capabilities).every(([key, value]) => actualCapabilities[key] === value);",
    "}",
  ].join("\n"),
);

const guardUrl = await writeTempModule(
  "runtime-guard.mjs",
  "src/multiplexer/runtime-guard.ts",
  rewriteRuntimeGuard,
);
const syncUrl = await writeTempModule("runtime-sync.mjs", "src/multiplexer/runtime-sync.ts");
const guard = await import(guardUrl);
const { MultiplexerRuntimeSync } = await import(syncUrl);

const liveManifest = {
  apiVersion: 5,
  capabilities: {
    parsedAgentOutput: true,
    attachmentRead: true,
    chatEventStream: true,
    agentTranscriptMessages: true,
    agentActivityState: true,
  },
  buildStamp: "<build-stamp>",
};

const guardInputs = [
  {
    name: "flags self-drift above everything, even when the service matches",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "evaluateRuntimeGuard",
    input: { selfDrift: true, endpointPresent: true, serviceManifest: liveManifest },
  },
  {
    name: "reports disconnected when there is no endpoint",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "evaluateRuntimeGuard",
    input: { selfDrift: false, endpointPresent: false, serviceManifest: null },
  },
  {
    name: "reports disconnected when the service is unreachable",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "evaluateRuntimeGuard",
    input: { selfDrift: false, endpointPresent: true, serviceManifest: "unreachable" },
  },
  {
    name: "reports disconnected when an endpoint is present but no manifest came back",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "evaluateRuntimeGuard",
    input: { selfDrift: false, endpointPresent: true, serviceManifest: null },
  },
  {
    name: "reports stale when a live endpoint belongs to the wrong service identity",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "evaluateRuntimeGuard",
    input: {
      selfDrift: false,
      endpointPresent: true,
      serviceManifest: liveManifest,
      serviceIdentityMismatch: true,
    },
  },
  {
    name: "reports ok when the live service manifest matches ours",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "evaluateRuntimeGuard",
    input: { selfDrift: false, endpointPresent: true, serviceManifest: liveManifest },
  },
  {
    name: "reports runtime rebuild required before service health failures",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "evaluateRuntimeGuard",
    input: {
      selfDrift: false,
      runtimeRebuildRequired: true,
      endpointPresent: false,
      serviceManifest: null,
    },
  },
  {
    name: "flags a service-mismatch when build stamps differ",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "evaluateRuntimeGuard",
    input: {
      selfDrift: false,
      endpointPresent: true,
      serviceManifest: { ...liveManifest, buildStamp: "<build-stamp>-other" },
    },
  },
  {
    name: "matches identical states and distinguishes stale reasons",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "runtimeGuardEquals",
    pairs: [
      [{ kind: "ok" }, { kind: "ok" }],
      [{ kind: "disconnected" }, { kind: "disconnected" }],
      [{ kind: "runtime-rebuild-required" }, { kind: "runtime-rebuild-required" }],
      [{ kind: "ok" }, { kind: "disconnected" }],
      [
        { kind: "stale", reason: "self-drift" },
        { kind: "stale", reason: "self-drift" },
      ],
      [
        { kind: "stale", reason: "self-drift" },
        { kind: "stale", reason: "service-mismatch" },
      ],
    ],
  },
  {
    name: "keeps an ok dashboard unguarded for one missed disconnected probe",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "stabilizeRuntimeGuardProbe",
    input: { current: { kind: "ok" }, next: { kind: "disconnected" }, disconnectedProbeCount: 0 },
  },
  {
    name: "reports disconnected after repeated misses",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "stabilizeRuntimeGuardProbe",
    input: { current: { kind: "ok" }, next: { kind: "disconnected" }, disconnectedProbeCount: 1 },
  },
  {
    name: "resets the missed-probe count on ok or stale probes",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "stabilizeRuntimeGuardProbe",
    cases: [
      { current: { kind: "ok" }, next: { kind: "ok" }, disconnectedProbeCount: 1 },
      {
        current: { kind: "ok" },
        next: { kind: "stale", reason: "service-mismatch" },
        disconnectedProbeCount: 1,
      },
    ],
  },
  {
    name: "does not replace stale with disconnected until repeated misses",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "stabilizeRuntimeGuardProbe",
    input: {
      current: { kind: "stale", reason: "service-mismatch" },
      next: { kind: "disconnected" },
      disconnectedProbeCount: 0,
    },
  },
  {
    name: "passes safe nav keys and swallows repair/action keys",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "runtimeGuardKeyDisposition",
    keys: ["R", "r", "B", "b", "up", "down", "j", "k", "tab", "?", "q", "c", "d", "p", "l", "t", "g", "n", "x", "f", "enter", "1"],
  },
  {
    name: "gives each non-ok state a distinct non-empty title",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "runtimeGuardOverlayCopy",
    states: [
      { kind: "stale", reason: "self-drift" },
      { kind: "stale", reason: "service-mismatch" },
      { kind: "disconnected" },
      { kind: "runtime-rebuild-required" },
      { kind: "ok" },
    ],
  },
  {
    name: "escalates long-running guard states to an explicit restart command",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "runtimeGuardOverlayCopy",
    state: { kind: "disconnected" },
    options: { activeMs: 60000 },
  },
  {
    name: "escalates after a failed repair attempt even before the timeout",
    source: "src/multiplexer/runtime-guard.test.ts",
    api: "runtimeGuardOverlayCopy",
    state: { kind: "stale", reason: "service-mismatch" },
    options: { activeMs: 1000, repairFailed: true },
  },
];

function runGuard(input) {
  switch (input.api) {
    case "evaluateRuntimeGuard":
      return guard.evaluateRuntimeGuard(input.input);
    case "runtimeGuardEquals":
      return input.pairs.map(([left, right]) => guard.runtimeGuardEquals(left, right));
    case "stabilizeRuntimeGuardProbe":
      return input.cases
        ? input.cases.map((item) =>
            guard.stabilizeRuntimeGuardProbe(item.current, item.next, item.disconnectedProbeCount),
          )
        : guard.stabilizeRuntimeGuardProbe(
            input.input.current,
            input.input.next,
            input.input.disconnectedProbeCount,
          );
    case "runtimeGuardKeyDisposition":
      return Object.fromEntries(input.keys.map((key) => [key, guard.runtimeGuardKeyDisposition(key)]));
    case "runtimeGuardOverlayCopy":
      return input.states
        ? input.states.map((state) => guard.runtimeGuardOverlayCopy(state, input.options ?? {}))
        : guard.runtimeGuardOverlayCopy(input.state, input.options ?? {});
    default:
      throw new Error(`unknown runtime guard api ${input.api}`);
  }
}

const guardCases = guardInputs.map((input, index) => ({
  id: `runtime-state-runtime-guard-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: input.source,
  api: input.api,
  input,
  output: runGuard(input),
  inputSha256: hash(input),
}));

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
function runRuntimeSync(input) {
  const intervals = [];
  const calls = {
    syncSessionsFromTopology: 0,
    loadOfflineTopologySessions: 0,
    renderCurrentDashboardView: 0,
    renderDashboard: 0,
    writeStatuslineFile: 0,
    refreshRuntimeGuard: 0,
  };
  let mode = input.mode;
  globalThis.setInterval = (callback, delayMs) => {
    const interval = { callback, delayMs, cleared: false, unrefCalled: false };
    interval.unref = () => {
      interval.unrefCalled = true;
    };
    intervals.push(interval);
    return interval;
  };
  globalThis.clearInterval = (interval) => {
    interval.cleared = true;
  };
  try {
    const sync = new MultiplexerRuntimeSync({
      cwd: "/repo",
      getMode: () => mode,
      syncSessionsFromTopology: () => {
        calls.syncSessionsFromTopology += 1;
      },
      loadOfflineTopologySessions: () => {
        calls.loadOfflineTopologySessions += 1;
        return input.offlineChanged ?? false;
      },
      renderCurrentDashboardView: () => {
        calls.renderCurrentDashboardView += 1;
      },
      renderDashboard: () => {
        calls.renderDashboard += 1;
      },
      writeStatuslineFile: () => {
        calls.writeStatuslineFile += 1;
      },
      refreshRuntimeGuard: () => {
        calls.refreshRuntimeGuard += 1;
      },
    });
    for (const action of input.actions) {
      if (action.kind === "startHeartbeat") sync.startHeartbeat();
      else if (action.kind === "stopHeartbeat") sync.stopHeartbeat();
      else if (action.kind === "startProjectServiceRefresh") sync.startProjectServiceRefresh();
      else if (action.kind === "stopProjectServiceRefresh") sync.stopProjectServiceRefresh();
      else if (action.kind === "setMode") mode = action.mode;
      else if (action.kind === "tick") {
        for (const interval of intervals.filter((candidate) => !candidate.cleared)) {
          interval.callback();
        }
      } else {
        throw new Error(`unknown runtime sync action ${action.kind}`);
      }
    }
    return {
      intervalCount: intervals.length,
      intervals: intervals.map((interval) => ({
        delayMs: interval.delayMs,
        cleared: interval.cleared,
        unrefCalled: interval.unrefCalled,
      })),
      calls,
    };
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

const syncInputs = [
  {
    name: "does not run tmux topology sync from the heartbeat in project-service mode",
    source: "src/multiplexer/runtime-sync.test.ts",
    mode: "project-service",
    actions: [{ kind: "startHeartbeat" }, { kind: "tick" }, { kind: "stopHeartbeat" }],
  },
  {
    name: "does not run tmux topology repair from a project-service timer",
    source: "src/multiplexer/runtime-sync.test.ts",
    mode: "project-service",
    actions: [{ kind: "startProjectServiceRefresh" }, { kind: "tick" }, { kind: "stopProjectServiceRefresh" }],
  },
  {
    name: "dashboard heartbeat refreshes guard and renders when offline topology changes",
    source: "src/multiplexer/runtime-sync.ts",
    mode: "dashboard",
    offlineChanged: true,
    actions: [{ kind: "startHeartbeat" }, { kind: "tick" }, { kind: "stopHeartbeat" }],
  },
];

const syncCases = syncInputs.map((input, index) => ({
  id: `runtime-state-runtime-sync-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: input.source,
  input,
  output: runRuntimeSync(input),
  inputSha256: hash(input),
}));

await writeContractJson(GUARD_FIXTURE, {
  version: 1,
  source: ["src/multiplexer/runtime-guard.test.ts", "src/multiplexer/runtime-guard.ts"],
  generatedBy: "scripts/capture-runtime-guard-sync-contract.mjs",
  description:
    "Runtime guard state classification, equality, disconnected-probe stabilization, guarded key disposition, and overlay copy captured by running TypeScript runtime-guard.",
  cases: guardCases,
});

await writeContractJson(SYNC_FIXTURE, {
  version: 1,
  source: ["src/multiplexer/runtime-sync.test.ts", "src/multiplexer/runtime-sync.ts"],
  generatedBy: "scripts/capture-runtime-guard-sync-contract.mjs",
  description:
    "Runtime sync heartbeat and project-service refresh timer behavior captured by running TypeScript MultiplexerRuntimeSync with recorded dependencies.",
  cases: syncCases,
});

console.log(`${GUARD_FIXTURE.pathname}: ${guardCases.length} guard cases`);
console.log(`${SYNC_FIXTURE.pathname}: ${syncCases.length} sync cases`);
