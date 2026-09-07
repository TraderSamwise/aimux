#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/dashboard/desktop-state-counts.json", ROOT);
const { filterDashboardVisibleModel, isDashboardSessionOffline } = await import(
  new URL("dist/dashboard/visibility.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function session(overrides) {
  return {
    index: 0,
    id: overrides.id ?? "session",
    command: overrides.command ?? "codex",
    status: overrides.status ?? "running",
    active: overrides.active ?? true,
    ...overrides,
  };
}

function service(overrides) {
  return {
    id: overrides.id ?? "service",
    command: overrides.command ?? "yarn dev",
    args: [],
    status: overrides.status ?? "running",
    active: overrides.active ?? true,
    ...overrides,
  };
}

function group(overrides) {
  return {
    name: overrides.name ?? "main",
    branch: overrides.branch ?? "master",
    status: overrides.status ?? "active",
    sessions: overrides.sessions ?? [],
    services: overrides.services ?? [],
    ...overrides,
  };
}

function run(input) {
  const visible = filterDashboardVisibleModel(input.model);
  return {
    hiddenOfflineAgentCount: input.model.hideOfflineAgents
      ? input.model.sessions.filter((entry) => isDashboardSessionOffline(entry)).length
      : 0,
    sessions: visible.sessions,
    services: visible.services,
    worktreeGroups: visible.worktreeGroups,
  };
}

const live = session({ id: "live", worktreePath: "/repo/.aimux/worktrees/live" });
const rawOffline = session({ id: "raw-offline", status: "offline", worktreePath: "/repo/.aimux/worktrees/dead" });
const semanticOffline = session({
  id: "semantic-offline",
  status: "running",
  worktreePath: "/repo/.aimux/worktrees/dead",
  semantic: { user: { label: "offline" }, presentation: { statusLabel: "offline" } },
});
const pendingOffline = session({
  id: "pending-offline",
  status: "offline",
  pendingAction: "starting",
  worktreePath: "/repo/.aimux/worktrees/pending",
});
const liveService = service({ id: "live-svc", worktreePath: "/repo/.aimux/worktrees/live" });
const deadService = service({ id: "dead-svc", worktreePath: "/repo/.aimux/worktrees/dead" });
const pendingService = service({ id: "pending-svc", worktreePath: "/repo/.aimux/worktrees/pending" });

const inputs = [
  {
    name: "returns zero hidden count and original rows when offline hiding is off",
    model: {
      hideOfflineAgents: false,
      sessions: [rawOffline, semanticOffline],
      services: [deadService],
      worktreeGroups: [group({ name: "dead", path: "/repo/.aimux/worktrees/dead", sessions: [rawOffline], services: [deadService] })],
    },
  },
  {
    name: "counts raw and semantic offline agents while keeping live rows",
    model: {
      hideOfflineAgents: true,
      sessions: [live, rawOffline, semanticOffline],
      services: [liveService, deadService],
      worktreeGroups: [
        group({ name: "live", path: "/repo/.aimux/worktrees/live", sessions: [live], services: [liveService] }),
        group({
          name: "dead",
          path: "/repo/.aimux/worktrees/dead",
          sessions: [rawOffline, semanticOffline],
          services: [deadService],
        }),
      ],
    },
  },
  {
    name: "does not count pending offline agents as hidden",
    model: {
      hideOfflineAgents: true,
      sessions: [pendingOffline],
      services: [pendingService],
      worktreeGroups: [
        group({
          name: "pending",
          branch: "(creating)",
          path: "/repo/.aimux/worktrees/pending",
          pending: true,
          pendingAction: "creating",
          sessions: [pendingOffline],
          services: [pendingService],
        }),
      ],
    },
  },
  {
    name: "keeps operational empty worktrees visible and counts removed sessions",
    model: {
      hideOfflineAgents: true,
      sessions: [rawOffline],
      services: [],
      worktreeGroups: [
        group({
          name: "removing",
          branch: "feature/remove",
          path: "/repo/.aimux/worktrees/remove",
          removing: true,
          sessions: [rawOffline],
          services: [],
        }),
      ],
    },
  },
];

const cases = inputs.map((input, index) => ({
  id: `dashboard-desktop-state-counts-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/multiplexer/dashboard-view-methods.ts",
  api: "renderDashboardHiddenOfflineAgentCount",
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-view-methods.ts",
  sources: [
    "src/dashboard/visibility.ts",
    "src/dashboard/visibility.test.ts",
    "src/multiplexer/dashboard-model.test.ts",
    "src/multiplexer/dashboard-view-methods.ts",
  ],
  generatedBy: "scripts/capture-dashboard-desktop-state-counts-contract.mjs",
  description:
    "Dashboard hidden-offline count and visible row projection captured by running TypeScript dashboard visibility helpers used by renderDashboard.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
