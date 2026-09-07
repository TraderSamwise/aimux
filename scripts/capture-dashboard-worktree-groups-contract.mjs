#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-worktree-groups.json", ROOT);

const { buildDashboardWorktreeGroups, composeDashboardWorktreeGroups } = await import(
  new URL("dist/multiplexer/dashboard-model.js", ROOT)
);

const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function session(overrides) {
  return {
    index: overrides.index ?? 0,
    id: overrides.id,
    command: overrides.command ?? "codex",
    status: overrides.status ?? "running",
    active: overrides.active ?? false,
    ...overrides,
  };
}

function service(overrides) {
  return {
    id: overrides.id,
    command: overrides.command ?? "shell",
    args: overrides.args ?? [],
    status: overrides.status ?? "running",
    active: overrides.active ?? false,
    ...overrides,
  };
}

function worktree(overrides) {
  return {
    name: overrides.name,
    path: overrides.path,
    branch: overrides.branch ?? overrides.name,
    isBare: overrides.isBare ?? false,
    ...overrides,
  };
}

function group(overrides) {
  return {
    name: overrides.name,
    branch: overrides.branch ?? overrides.name,
    path: overrides.path,
    status: overrides.status ?? "offline",
    sessions: overrides.sessions ?? [],
    services: overrides.services ?? [],
    ...overrides,
  };
}

function runCase(input) {
  if (input.api === "composeDashboardWorktreeGroups") {
    return composeDashboardWorktreeGroups(clone(input.worktreeGroups), clone(input.sessions), clone(input.services));
  }
  return buildDashboardWorktreeGroups(
    {},
    clone(input.sessions),
    clone(input.services),
    clone(input.worktrees),
    input.mainRepoPath,
  );
}

const cases = [
  {
    name: "main checkout stays first and project-control scribe is excluded",
    input: {
      api: "buildDashboardWorktreeGroups",
      mainRepoPath: "/repo",
      sessions: [
        session({ id: "main-agent", index: 0 }),
        session({ id: "scribe-agent", index: 1, command: "claude", scribe: true }),
        session({
          id: "demoted-scribe",
          index: 2,
          command: "claude",
          scribe: false,
          team: { teamId: "scribe", parentSessionId: "", role: "scribe" },
        }),
      ],
      services: [],
      worktrees: [
        worktree({ name: "Main Checkout", path: "/repo", branch: "master", createdAt: "2026-04-01T00:00:00.000Z" }),
        worktree({
          name: "feature-a",
          path: "/repo/.aimux/worktrees/feature-a",
          branch: "feature-a",
          createdAt: "2026-04-03T00:00:00.000Z",
        }),
      ],
    },
  },
  {
    name: "secondary worktrees sort by newest createdAt after main checkout",
    input: {
      api: "buildDashboardWorktreeGroups",
      mainRepoPath: "/repo",
      sessions: [],
      services: [],
      worktrees: [
        worktree({ name: "older", path: "/repo/.aimux/worktrees/older", branch: "older", createdAt: "2026-01-01T00:00:00.000Z" }),
        worktree({ name: "newer", path: "/repo/.aimux/worktrees/newer", branch: "newer", createdAt: "2026-02-01T00:00:00.000Z" }),
        worktree({ name: "bare", path: "/repo/.bare", branch: "bare", isBare: true, createdAt: "2026-03-01T00:00:00.000Z" }),
      ],
    },
  },
  {
    name: "services and sessions are grouped by matching worktree path",
    input: {
      api: "buildDashboardWorktreeGroups",
      mainRepoPath: "/repo",
      sessions: [
        session({ id: "main", createdAt: "2026-01-01T00:00:00.000Z" }),
        session({ id: "demo", worktreePath: "/repo/.aimux/worktrees/demo", createdAt: "2026-01-03T00:00:00.000Z" }),
      ],
      services: [
        service({ id: "main-svc", createdAt: "2026-01-02T00:00:00.000Z" }),
        service({ id: "demo-svc", worktreePath: "/repo/.aimux/worktrees/demo", createdAt: "2026-01-04T00:00:00.000Z" }),
      ],
      worktrees: [worktree({ name: "demo", path: "/repo/.aimux/worktrees/demo", branch: "demo" })],
    },
  },
  {
    name: "worktree operation failure and pending flags pass through",
    input: {
      api: "buildDashboardWorktreeGroups",
      mainRepoPath: "/repo",
      sessions: [],
      services: [],
      worktrees: [
        worktree({
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          branch: "(failed)",
          pending: true,
          removing: true,
          pendingAction: "removing",
          operationFailure: {
            id: "failure-1",
            targetKind: "worktree",
            operation: "create",
            title: "Failed to create worktree",
            message: "branch already exists",
            worktreePath: "/repo/.aimux/worktrees/demo",
            worktreeName: "demo",
            createdAt: "2026-05-01T00:00:00.000Z",
          },
        }),
      ],
    },
  },
  {
    name: "compose places optimistic creating sessions into their worktree group",
    input: {
      api: "composeDashboardWorktreeGroups",
      worktreeGroups: [
        group({ name: "Main Checkout", branch: "master" }),
        group({ name: "demo", path: "/repo/.aimux/worktrees/demo" }),
      ],
      sessions: [
        session({
          id: "claude-new",
          index: -1,
          command: "claude",
          label: "claude",
          status: "waiting",
          worktreePath: "/repo/.aimux/worktrees/demo",
          pendingAction: "creating",
          optimistic: true,
        }),
      ],
      services: [],
    },
  },
  {
    name: "compose excludes project-control sessions while preserving teammate workers",
    input: {
      api: "composeDashboardWorktreeGroups",
      worktreeGroups: [group({ name: "demo", path: "/repo/.aimux/worktrees/demo" })],
      sessions: [
        session({ id: "overseer", worktreePath: "/repo/.aimux/worktrees/demo", overseer: true }),
        session({ id: "scribe", worktreePath: "/repo/.aimux/worktrees/demo", team: { teamId: "scribe", parentSessionId: "", role: "scribe" } }),
        session({ id: "worker", worktreePath: "/repo/.aimux/worktrees/demo", team: { teamId: "team", parentSessionId: "parent", role: "coder" } }),
      ],
      services: [],
    },
  },
  {
    name: "entries inside a group sort by createdAt then tmux index fallback",
    input: {
      api: "composeDashboardWorktreeGroups",
      worktreeGroups: [group({ name: "demo", path: "/repo/.aimux/worktrees/demo" })],
      sessions: [
        session({ id: "older", worktreePath: "/repo/.aimux/worktrees/demo", createdAt: "2026-01-01T00:00:00.000Z" }),
        session({ id: "newer", worktreePath: "/repo/.aimux/worktrees/demo", createdAt: "2026-01-02T00:00:00.000Z" }),
        session({ id: "fallback-index", index: 7, worktreePath: "/repo/.aimux/worktrees/demo" }),
      ],
      services: [
        service({ id: "svc-low", worktreePath: "/repo/.aimux/worktrees/demo", tmuxWindowIndex: 2 }),
        service({ id: "svc-high", worktreePath: "/repo/.aimux/worktrees/demo", tmuxWindowIndex: 8 }),
      ],
    },
  },
];

const outputCases = cases.map((entry, index) => ({
  id: `dashboard-worktree-groups-${String(index + 1).padStart(3, "0")}`,
  name: entry.name,
  source: "src/multiplexer/dashboard-model.ts",
  api: entry.input.api,
  input: entry.input,
  output: runCase(entry.input),
  inputSha256: hash(entry.input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-model.ts",
  generatedBy: "scripts/capture-dashboard-worktree-groups-contract.mjs",
  description:
    "Dashboard worktree grouping, project-control filtering, worktree/service/session placement, and created-order sorting captured by running TypeScript dashboard-model helpers.",
  cases: outputCases,
});

console.log(`${FIXTURE_PATH.pathname}: ${outputCases.length} cases`);
