#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-coherence/report.json", ROOT);

const { buildRuntimeCoherenceReport, renderRuntimeCoherenceReport } = await import(
  new URL("dist/runtime-coherence.js", ROOT)
);
const { getProjectStateDirFor } = await import(new URL("dist/paths.js", ROOT));
const {
  AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
  TMUX_DASHBOARD_OWNER_OPTION,
  TMUX_RUNTIME_CONTRACT_OPTION,
  TMUX_RUNTIME_OWNER_OPTION,
} = await import(new URL("dist/runtime-owner.js", ROOT));

const expectedManifest = {
  apiVersion: 4,
  capabilities: { parsedAgentOutput: true },
  buildStamp: "service-new",
};

const cliLaunch = {
  command: "/opt/aimux/bin/aimux",
  args: [],
  source: "stable-shim",
  currentEntryPath: "/opt/aimux/native/local-current/dist/launcher-bin.js",
  stableShimPath: "/opt/aimux/bin/aimux",
};

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function serviceHealth(projectRoot, pid, serviceInfo = expectedManifest) {
  return { ok: true, pid, projectStateDir: getProjectStateDirFor(projectRoot), serviceInfo };
}

function daemonInfo() {
  return { pid: 9001, port: 43190, startedAt: "then", updatedAt: "now" };
}

function endpoint(port, pid) {
  return { host: "127.0.0.1", port, pid, updatedAt: "2026-06-20T00:00:00.000Z" };
}

function projectState(projectId, projectRoot, pid, extra = {}) {
  return { projectId, projectRoot, pid, startedAt: "then", updatedAt: "now", ...extra };
}

function createTmux(overrides = {}) {
  return {
    isAvailable: () => true,
    getVersion: () => "tmux 3.5a",
    listSessionNames: () => ["aimux-alpha-111", "aimux-alpha-111-client-deadbeef", "aimux-beta-222"],
    isManagedSessionName: (sessionName) => sessionName.startsWith("aimux-"),
    getProjectSession: (projectRoot) => ({
      projectRoot,
      projectId: projectRoot.endsWith("alpha") ? "111" : "222",
      sessionName: projectRoot.endsWith("alpha") ? "aimux-alpha-111" : "aimux-beta-222",
    }),
    getSessionOption: (sessionName, key) => {
      if (key === "@aimux-project-root" && sessionName.startsWith("aimux-alpha-111")) return "/repo/alpha";
      if (key === "@aimux-project-root" && sessionName === "aimux-beta-222") return "/repo/beta";
      if (key === TMUX_RUNTIME_OWNER_OPTION) return "owner-new";
      if (key === TMUX_RUNTIME_CONTRACT_OPTION) return AIMUX_TMUX_RUNTIME_CONTRACT_VERSION;
      return null;
    },
    listWindows: (sessionName) => {
      if (sessionName === "aimux-alpha-111") return [{ id: "@1", index: 0, name: "dashboard", active: true }];
      if (sessionName === "aimux-alpha-111-client-deadbeef") {
        return [{ id: "@1", index: 0, name: "dashboard", active: true }];
      }
      if (sessionName === "aimux-beta-222") return [{ id: "@2", index: 0, name: "dashboard", active: true }];
      return [];
    },
    isWindowAlive: () => true,
    displayMessage: () => "node /current/dist/launcher-bin.js --tmux-dashboard-internal",
    getWindowOption: (target, key) => {
      if (key === "@aimux-dashboard-build") return target.windowId === "@1" ? "dashboard-old" : "dashboard-new";
      if (key === TMUX_DASHBOARD_OWNER_OPTION) return "owner-new";
      return null;
    },
    ...overrides,
  };
}

function baseOptions(overrides = {}) {
  return {
    now: () => new Date("2026-06-20T00:00:00.000Z"),
    loadDaemonInfo: daemonInfo,
    loadDaemonState: () => ({
      projects: {
        alpha: projectState("alpha", "/repo/alpha", 1001),
      },
    }),
    loadMetadataEndpoint: (projectRoot) =>
      projectRoot === "/repo/alpha" ? endpoint(43211, 1001) : endpoint(43212, 1002),
    requestJson: async () => ({ status: 200, json: serviceHealth("/repo/alpha", 1001) }),
    readProcessArgs: () => null,
    listProcessArgs: () => [],
    getAimuxCurrentCliIdentity: () => cliLaunch,
    getDashboardBuildStamp: () => "dashboard-new",
    getProjectServiceManifest: () => expectedManifest,
    getRuntimeOwnerId: () => "owner-new",
    ...overrides,
  };
}

const scenarios = [];
const addScenario = (name, input, options) => scenarios.push({ name, input, options });

addScenario(
  "reports service and dashboard version mismatches across known projects",
  { daemonProjects: ["/repo/alpha"], tmuxSessions: "default" },
  baseOptions({
    tmux: createTmux(),
    requestJson: async (url) => ({
      status: 200,
      json: url.includes("43211")
        ? serviceHealth("/repo/alpha", 1001, { ...expectedManifest, buildStamp: "service-old" })
        : serviceHealth("/repo/beta", 1002),
    }),
  }),
);

addScenario(
  "ignores tmux-only projects owned by another Aimux install",
  { daemonProjects: ["/repo/alpha"], tmuxSessions: ["aimux-alpha-111", "aimux-foreign-333"] },
  baseOptions({
    tmux: createTmux({
      listSessionNames: () => ["aimux-alpha-111", "aimux-foreign-333"],
      getProjectSession: (projectRoot) => ({ projectRoot, projectId: "111", sessionName: "aimux-alpha-111" }),
      getSessionOption: (sessionName, key) => {
        if (key === "@aimux-project-root" && sessionName === "aimux-alpha-111") return "/repo/alpha";
        if (key === "@aimux-project-root" && sessionName === "aimux-foreign-333") return "/repo/foreign";
        if (key === TMUX_RUNTIME_OWNER_OPTION && sessionName === "aimux-foreign-333") return "owner-foreign";
        if (key === TMUX_RUNTIME_OWNER_OPTION) return "owner-new";
        if (key === TMUX_RUNTIME_CONTRACT_OPTION) return AIMUX_TMUX_RUNTIME_CONTRACT_VERSION;
        return null;
      },
      listWindows: (sessionName) => {
        if (sessionName === "aimux-alpha-111") return [{ id: "@1", index: 0, name: "dashboard", active: true }];
        if (sessionName === "aimux-foreign-333") return [{ id: "@3", index: 0, name: "dashboard", active: true }];
        return [];
      },
    }),
    requestJson: async () => ({ status: 200, json: serviceHealth("/repo/alpha", 1001) }),
  }),
);

addScenario(
  "keeps ownerless tmux-only projects in the versions report",
  { daemonProjects: [], tmuxSessions: ["aimux-legacy-333"] },
  baseOptions({
    tmux: createTmux({
      listSessionNames: () => ["aimux-legacy-333"],
      getSessionOption: (sessionName, key) => {
        if (key === "@aimux-project-root" && sessionName === "aimux-legacy-333") return "/repo/legacy";
        if (key === TMUX_RUNTIME_OWNER_OPTION) return null;
        if (key === TMUX_RUNTIME_CONTRACT_OPTION) return AIMUX_TMUX_RUNTIME_CONTRACT_VERSION;
        return null;
      },
      listWindows: () => [{ id: "@3", index: 0, name: "dashboard", active: true }],
    }),
    loadDaemonState: () => ({ projects: {} }),
    requestJson: async () => ({ status: 200, json: serviceHealth("/repo/legacy", 1001) }),
  }),
);

addScenario(
  "keeps unreachable services visible in versions report",
  { daemonProjects: ["/repo/alpha"], serviceError: "connection refused" },
  baseOptions({
    tmux: createTmux({ listSessionNames: () => [] }),
    requestJson: async () => {
      throw new Error("connection refused");
    },
  }),
);

addScenario(
  "renders supervised project-service restart metadata from daemon state",
  { daemonProjects: ["/repo/alpha"], supervisor: "restarted" },
  baseOptions({
    tmux: createTmux({ listSessionNames: () => [] }),
    loadDaemonState: () => ({
      projects: {
        alpha: projectState("alpha", "/repo/alpha", 1001, {
          status: "running",
          restartCount: 2,
          lastRestartAt: "2026-08-10T07:00:02.000Z",
          lastExit: {
            at: "2026-08-10T07:00:00.000Z",
            code: 1,
            signal: null,
            expected: false,
          },
        }),
      },
    }),
    loadMetadataEndpoint: () => ({ ...endpoint(43211, 1001), updatedAt: "2026-08-10T07:00:02.000Z" }),
  }),
);

addScenario(
  "rejects service health for wrong project state directory",
  { daemonProjects: ["/repo/alpha"], healthProjectRoot: "/repo/beta" },
  baseOptions({
    tmux: createTmux({ listSessionNames: () => [] }),
    requestJson: async () => ({ status: 200, json: serviceHealth("/repo/beta", 1001) }),
  }),
);

{
  const requestLog = [];
  let count = 0;
  addScenario(
    "retries slow health probe before marking service unreachable",
    { daemonProjects: ["/repo/alpha"], firstProbe: "timeout", secondProbe: "ok" },
    baseOptions({
      tmux: createTmux({ listSessionNames: () => [] }),
      requestJson: async (url, options) => {
        requestLog.push({ url, options });
        count += 1;
        if (count === 1) throw new Error("request timed out after 1000ms");
        return { status: 200, json: serviceHealth("/repo/alpha", 1001) };
      },
      requestLog,
    }),
  );
}

addScenario(
  "marks dashboards stale when tmux runtime owner differs",
  { daemonProjects: ["/repo/beta"], runtimeOwner: "owner-old" },
  baseOptions({
    tmux: createTmux({
      listSessionNames: () => ["aimux-beta-222"],
      getSessionOption: (sessionName, key) => {
        if (key === "@aimux-project-root" && sessionName === "aimux-beta-222") return "/repo/beta";
        if (key === TMUX_RUNTIME_OWNER_OPTION) return "owner-old";
        if (key === TMUX_RUNTIME_CONTRACT_OPTION) return AIMUX_TMUX_RUNTIME_CONTRACT_VERSION;
        return null;
      },
    }),
    loadDaemonState: () => ({ projects: { beta: projectState("beta", "/repo/beta", 1002) } }),
    loadMetadataEndpoint: () => endpoint(43212, 1002),
    requestJson: async () => ({ status: 200, json: serviceHealth("/repo/beta", 1002) }),
  }),
);

for (const [name, sessions, optionFor] of [
  [
    "reports host tmux runtime contract mismatch as requiring rebuild",
    ["aimux-beta-222"],
    (sessionName, key) => {
      if (key === "@aimux-project-root" && sessionName === "aimux-beta-222") return "/repo/beta";
      if (key === TMUX_RUNTIME_OWNER_OPTION) return "owner-new";
      if (key === TMUX_RUNTIME_CONTRACT_OPTION) return "legacy-contract";
      return null;
    },
  ],
  [
    "reports stale client tmux runtime contracts as requiring rebuild",
    ["aimux-beta-222", "aimux-beta-222-client-deadbeef"],
    (sessionName, key) => {
      if (key === "@aimux-project-root" && sessionName === "aimux-beta-222") return "/repo/beta";
      if (key === TMUX_RUNTIME_OWNER_OPTION) return "owner-new";
      if (key === TMUX_RUNTIME_CONTRACT_OPTION && sessionName === "aimux-beta-222-client-deadbeef")
        return "legacy-contract";
      if (key === TMUX_RUNTIME_CONTRACT_OPTION) return AIMUX_TMUX_RUNTIME_CONTRACT_VERSION;
      return null;
    },
  ],
  [
    "reports missing client tmux runtime contract as requiring rebuild",
    ["aimux-beta-222", "aimux-beta-222-client-aaaaaaaa"],
    (sessionName, key) => {
      if (key === "@aimux-project-root" && sessionName === "aimux-beta-222") return "/repo/beta";
      if (key === TMUX_RUNTIME_OWNER_OPTION) return "owner-new";
      if (key === TMUX_RUNTIME_CONTRACT_OPTION && sessionName === "aimux-beta-222-client-aaaaaaaa") return null;
      if (key === TMUX_RUNTIME_CONTRACT_OPTION) return AIMUX_TMUX_RUNTIME_CONTRACT_VERSION;
      return null;
    },
  ],
  [
    "ignores malformed client-like session suffixes for rebuild checks",
    ["aimux-beta-222", "aimux-beta-222-client-stale"],
    (sessionName, key) => {
      if (key === "@aimux-project-root" && sessionName === "aimux-beta-222") return "/repo/beta";
      if (key === TMUX_RUNTIME_OWNER_OPTION) return "owner-new";
      if (key === TMUX_RUNTIME_CONTRACT_OPTION && sessionName === "aimux-beta-222-client-stale")
        return "legacy-contract";
      if (key === TMUX_RUNTIME_CONTRACT_OPTION) return AIMUX_TMUX_RUNTIME_CONTRACT_VERSION;
      return null;
    },
  ],
]) {
  addScenario(
    name,
    { daemonProjects: ["/repo/beta"], tmuxSessions: sessions },
    baseOptions({
      tmux: createTmux({ listSessionNames: () => sessions, getSessionOption: optionFor }),
      loadDaemonState: () => ({ projects: { beta: projectState("beta", "/repo/beta", 1002) } }),
      loadMetadataEndpoint: () => endpoint(43212, 1002),
      requestJson: async () => ({ status: 200, json: serviceHealth("/repo/beta", 1002) }),
    }),
  );
}

addScenario(
  "ignores tmux client placeholder dashboard windows",
  { daemonProjects: ["/repo/beta"], placeholderWindow: "@3" },
  baseOptions({
    tmux: createTmux({
      listSessionNames: () => ["aimux-beta-222", "aimux-beta-222-client-deadbeef"],
      listWindows: (sessionName) => {
        if (sessionName === "aimux-beta-222") return [{ id: "@2", index: 0, name: "dashboard", active: true }];
        if (sessionName === "aimux-beta-222-client-deadbeef") {
          return [
            { id: "@2", index: 0, name: "dashboard", active: true },
            { id: "@3", index: 1, name: "dashboard", active: false },
          ];
        }
        return [];
      },
      displayMessage: (_format, target) =>
        target === "@3" ? "sh -lc tail -f /dev/null" : "node /current/dist/launcher-bin.js --tmux-dashboard-internal",
      getWindowOption: (target, key) => {
        if (target.windowId === "@3") return null;
        if (key === "@aimux-dashboard-build") return "dashboard-new";
        if (key === TMUX_DASHBOARD_OWNER_OPTION) return "owner-new";
        return null;
      },
    }),
    loadDaemonState: () => ({ projects: { beta: projectState("beta", "/repo/beta", 1002) } }),
    loadMetadataEndpoint: () => endpoint(43212, 1002),
    requestJson: async () => ({ status: 200, json: serviceHealth("/repo/beta", 1002) }),
  }),
);

addScenario(
  "does not require runtime rebuild for daemon-only project without tmux host session",
  { daemonProjects: ["/repo/beta"], tmuxSessions: [] },
  baseOptions({
    tmux: createTmux({ listSessionNames: () => [] }),
    loadDaemonState: () => ({ projects: { beta: projectState("beta", "/repo/beta", 1002) } }),
    loadMetadataEndpoint: () => endpoint(43212, 1002),
    requestJson: async () => ({ status: 200, json: serviceHealth("/repo/beta", 1002) }),
  }),
);

addScenario(
  "reports stale native paths in processes and hook commands",
  { daemonProjects: ["/repo/beta"], staleNativePath: "/opt/aimux/native/local-old/dist/main.js" },
  baseOptions({
    tmux: createTmux({
      listSessionNames: () => ["aimux-beta-222"],
      displayMessage: () => "/opt/aimux/native/local-old/dist/main.js --tmux-dashboard-internal",
    }),
    loadDaemonState: () => ({ projects: { beta: projectState("beta", "/repo/beta", 1002) } }),
    loadMetadataEndpoint: () => endpoint(43212, 1002),
    requestJson: async () => ({ status: 200, json: serviceHealth("/repo/beta", 1002) }),
    readProcessArgs: (pid) =>
      pid === 9001
        ? "/opt/aimux/native/local-current/bin/aimux daemon run"
        : "/opt/aimux/native/local-old/dist/main.js __project-service-internal",
    listProcessArgs: () => [
      {
        pid: 77,
        args: "/Users/sam/.volta/bin/claude --settings command='/opt/aimux/native/local-old/dist/main.js' claude-hook stop --project /repo/alpha",
      },
    ],
  }),
);

const cases = [];
for (const [index, scenario] of scenarios.entries()) {
  const requestLog = scenario.options.requestLog;
  delete scenario.options.requestLog;
  const report = await buildRuntimeCoherenceReport(scenario.options);
  const output = {
    report,
    rendered: renderRuntimeCoherenceReport(report),
    ...(requestLog ? { requestLog } : {}),
  };
  cases.push({
    id: `runtime-coherence-${String(index + 1).padStart(3, "0")}`,
    name: scenario.name,
    source: "src/runtime-coherence.ts",
    api: "buildRuntimeCoherenceReport/renderRuntimeCoherenceReport",
    input: scenario.input,
    output,
    inputSha256: hash(scenario.input),
  });
}

const contract = {
  version: 1,
  source: "src/runtime-coherence.ts",
  generatedBy: "scripts/capture-runtime-coherence-contract.mjs",
  description:
    "Runtime coherence version, restart, tmux contract, dashboard staleness, process path, and rendered-report contracts captured by running TypeScript with mocked runtime dependencies.",
  constants: {
    AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
    expectedManifest,
  },
  cases,
};

await writeContractJson(FIXTURE_PATH, contract);
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
