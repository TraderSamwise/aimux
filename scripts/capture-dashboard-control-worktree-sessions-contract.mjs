#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-control-worktree-sessions.json", ROOT);

const { updateWorktreeSessions } = await import(new URL("dist/multiplexer/dashboard-control.js", ROOT));

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

function orderByIds(items, ids) {
  if (!Array.isArray(ids)) return items;
  const byId = new Map(items.map((item) => [item.id, item]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)] : []));
}

function runCase(input) {
  const calls = [];
  const host = {
    dashboardState: {
      focusedWorktreePath: input.focusedWorktreePath,
      hideOfflineAgents: input.hideOfflineAgents,
      worktreeSessions: clone(input.initialWorktreeSessions ?? []),
      worktreeEntries: clone(input.initialWorktreeEntries ?? []),
    },
    getDashboardSessions() {
      calls.push({ method: "getDashboardSessions", args: [] });
      return clone(input.sessions);
    },
    getDashboardServices() {
      calls.push({ method: "getDashboardServices", args: [] });
      return clone(input.services);
    },
    dashboardUiStateStore: {
      orderSessionsForWorktree(items, worktreePath) {
        calls.push({ method: "orderSessionsForWorktree", args: [clone(items), worktreePath] });
        return orderByIds(clone(items), input.sessionOrder);
      },
      orderServicesForWorktree(items, worktreePath) {
        calls.push({ method: "orderServicesForWorktree", args: [clone(items), worktreePath] });
        return orderByIds(clone(items), input.serviceOrder);
      },
    },
  };
  updateWorktreeSessions(host);
  return {
    dashboardState: host.dashboardState,
    calls,
  };
}

const cases = [
  {
    name: "main checkout includes non-control sessions and services when offline agents are visible",
    input: {
      focusedWorktreePath: undefined,
      hideOfflineAgents: false,
      sessionOrder: ["offline-main", "live-main", "demoted-scribe"],
      serviceOrder: ["main-svc"],
      sessions: [
        session({ id: "live-main", index: 3, createdAt: "2026-01-03T00:00:00.000Z" }),
        session({ id: "offline-main", index: 2, status: "offline", createdAt: "2026-01-02T00:00:00.000Z" }),
        session({
          id: "worktree-agent",
          worktreePath: "/repo/.aimux/worktrees/a",
          createdAt: "2026-01-04T00:00:00.000Z",
        }),
        session({ id: "scribe-main", scribe: true, createdAt: "2026-01-05T00:00:00.000Z" }),
        session({ id: "control-main", projectControl: true, createdAt: "2026-01-06T00:00:00.000Z" }),
        session({
          id: "demoted-scribe",
          scribe: false,
          team: { teamId: "scribe", parentSessionId: "", role: "scribe" },
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
      services: [
        service({ id: "main-svc", createdAt: "2026-01-07T00:00:00.000Z" }),
        service({
          id: "worktree-svc",
          worktreePath: "/repo/.aimux/worktrees/a",
          createdAt: "2026-01-08T00:00:00.000Z",
        }),
      ],
    },
  },
  {
    name: "focused worktree hides offline sessions but keeps services when a live session remains",
    input: {
      focusedWorktreePath: "/repo/.aimux/worktrees/a",
      hideOfflineAgents: true,
      sessionOrder: ["pending-offline", "live-a"],
      serviceOrder: ["svc-a"],
      sessions: [
        session({ id: "live-a", worktreePath: "/repo/.aimux/worktrees/a", createdAt: "2026-02-01T00:00:00.000Z" }),
        session({
          id: "offline-a",
          status: "offline",
          worktreePath: "/repo/.aimux/worktrees/a",
          createdAt: "2026-02-03T00:00:00.000Z",
        }),
        session({
          id: "pending-offline",
          status: "offline",
          pendingAction: "resuming",
          worktreePath: "/repo/.aimux/worktrees/a",
          createdAt: "2026-02-02T00:00:00.000Z",
        }),
      ],
      services: [service({ id: "svc-a", worktreePath: "/repo/.aimux/worktrees/a" })],
    },
  },
  {
    name: "focused worktree hides services when hide-offline leaves no sessions",
    input: {
      focusedWorktreePath: "/repo/.aimux/worktrees/empty",
      hideOfflineAgents: true,
      sessions: [
        session({
          id: "offline-empty",
          status: "exited",
          worktreePath: "/repo/.aimux/worktrees/empty",
          createdAt: "2026-03-01T00:00:00.000Z",
        }),
      ],
      services: [service({ id: "svc-empty", worktreePath: "/repo/.aimux/worktrees/empty" })],
    },
  },
  {
    name: "null worktree paths are treated as main checkout entries",
    input: {
      focusedWorktreePath: undefined,
      hideOfflineAgents: false,
      sessions: [session({ id: "null-path", worktreePath: null, tmuxWindowIndex: 8 })],
      services: [service({ id: "null-service", worktreePath: null, tmuxWindowIndex: 7 })],
    },
  },
];

const captured = cases.map((entry, index) => ({
  id: `dashboard-control-worktree-sessions-${String(index + 1).padStart(3, "0")}`,
  name: entry.name,
  source: "src/multiplexer/dashboard-control.ts",
  api: "updateWorktreeSessions",
  input: entry.input,
  output: runCase(entry.input),
  inputSha256: hash(entry.input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-control.ts",
  generatedBy: "scripts/capture-dashboard-control-worktree-sessions-contract.mjs",
  description: "Dashboard control focused worktree session/service list updates captured by running TypeScript.",
  cases: captured,
});
console.log(`${FIXTURE_PATH.pathname}: ${captured.length} cases`);
