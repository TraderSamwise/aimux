#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-model-services-lifecycle.json", ROOT);
const FIXED_NOW = "2026-06-01T00:00:00.000Z";

const { initPaths, getProjectStateDirFor } = await import(new URL("dist/paths.js", ROOT));
const { saveMetadataEndpoint } = await import(new URL("dist/metadata-store.js", ROOT));
const { startProjectServices, stopProjectServices } = await import(
  new URL("dist/multiplexer/dashboard-model.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value, repoRoot) {
  return JSON.parse(
    JSON.stringify(value)
      .split(`/private${repoRoot}`)
      .join("<REPO>")
      .split(repoRoot)
      .join("<REPO>")
      .split(String(process.pid))
      .join("<PID>"),
  );
}

function endpointFiles(projectRoot) {
  const stateDir = getProjectStateDirFor(projectRoot);
  return {
    json: join(stateDir, "metadata-api.json"),
    text: join(stateDir, "metadata-api.txt"),
    host: join(stateDir, "host.json"),
  };
}

function endpointPresence(projectRoot) {
  const files = endpointFiles(projectRoot);
  return {
    json: existsSync(files.json),
    text: existsSync(files.text),
    host: existsSync(files.host),
  };
}

function makeStopRecorder(calls, method) {
  return () => {
    calls.push({ method, args: [] });
  };
}

function summarizeHost(host, projectRoot, calls) {
  return normalize(
    {
      projectServiceStartupMetadataSettling: host.projectServiceStartupMetadataSettling ?? null,
      projectServiceUiRefreshPending: host.projectServiceUiRefreshPending ?? null,
      projectServiceUiRefreshTimer: host.projectServiceUiRefreshTimer ? "set" : null,
      metadataServer: host.metadataServer ? "set" : null,
      loopWatcher: host.loopWatcher ? "set" : null,
      scribeWatcher: host.scribeWatcher ? "set" : null,
      transcriptReconciler: host.transcriptReconciler ? "set" : null,
      pluginRuntime: host.pluginRuntime ? "set" : null,
      endpointPresence: endpointPresence(projectRoot),
      calls,
    },
    projectRoot,
  );
}

async function withProject(input, runCase) {
  const projectRoot = join(
    tmpdir(),
    `aimux-dashboard-model-services-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  const aimuxHome = join(projectRoot, "home");
  mkdirSync(join(projectRoot, ".aimux"), { recursive: true });
  mkdirSync(aimuxHome, { recursive: true });
  const previousHome = process.env.AIMUX_HOME;
  const previousCwd = process.cwd();
  const realDate = Date;
  try {
    process.env.AIMUX_HOME = aimuxHome;
    process.chdir(projectRoot);
    globalThis.Date = class FixedDate extends realDate {
      constructor(...args) {
        super(...(args.length ? args : [FIXED_NOW]));
      }
      static now() {
        return realDate.parse(FIXED_NOW);
      }
      static parse(value) {
        return realDate.parse(value);
      }
      static UTC(...args) {
        return realDate.UTC(...args);
      }
    };
    await initPaths(projectRoot);
    if (input.endpoint) {
      saveMetadataEndpoint(
        {
          ...input.endpoint,
          pid: input.endpoint.pid === "<PID>" ? process.pid : input.endpoint.pid,
          updatedAt: FIXED_NOW,
        },
        projectRoot,
      );
    }
    return normalize(await runCase(projectRoot), projectRoot);
  } finally {
    globalThis.Date = realDate;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

async function runCase(input) {
  return withProject(input, async (projectRoot) => {
    const calls = [];
    const host = { projectRoot };
    if (input.projectServiceStartupMetadataSettling !== undefined) {
      host.projectServiceStartupMetadataSettling = input.projectServiceStartupMetadataSettling;
    }
    if (input.projectServiceUiRefreshPending !== undefined) {
      host.projectServiceUiRefreshPending = input.projectServiceUiRefreshPending;
    }
    if (input.projectServiceUiRefreshTimer) {
      host.projectServiceUiRefreshTimer = setTimeout(() => {}, 1_000_000);
    }
    if (input.metadataServer) {
      host.metadataServer = { stop: makeStopRecorder(calls, "metadataServer.stop") };
    }
    if (input.loopWatcher) {
      host.loopWatcher = { stop: makeStopRecorder(calls, "loopWatcher.stop") };
    }
    if (input.scribeWatcher) {
      host.scribeWatcher = { stop: makeStopRecorder(calls, "scribeWatcher.stop") };
    }
    if (input.transcriptReconciler) {
      host.transcriptReconciler = { stop: makeStopRecorder(calls, "transcriptReconciler.stop") };
    }
    if (input.pluginRuntime) {
      host.pluginRuntime = {
        stop: async () => {
          calls.push({ method: "pluginRuntime.stop", args: [] });
        },
      };
    }
    const result =
      input.api === "startProjectServices" ? await startProjectServices(host) : await stopProjectServices(host);
    return {
      result: result ?? null,
      host: summarizeHost(host, projectRoot, calls),
    };
  });
}

const cases = [
  {
    name: "start returns immediately when metadata server already exists",
    input: {
      api: "startProjectServices",
      metadataServer: true,
      projectServiceStartupMetadataSettling: false,
      projectServiceUiRefreshPending: true,
    },
  },
  {
    name: "stop clears owned services and removes owned endpoint files",
    input: {
      api: "stopProjectServices",
      metadataServer: true,
      loopWatcher: true,
      scribeWatcher: true,
      transcriptReconciler: true,
      pluginRuntime: true,
      projectServiceUiRefreshTimer: true,
      projectServiceStartupMetadataSettling: true,
      projectServiceUiRefreshPending: true,
      endpoint: { host: "127.0.0.1", port: 43190, pid: "<PID>" },
    },
  },
  {
    name: "stop preserves endpoint files when owned server pid differs",
    input: {
      api: "stopProjectServices",
      metadataServer: true,
      endpoint: { host: "127.0.0.1", port: 43191, pid: 424242 },
    },
  },
  {
    name: "stop clears watchers and plugin runtime without metadata server ownership",
    input: {
      api: "stopProjectServices",
      loopWatcher: true,
      scribeWatcher: true,
      transcriptReconciler: true,
      pluginRuntime: true,
      endpoint: { host: "127.0.0.1", port: 43192, pid: "<PID>" },
    },
  },
];

const outputCases = [];
for (const [index, entry] of cases.entries()) {
  const input = clone(entry.input);
  outputCases.push({
    id: `dashboard-model-services-lifecycle-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-model.ts",
    api: input.api,
    input,
    output: await runCase(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-model.ts",
  generatedBy: "scripts/capture-dashboard-model-services-lifecycle-contract.mjs",
  description:
    "Dashboard project-service lifecycle start/stop edge behavior captured by running TypeScript with fake host services.",
  cases: outputCases,
});

console.log(`${FIXTURE_PATH.pathname}: ${outputCases.length} cases`);
