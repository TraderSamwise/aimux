#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-restart/render.json", ROOT);

const { renderRuntimeRestartResult } = await import(new URL("dist/runtime-restart.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const before = {
  generatedAt: "2026-06-20T00:00:00.000Z",
  cliVersion: "0.1.21",
  cliLaunch: { command: "/Users/sam/.local/bin/aimux", args: [], source: "stable-shim" },
  expected: {
    projectService: { apiVersion: 4, capabilities: {}, buildStamp: "service-new" },
    runtimeOwner: "owner-new",
    runtimeContract: "contract-new",
  },
  daemon: { running: true, info: { pid: 9001, port: 43190, startedAt: "then", updatedAt: "now" }, process: null, projectCount: 1 },
  tmux: { available: true, version: "tmux 3.5a", sessionCount: 1 },
  projects: [],
  staleHookProcesses: [],
  summary: { projects: 0, ok: 0, needsRestart: 0, runtimeRebuildRequired: 0 },
};

function project(overrides = {}) {
  return {
    projectRoot: "/repo/alpha",
    runtimeRebuildRequired: false,
    runtime: { status: "skipped", error: null },
    service: { status: "ensured", state: { projectId: "alpha", projectRoot: "/repo/alpha", pid: 1001 }, error: null },
    dashboard: { status: "skipped", sessionName: null, target: null, error: null },
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    startedAt: "2026-06-20T00:00:00.000Z",
    finishedAt: "2026-06-20T00:00:01.000Z",
    before,
    verification: { status: "skipped", after: null, error: null },
    daemon: {
      previous: { pid: 9001, port: 43190, startedAt: "then", updatedAt: "now" },
      current: { pid: 9002, port: 43190, startedAt: "after", updatedAt: "after" },
    },
    orphanCleanup: {
      attemptedProcessPids: [],
      processPids: [],
      failedProcessPids: [],
      attemptedTmuxSessions: [],
      tmuxSessions: [],
      failedTmuxSessions: [],
      errors: [],
    },
    projects: [project()],
    summary: {
      projects: 1,
      servicesEnsured: 1,
      runtimeRepairs: 0,
      dashboardsReloaded: 0,
      runtimeRebuildRequired: 0,
      orphanProcessesCleaned: 0,
      orphanTmuxSessionsCleaned: 0,
      failures: 0,
    },
    ...overrides,
  };
}

const cases = [];
function record(name, input) {
  cases.push({
    id: `runtime-restart-render-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/runtime-restart.test.ts",
    api: "renderRuntimeRestartResult",
    input,
    output: renderRuntimeRestartResult(input),
    inputSha256: hash(input),
  });
}

record(
  "renders a restarted daemon and ensured service",
  result({
    projects: [
      project({
        dashboard: {
          status: "reloaded",
          sessionName: "aimux-alpha-111",
          target: { sessionName: "aimux-alpha-111", windowId: "@1", windowIndex: 0, windowName: "dashboard" },
          error: null,
        },
      }),
    ],
    summary: { ...result().summary, dashboardsReloaded: 1 },
  }),
);

record(
  "renders a retained daemon",
  result({
    daemon: {
      previous: { pid: 9002, port: 43190, startedAt: "then", updatedAt: "now" },
      current: { pid: 9002, port: 43190, startedAt: "then", updatedAt: "now" },
      retained: true,
    },
  }),
);

record(
  "renders runtime repair section",
  result({
    projects: [
      project({
        runtimeRebuildRequired: true,
        runtime: { status: "repaired", error: null },
      }),
    ],
    summary: { ...result().summary, runtimeRepairs: 1, runtimeRebuildRequired: 1 },
  }),
);

record(
  "renders project step failures",
  result({
    projects: [
      project({
        runtime: { status: "failed", error: "tmux option write failed" },
        service: { status: "failed", state: null, error: "service refused" },
        dashboard: { status: "failed", sessionName: null, target: null, error: "dashboard target missing" },
      }),
    ],
    summary: { ...result().summary, servicesEnsured: 0, failures: 1 },
  }),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/runtime-restart.test.ts",
  generatedBy: "scripts/capture-runtime-restart-render-contract.mjs",
  description: "Runtime restart result text rendering captured by running TypeScript renderRuntimeRestartResult.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
