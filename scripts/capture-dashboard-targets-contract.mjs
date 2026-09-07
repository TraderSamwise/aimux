#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/dashboard/targets.json", ROOT);

const { getRuntimeOwnerId, TMUX_DASHBOARD_OWNER_OPTION, TMUX_RUNTIME_OWNER_OPTION } = await import(
  new URL("dist/runtime-owner.js", ROOT)
);
const { getDashboardCommandSpec } = await import(new URL("dist/dashboard/command-spec.js", ROOT));
const { findLiveDashboardTarget, resolveDashboardTarget } = await import(new URL("dist/dashboard/targets.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value) {
  const stamps = new Map();
  let nextStamp = 1;
  return JSON.parse(
    JSON.stringify(value).replace(/[0-9a-f]{16}-[0-9a-f]{64}/g, (stamp) => {
      if (!stamps.has(stamp)) stamps.set(stamp, `<stamp:${nextStamp++}>`);
      return stamps.get(stamp);
    }),
  );
}

function recorder(methods) {
  const calls = [];
  const tmux = {};
  for (const [name, impl] of Object.entries(methods)) {
    tmux[name] = (...args) => {
      calls.push({ method: name, args: normalize(args) });
      return impl(...args);
    };
  }
  return { tmux, calls };
}

function record(cases, name, input, run) {
  const normalizedInput = normalize(input);
  cases.push({
    id: `dashboard-targets-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/dashboard/targets.test.ts",
    api: input.api,
    input: normalizedInput,
    output: normalize(run()),
    inputSha256: hash(normalizedInput),
  });
}

const projectRoot = "/Users/sam/cs/glyde-frontend";
const otherProjectRoot = "/Users/sam/cs/tealstreet-next";
const dashboardBuildStamp = getDashboardCommandSpec(projectRoot).dashboardBuildStamp;
const ownerId = getRuntimeOwnerId();
const dashboardTarget = {
  sessionName: "aimux-glyde-frontend-abc123",
  windowId: "@1",
  windowIndex: 0,
  windowName: "dashboard",
};

const cases = [];

record(cases, "ignores current tmux client session from another project", { api: "findLiveDashboardTarget", projectRoot }, () => {
  const { tmux, calls } = recorder({
    getProjectSession: () => ({ projectRoot, projectId: "glyde", sessionName: "aimux-glyde-frontend-abc123" }),
    getOpenSessionName: () => "aimux-glyde-frontend-abc123",
    isInsideTmux: () => true,
    currentClientSession: () => "aimux-tealstreet-next-def456-client-deadbeef",
    listSessionNames: () => [
      "aimux-glyde-frontend-abc123",
      "aimux-tealstreet-next-def456",
      "aimux-tealstreet-next-def456-client-deadbeef",
    ],
    hasSession: (sessionName) => sessionName === "aimux-glyde-frontend-abc123",
    listWindows: (sessionName) =>
      sessionName === "aimux-glyde-frontend-abc123"
        ? [{ id: "@1", index: 0, name: "dashboard", active: true }]
        : [{ id: "@2", index: 0, name: "dashboard", active: true }],
    isWindowAlive: () => true,
    getWindowOption: (_target, key) => (key === TMUX_DASHBOARD_OWNER_OPTION ? ownerId : dashboardBuildStamp),
    getSessionOption: (sessionName, key) =>
      key === TMUX_RUNTIME_OWNER_OPTION
        ? ownerId
        : key === "@aimux-project-root" && sessionName === "aimux-glyde-frontend-abc123"
          ? projectRoot
          : otherProjectRoot,
    displayMessage: () => "bash",
    captureTarget: () => "",
    killWindow: () => undefined,
  });
  return { result: findLiveDashboardTarget(projectRoot, tmux), calls };
});

record(cases, "replaces other-owner dashboard only after replacement is ready", { api: "resolveDashboardTarget", projectRoot }, () => {
  const replacementTarget = { ...dashboardTarget, windowId: "@2" };
  const { tmux, calls } = recorder({
    getProjectSession: () => ({ projectRoot, projectId: "glyde", sessionName: "aimux-glyde-frontend-abc123" }),
    getOpenSessionName: () => "aimux-glyde-frontend-abc123",
    isInsideTmux: () => false,
    currentClientSession: () => null,
    listSessionNames: () => ["aimux-glyde-frontend-abc123"],
    hasSession: () => true,
    listWindows: () => [{ id: "@1", index: 0, name: "dashboard", active: true }],
    ensureProjectSession: () => ({ projectRoot, projectId: "glyde", sessionName: "aimux-glyde-frontend-abc123" }),
    ensureDashboardWindow: () => dashboardTarget,
    isWindowAlive: () => true,
    getWindowOption: (_target, key) => (key === TMUX_DASHBOARD_OWNER_OPTION ? "other-owner" : dashboardBuildStamp),
    getSessionOption: (_sessionName, key) => (key === TMUX_RUNTIME_OWNER_OPTION ? "other-owner" : projectRoot),
    displayMessage: () => "bash",
    captureTarget: () => "",
    killWindow: () => undefined,
    replaceWindowWhenReady: () => replacementTarget,
    setSessionOption: () => undefined,
    setWindowOption: () => undefined,
  });
  const findResult = findLiveDashboardTarget(projectRoot, tmux);
  const resolveResult = resolveDashboardTarget(projectRoot, tmux);
  return { findResult, resolveResult, calls };
});

record(cases, "backfills host session dashboard build stamp", { api: "resolveDashboardTarget", projectRoot }, () => {
  const { tmux, calls } = recorder({
    getProjectSession: () => ({ projectRoot, projectId: "glyde", sessionName: "aimux-glyde-frontend-abc123" }),
    getOpenSessionName: () => "aimux-glyde-frontend-abc123",
    isInsideTmux: () => false,
    currentClientSession: () => null,
    listSessionNames: () => ["aimux-glyde-frontend-abc123"],
    hasSession: () => true,
    listWindows: () => [{ id: "@1", index: 0, name: "dashboard", active: true }],
    isWindowAlive: () => true,
    getWindowOption: (_target, key) => (key === TMUX_DASHBOARD_OWNER_OPTION ? ownerId : dashboardBuildStamp),
    getSessionOption: (_sessionName, key) => (key === TMUX_RUNTIME_OWNER_OPTION ? ownerId : projectRoot),
    displayMessage: () => "bash",
    captureTarget: () => "",
    killWindow: () => undefined,
    setSessionOption: () => undefined,
  });
  return { result: resolveDashboardTarget(projectRoot, tmux), calls };
});

record(cases, "does not reuse dashboard before input readiness stamp", { api: "findLiveDashboardTarget", projectRoot }, () => {
  const { tmux, calls } = recorder({
    getProjectSession: () => ({ projectRoot, projectId: "glyde", sessionName: "aimux-glyde-frontend-abc123" }),
    getOpenSessionName: () => "aimux-glyde-frontend-abc123",
    isInsideTmux: () => false,
    currentClientSession: () => null,
    listSessionNames: () => ["aimux-glyde-frontend-abc123"],
    hasSession: () => true,
    listWindows: () => [{ id: "@1", index: 0, name: "dashboard", active: true }],
    isWindowAlive: () => true,
    getWindowOption: (_target, key) => {
      if (key === "@aimux-dashboard-build") return dashboardBuildStamp;
      if (key === TMUX_DASHBOARD_OWNER_OPTION) return ownerId;
      if (key === "@aimux-dashboard-ready") return "";
      return null;
    },
    getSessionOption: (_sessionName, key) => (key === TMUX_RUNTIME_OWNER_OPTION ? ownerId : projectRoot),
    displayMessage: () => "bash",
    captureTarget: () => "",
    killWindow: () => undefined,
  });
  return { result: findLiveDashboardTarget(projectRoot, tmux), calls };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-dashboard-targets-contract.mjs",
  source: "src/dashboard/targets.test.ts",
  sources: ["src/dashboard/targets.test.ts", "src/dashboard/targets.ts"],
  subject: "dashboard target resolution",
  description: "Dashboard target discovery/replacement return values and tmux side-effect call logs captured by running TypeScript with mocked tmux.",
  normalizedFields: ["dashboardBuildStamp"],
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
