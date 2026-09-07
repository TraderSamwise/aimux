#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const LIBRARY_FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/library-refresh.json", ROOT);
const PROJECT_FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/project-refresh.json", ROOT);
const TOPOLOGY_FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/topology-refresh.json", ROOT);

const { refreshLibrary } = await import(new URL("dist/multiplexer/library.js", ROOT));
const { refreshProjectObservability } = await import(new URL("dist/multiplexer/project.js", ROOT));
const { refreshTopology } = await import(new URL("dist/multiplexer/topology.js", ROOT));
const { buildProjectTopology } = await import(new URL("dist/project-topology.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function libraryEntry(id = "plan:codex-1") {
  return {
    id,
    kind: "plan",
    title: "Codex plan",
    path: "/repo/.aimux/plans/codex-1.md",
    updatedAt: "2026-06-20T00:00:00.000Z",
    sessionId: "codex-1",
    label: "Codex plan",
    preview: "# Plan",
  };
}

function projectModel(story = []) {
  return {
    summary: {
      agentsRunning: 1,
      agentsWaiting: 0,
      agentsOffline: 0,
      services: 0,
      worktrees: 1,
      openTasks: 0,
      doneTasks: 0,
      unreadNotifications: 0,
    },
    progress: { pending: 0, assigned: 0, in_progress: 0, blocked: 0, done: 0, failed: 0, total: 0 },
    story,
  };
}

function topologyModel(rows = []) {
  return {
    projectName: "aimux",
    health: "active",
    counts: { worktrees: 1, agents: rows.length, services: 0 },
    worktrees: [{ name: "main", branch: "main", health: "active", agents: rows.length, services: 0 }],
    rows,
  };
}

function hostSnapshot(host, fields) {
  const out = {};
  for (const field of fields) out[field] = clone(host[field] ?? null);
  return out;
}

function makeHost(initial, serviceSteps) {
  const calls = [];
  let index = 0;
  return {
    host: {
      ...clone(initial),
      getFromProjectService: async (path) => {
        calls.push({ method: "getFromProjectService", args: [path] });
        const step = serviceSteps[Math.min(index, serviceSteps.length - 1)];
        index += 1;
        if (step.reject) throw new Error(step.reject);
        return clone(step.resolve);
      },
    },
    calls,
  };
}

async function record(cases, name, source, api, input, fields, run) {
  const output = await run();
  cases.push({
    id: `${api.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source,
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

async function simpleRefreshCases({
  cases,
  source,
  api,
  refresh,
  validPayload,
  invalidPayload,
  emptyPayload,
  previousState,
  firstState,
  fields,
}) {
  await record(
    cases,
    "loads model from project service",
    source,
    api,
    { initial: firstState, serviceSteps: [{ resolve: validPayload }] },
    fields,
    async () => {
      const { host, calls } = makeHost(firstState, [{ resolve: validPayload }]);
      const returned = await refresh(host);
      return { returned, host: hostSnapshot(host, fields), calls };
    },
  );

  await record(
    cases,
    "coalesces concurrent refreshes",
    source,
    api,
    { initial: firstState, serviceSteps: [{ resolve: validPayload }], concurrentCalls: 2 },
    fields,
    async () => {
      let resolveRefresh;
      const calls = [];
      const host = {
        ...clone(firstState),
        getFromProjectService: (path) => {
          calls.push({ method: "getFromProjectService", args: [path] });
          return new Promise((resolve) => {
            resolveRefresh = resolve;
          });
        },
      };
      const first = refresh(host);
      const second = refresh(host);
      resolveRefresh(clone(validPayload));
      return { returned: [await first, await second], host: hostSnapshot(host, fields), calls };
    },
  );

  await record(
    cases,
    "initializes empty state on invalid first payload",
    source,
    api,
    { initial: {}, serviceSteps: [{ resolve: invalidPayload }] },
    fields,
    async () => {
      const { host, calls } = makeHost({}, [{ resolve: invalidPayload }]);
      const returned = await refresh(host);
      return { returned, host: hostSnapshot(host, fields), calls };
    },
  );

  await record(
    cases,
    "preserves loaded state on invalid payload",
    source,
    api,
    { initial: previousState, serviceSteps: [{ resolve: invalidPayload }] },
    fields,
    async () => {
      const { host, calls } = makeHost(previousState, [{ resolve: invalidPayload }]);
      const returned = await refresh(host);
      return { returned, host: hostSnapshot(host, fields), calls };
    },
  );

  await record(
    cases,
    "preserves loaded state when service rejects",
    source,
    api,
    { initial: previousState, serviceSteps: [{ reject: "offline" }] },
    fields,
    async () => {
      const { host, calls } = makeHost(previousState, [{ reject: "offline" }]);
      const returned = await refresh(host);
      return { returned, host: hostSnapshot(host, fields), calls };
    },
  );

  await record(
    cases,
    "applies valid empty payload over previous state",
    source,
    api,
    { initial: previousState, serviceSteps: [{ resolve: emptyPayload }] },
    fields,
    async () => {
      const { host, calls } = makeHost(previousState, [{ resolve: emptyPayload }]);
      const returned = await refresh(host);
      return { returned, host: hostSnapshot(host, fields), calls };
    },
  );
}

const libraryCases = [];
await simpleRefreshCases({
  cases: libraryCases,
  source: "src/multiplexer/library.test.ts",
  api: "refreshLibrary",
  refresh: refreshLibrary,
  validPayload: { ok: true, entries: [libraryEntry()] },
  invalidPayload: { ok: true, entries: [{ id: "bad" }] },
  emptyPayload: { ok: true, entries: [] },
  previousState: { libraryEntries: [libraryEntry("plan:keep")], libraryLoaded: true, libraryIndex: 0 },
  firstState: { libraryIndex: -1 },
  fields: ["libraryEntries", "libraryLoaded", "libraryIndex", "libraryPathFlash"],
});

const projectCases = [];
await simpleRefreshCases({
  cases: projectCases,
  source: "src/multiplexer/project.test.ts",
  api: "refreshProjectObservability",
  refresh: refreshProjectObservability,
  validPayload: {
    ok: true,
    project: projectModel([{ id: "notif:1", kind: "notification", title: "Needs input", meta: "needs_input", createdAt: "now" }]),
  },
  invalidPayload: { ok: true, project: { summary: {}, progress: {}, story: [] } },
  emptyPayload: { ok: true, project: projectModel([]) },
  previousState: {
    projectObservability: projectModel([{ id: "task:keep", kind: "task", title: "Keep me", meta: "open", createdAt: "now" }]),
    projectObservabilityLoaded: true,
    projectIndex: 0,
  },
  firstState: { projectIndex: -1 },
  fields: ["projectObservability", "projectObservabilityLoaded", "projectIndex"],
});

const topologyCases = [];
await simpleRefreshCases({
  cases: topologyCases,
  source: "src/multiplexer/topology.test.ts",
  api: "refreshTopology",
  refresh: refreshTopology,
  validPayload: {
    ok: true,
    topology: topologyModel([{ kind: "agent", depth: 1, label: "claude", health: "active", sessionId: "live-1" }]),
  },
  invalidPayload: { ok: true, topology: topologyModel([{ kind: "agent", depth: 1, label: "bad", health: "unknown" }]) },
  emptyPayload: { ok: true, topology: buildProjectTopology({ projectName: "aimux", worktrees: [] }) },
  previousState: {
    topology: topologyModel([{ kind: "agent", depth: 1, label: "codex", health: "active", sessionId: "codex-1" }]),
    topologyLoaded: true,
    topologyIndex: 0,
  },
  firstState: { topologyIndex: -1 },
  fields: ["topology", "topologyLoaded", "topologyIndex"],
});

await writeContractJson(LIBRARY_FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-multiplexer-resource-refresh-contracts.mjs",
  source: "src/multiplexer/library.test.ts",
  sources: ["src/multiplexer/library.test.ts", "src/multiplexer/library.ts"],
  subject: "refreshLibrary",
  description: "Library resource refresh state transitions captured by running TypeScript refreshLibrary with mocked project-service responses.",
  caseCount: libraryCases.length,
  cases: libraryCases,
});
await writeContractJson(PROJECT_FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-multiplexer-resource-refresh-contracts.mjs",
  source: "src/multiplexer/project.test.ts",
  sources: ["src/multiplexer/project.test.ts", "src/multiplexer/project.ts"],
  subject: "refreshProjectObservability",
  description: "Project observability refresh state transitions captured by running TypeScript refreshProjectObservability with mocked project-service responses.",
  caseCount: projectCases.length,
  cases: projectCases,
});
await writeContractJson(TOPOLOGY_FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-multiplexer-resource-refresh-contracts.mjs",
  source: "src/multiplexer/topology.test.ts",
  sources: ["src/multiplexer/topology.test.ts", "src/multiplexer/topology.ts"],
  subject: "refreshTopology",
  description: "Topology refresh state transitions captured by running TypeScript refreshTopology with mocked project-service responses.",
  caseCount: topologyCases.length,
  cases: topologyCases,
});

console.log(`${LIBRARY_FIXTURE_PATH.pathname}: ${libraryCases.length} cases`);
console.log(`${PROJECT_FIXTURE_PATH.pathname}: ${projectCases.length} cases`);
console.log(`${TOPOLOGY_FIXTURE_PATH.pathname}: ${topologyCases.length} cases`);
