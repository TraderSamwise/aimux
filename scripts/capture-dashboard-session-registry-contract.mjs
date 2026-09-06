#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/dashboard/session-registry.json", ROOT);
const { buildDashboardSessions, selectDashboardTeammates } = await import(
  new URL("dist/dashboard/session-registry.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function callbacks(input) {
  return {
    getSessionLabel: (sessionId) => input.labels?.[sessionId],
    getSessionHeadline: (sessionId) => input.headlines?.[sessionId],
    getSessionTaskDescription: (sessionId) => input.taskDescriptions?.[sessionId],
    getSessionRole: (sessionId) => input.roles?.[sessionId],
    getSessionContext: (sessionId) => input.contexts?.[sessionId],
    getSessionDerived: (sessionId) => input.derived?.[sessionId],
  };
}

function runSessionRegistry(input) {
  if (input.api === "buildDashboardSessions") {
    return buildDashboardSessions({
      sessions: input.sessions,
      activeIndex: input.activeIndex,
      offlineSessions: input.offlineSessions ?? [],
      hiddenWorktreePaths: new Set(input.hiddenWorktreePaths ?? []),
      mainRepoPath: input.mainRepoPath,
      includeTeammates: input.includeTeammates,
      ...callbacks(input),
    });
  }
  if (input.api === "selectDashboardTeammates") {
    return selectDashboardTeammates(input.sessions, input.parentSession);
  }
  throw new Error(`unknown session-registry api ${input.api}`);
}

const cases = [
  {
    name: "dedupes duplicate local sessions by session id and backend session id",
    api: "buildDashboardSessions",
    sessions: [
      { id: "claude-abc123", command: "claude", backendSessionId: "backend-1", status: "running" },
      { id: "claude-abc123", command: "claude", backendSessionId: "backend-1", status: "running" },
    ],
    activeIndex: 0,
    offlineSessions: [],
    labels: { "claude-abc123": "claude" },
    roles: { "claude-abc123": "coder" },
  },
  {
    name: "hides sessions attached to graveyarded worktrees",
    api: "buildDashboardSessions",
    sessions: [
      { id: "claude-hidden", command: "claude", status: "running", worktreePath: "/repo/.aimux/worktrees/hidden" },
      { id: "claude-visible", command: "claude", status: "running", worktreePath: "/repo/.aimux/worktrees/visible" },
    ],
    activeIndex: 0,
    offlineSessions: [
      {
        id: "codex-hidden",
        tool: "codex",
        toolConfigKey: "codex",
        command: "codex",
        args: [],
        worktreePath: "/repo/.aimux/worktrees/hidden",
      },
    ],
    hiddenWorktreePaths: ["/repo/.aimux/worktrees/hidden"],
  },
  {
    name: "hides teammate sessions by default across local and offline sources",
    api: "buildDashboardSessions",
    sessions: [
      { id: "claude-parent", command: "claude", status: "running" },
      {
        id: "claude-teammate-local",
        command: "claude",
        status: "running",
        team: { teamId: "team-1", parentSessionId: "claude-parent", role: "reviewer" },
      },
      {
        id: "codex-teammate-pending",
        command: "codex",
        status: "waiting",
        pendingAction: "creating",
        optimistic: true,
        team: { teamId: "team-1", parentSessionId: "claude-parent", role: "coder" },
      },
    ],
    activeIndex: 0,
    offlineSessions: [
      {
        id: "codex-teammate-offline",
        tool: "codex",
        toolConfigKey: "codex",
        command: "codex",
        args: [],
        team: { teamId: "team-1", parentSessionId: "claude-parent", role: "coder" },
      },
    ],
  },
  {
    name: "can include teammate sessions and preserves teammate metadata",
    api: "buildDashboardSessions",
    sessions: [
      {
        id: "claude-teammate-local",
        command: "claude",
        status: "running",
        team: { teamId: "team-1", parentSessionId: "claude-parent", role: "reviewer", order: 2 },
      },
    ],
    activeIndex: 0,
    offlineSessions: [],
    includeTeammates: true,
  },
  {
    name: "returns only the selected parent teammates in stable team order",
    api: "selectDashboardTeammates",
    sessions: [
      { index: 0, id: "parent-a", command: "claude", status: "running", active: true },
      {
        index: 1,
        id: "child-late",
        command: "codex",
        status: "running",
        active: false,
        createdAt: "2026-05-01T00:00:10.000Z",
        team: { teamId: "team-a", parentSessionId: "parent-a", role: "reviewer" },
      },
      {
        index: 2,
        id: "child-first",
        command: "claude",
        status: "offline",
        active: false,
        createdAt: "2026-05-01T00:00:20.000Z",
        team: { teamId: "team-a", parentSessionId: "parent-a", role: "coder", order: 1 },
      },
      {
        index: 3,
        id: "child-early",
        command: "claude",
        status: "running",
        active: false,
        createdAt: "2026-05-01T00:00:01.000Z",
        team: { teamId: "team-a", parentSessionId: "parent-a", role: "explorer" },
      },
      {
        index: 4,
        id: "other-child",
        command: "codex",
        status: "running",
        active: false,
        team: { teamId: "team-b", parentSessionId: "parent-b", role: "coder" },
      },
    ],
    parentSession: { index: 0, id: "parent-a", command: "claude", status: "running", active: true },
  },
  {
    name: "does not expose nested teammate teams",
    api: "selectDashboardTeammates",
    sessions: [
      {
        index: 0,
        id: "teammate-parent",
        command: "claude",
        status: "running",
        active: true,
        team: { teamId: "team-a", parentSessionId: "root", role: "coder" },
      },
      {
        index: 1,
        id: "nested-child",
        command: "codex",
        status: "running",
        active: false,
        team: { teamId: "team-b", parentSessionId: "teammate-parent", role: "reviewer" },
      },
    ],
    parentSession: {
      index: 0,
      id: "teammate-parent",
      command: "claude",
      status: "running",
      active: true,
      team: { teamId: "team-a", parentSessionId: "root", role: "coder" },
    },
  },
];

const contractCases = cases.map((input, index) => ({
  id: `dashboard-session-registry-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/dashboard/session-registry.test.ts",
  input,
  output: runSessionRegistry(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/dashboard/session-registry.test.ts",
  sources: ["src/dashboard/session-registry.test.ts", "src/dashboard/session-registry.ts", "src/team.ts"],
  generatedBy: "scripts/capture-dashboard-session-registry-contract.mjs",
  description:
    "Dashboard session registry dedupe, hidden-worktree filtering, teammate inclusion, and teammate ordering captured by running TypeScript helpers.",
  cases: contractCases,
});

console.log(`${FIXTURE_PATH.pathname}: ${contractCases.length} cases`);
