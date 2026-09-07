#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-control-project-service-request.json", ROOT);

const previousAimuxHome = process.env.AIMUX_HOME;
const tempRoot = await mkdtemp(join(tmpdir(), "aimux-dashboard-control-request-"));
process.env.AIMUX_HOME = join(tempRoot, "home");
Date.now = () => 1_700_000_000_000;

const { getProjectStateDirFor } = await import(new URL("dist/paths.js", ROOT));
const { getProjectServiceManifest } = await import(new URL("dist/project-service-manifest.js", ROOT));
const {
  getFromProjectService,
  invalidateDashboardProjectServiceEndpointHealth,
  postToProjectService,
  resolveCurrentProjectServiceEndpointForDashboard,
} = await import(new URL("dist/multiplexer/dashboard-control.js", ROOT));

const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      status: value.status,
      response: normalize(value.response),
      tuiApiRecoverable: value.tuiApiRecoverable,
    };
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]));
}

function normalizeForFixture(value, context) {
  if (Array.isArray(value)) return value.map((entry) => normalizeForFixture(entry, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeForFixture(entry, context)]));
  }
  if (typeof value === "number") {
    const index = context.ports.indexOf(value);
    return index >= 0 ? `<PORT:${index}>` : value;
  }
  if (typeof value !== "string") return value;
  let text = value.replaceAll(context.stateDir, "<PROJECT_STATE>").replaceAll(context.projectRoot, "<PROJECT_ROOT>");
  for (const [index, port] of context.ports.entries()) {
    text = text.replaceAll(String(port), `<PORT:${index}>`);
  }
  return text.replaceAll(process.env.AIMUX_HOME, "<AIMUX_HOME>").replaceAll(tempRoot, "<TMP>");
}

async function captureThrown(fn) {
  try {
    return { ok: true, value: normalize(await fn()) };
  } catch (error) {
    return { ok: false, error: normalize(error) };
  }
}

async function endpointServer(steps, requests) {
  const queue = [...steps];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: req.method,
      url: req.url,
      headers: {
        accept: req.headers.accept,
        "content-type": req.headers["content-type"],
      },
      body: bodyText ? JSON.parse(bodyText) : null,
    });
    const step = queue.shift() ?? { status: 200, json: { ok: true } };
    if (step.closeAfterResponse) {
      server.close();
    }
    if (step.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    }
    res.statusCode = step.status ?? 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(step.json ?? { ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: address.port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function writeEndpoint(projectRoot, endpoint) {
  const stateDir = getProjectStateDirFor(projectRoot);
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, "metadata-api.json"),
    `${JSON.stringify({
      host: "127.0.0.1",
      port: endpoint.port,
      pid: endpoint.pid ?? 2,
      updatedAt: "2026-06-21T00:00:00.000Z",
    })}\n`,
  );
}

function healthy(projectRoot, pid = 2) {
  return {
    ok: true,
    projectStateDir: getProjectStateDirFor(projectRoot),
    pid,
    serviceInfo: getProjectServiceManifest(),
  };
}

function staleBuild(projectRoot, pid = 2) {
  return {
    ...healthy(projectRoot, pid),
    serviceInfo: { ...getProjectServiceManifest(), buildStamp: "old-build" },
  };
}

async function runScenario(input) {
  const projectRoot = join(tempRoot, input.projectName);
  await mkdir(join(projectRoot, ".git"), { recursive: true });
  const requests = [];
  const coreCalls = [];
  const servers = [];
  let recoveryIndex = 0;
  for (const serverSteps of input.servers ?? []) {
    servers.push(await endpointServer(serverSteps.map((step) => materializeStep(step, projectRoot)), requests));
  }
  if (input.initialEndpoint !== null) {
    await writeEndpoint(projectRoot, { port: servers[input.initialEndpoint ?? 0].port, pid: input.initialPid ?? 2 });
  }
  const host = {
    projectRoot,
    dashboardServiceRecovery: null,
    dashboardCoreCommandRequest: async (command, payload) => {
      coreCalls.push({ command, payload: normalize(payload) });
      if (command === "core.project.ensure" && input.recoveryEndpointIndexes?.length) {
        const serverIndex = input.recoveryEndpointIndexes[Math.min(recoveryIndex, input.recoveryEndpointIndexes.length - 1)];
        recoveryIndex += 1;
        await writeEndpoint(projectRoot, { port: servers[serverIndex].port, pid: input.recoveryPid ?? 2 });
      }
      return { ok: true, command, result: {} };
    },
  };
  if (input.cachedEndpointHealth) {
    host.dashboardProjectServiceEndpointHealth = {
      key: `127.0.0.1:${servers[input.cachedEndpointHealth.serverIndex].port}:${input.cachedEndpointHealth.pid ?? 2}:${getProjectStateDirFor(projectRoot)}`,
      checkedAt: Date.now(),
    };
  }

  const call = () => {
    if (input.api === "postToProjectService") {
      return postToProjectService(host, input.path, input.body ?? {}, input.opts);
    }
    if (input.api === "getFromProjectService") {
      return getFromProjectService(host, input.path, input.opts);
    }
    if (input.api === "resolveCurrentProjectServiceEndpointForDashboard") {
      return resolveCurrentProjectServiceEndpointForDashboard(host, input.timeoutMs);
    }
    if (input.api === "invalidateDashboardProjectServiceEndpointHealth") {
      invalidateDashboardProjectServiceEndpointHealth(host);
      return Promise.resolve(null);
    }
    throw new Error(`unknown api ${input.api}`);
  };
  const result = input.repeat === 2 ? [await captureThrown(call), await captureThrown(call)] : await captureThrown(call);
  const stateDir = getProjectStateDirFor(projectRoot);
  const ports = servers.map((server) => server.port);
  const output = {
    result: normalize(result),
    requests,
    coreCalls,
    endpointHealth: normalize(host.dashboardProjectServiceEndpointHealth ?? null),
    endpointFileExists: await fileExists(join(stateDir, "metadata-api.json")),
  };
  for (const server of servers) {
    await server.close().catch(() => {});
  }
  return normalizeForFixture(output, { projectRoot, stateDir, ports });
}

function materializeStep(step, projectRoot) {
  if (step.json === "healthy") return { ...step, json: healthy(projectRoot, step.pid ?? 2) };
  if (step.json === "stale-build") return { ...step, json: staleBuild(projectRoot, step.pid ?? 2) };
  if (step.json === "other-project") return { ...step, json: { ...healthy("/tmp/other-aimux-project", step.pid ?? 2) } };
  return step;
}

async function fileExists(path) {
  try {
    await import("node:fs/promises").then(({ access }) => access(path));
    return true;
  } catch {
    return false;
  }
}

const scenarios = [
  {
    name: "GET validates endpoint once and reuses health cache",
    input: {
      api: "getFromProjectService",
      projectName: "cache",
      path: "/desktop-state",
      repeat: 2,
      servers: [
        [
          { status: 200, json: "healthy" },
          { status: 200, json: { ok: true, value: 1 } },
          { status: 200, json: { ok: true, value: 2 } },
        ],
      ],
    },
  },
  {
    name: "POST sends JSON body after health verification",
    input: {
      api: "postToProjectService",
      projectName: "post",
      path: "/agents/resume",
      body: { sessionId: "claude-1" },
      servers: [
        [
          { status: 200, json: "healthy" },
          { status: 200, json: { ok: true, resumed: true } },
        ],
      ],
    },
  },
  {
    name: "stale build endpoint is removed and recovered before mutation",
    input: {
      api: "postToProjectService",
      projectName: "stale-build",
      path: "/agents/resume",
      body: { sessionId: "claude-1" },
      servers: [
        [{ status: 200, json: "stale-build" }],
        [
          { status: 200, json: "healthy" },
          { status: 200, json: { ok: true, resumed: true } },
        ],
      ],
      recoveryEndpointIndexes: [1],
    },
  },
  {
    name: "retryable route status restarts project service before retry",
    input: {
      api: "getFromProjectService",
      projectName: "retryable-status",
      path: "/desktop-state",
      servers: [
        [
          { status: 200, json: "healthy" },
          { status: 503, json: { ok: false, error: "starting" } },
        ],
        [
          { status: 200, json: "healthy" },
          { status: 200, json: { ok: true, value: 6 } },
        ],
      ],
      recoveryEndpointIndexes: [1],
    },
  },
  {
    name: "semantic route failure is not marked recoverable",
    input: {
      api: "postToProjectService",
      projectName: "semantic-failure",
      path: "/worktrees/graveyard",
      body: { path: "/repo/.aimux/worktrees/demo" },
      servers: [
        [
          { status: 200, json: "healthy" },
          { status: 500, json: { ok: false, error: "agent is attached" } },
        ],
      ],
    },
  },
  {
    name: "cached endpoint health skips health probe",
    input: {
      api: "getFromProjectService",
      projectName: "cached-skip",
      path: "/desktop-state",
      cachedEndpointHealth: { serverIndex: 0, pid: 2 },
      servers: [[{ status: 200, json: { ok: true, cached: true } }]],
    },
  },
  {
    name: "stream endpoint resolution repairs stale project state dir",
    input: {
      api: "resolveCurrentProjectServiceEndpointForDashboard",
      projectName: "resolve-stale",
      timeoutMs: 500,
      servers: [
        [{ status: 200, json: "other-project" }],
        [{ status: 200, json: "healthy" }],
      ],
      recoveryEndpointIndexes: [1],
    },
  },
  {
    name: "explicit invalidation clears endpoint health cache",
    input: {
      api: "invalidateDashboardProjectServiceEndpointHealth",
      projectName: "invalidate",
      cachedEndpointHealth: { serverIndex: 0, pid: 2 },
      servers: [[]],
    },
  },
];

const cases = [];
try {
  for (const [index, entry] of scenarios.entries()) {
    const input = clone(entry.input);
    cases.push({
      id: `dashboard-control-project-service-request-${String(index + 1).padStart(3, "0")}`,
      name: entry.name,
      source: "src/multiplexer/dashboard-control.ts",
      api: input.api,
      input,
      output: await runScenario(clone(input)),
      inputSha256: hash(input),
    });
  }
} finally {
  if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
  else process.env.AIMUX_HOME = previousAimuxHome;
  await rm(tempRoot, { recursive: true, force: true });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-control.ts",
  generatedBy: "scripts/capture-dashboard-control-project-service-request-contract.mjs",
  description:
    "Dashboard-control project-service request recovery, endpoint health caching, and request shape captured by running TypeScript against isolated loopback servers.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
