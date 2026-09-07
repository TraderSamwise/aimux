#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/persistence-reapply.json", ROOT);
const FIXED_NOW = "2026-06-01T00:00:00.000Z";
const RealDate = Date;

globalThis.Date = class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) return new RealDate(FIXED_NOW);
    return new RealDate(...args);
  }

  static now() {
    return new RealDate(FIXED_NOW).getTime();
  }

  static parse(value) {
    return RealDate.parse(value);
  }

  static UTC(...args) {
    return RealDate.UTC(...args);
  }
};

const { DashboardPendingActions } = await import(new URL("dist/dashboard/pending-actions.js", ROOT));
const { persistenceMethods } = await import(new URL("dist/multiplexer/persistence-methods.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function applyAction(pending, action) {
  if (action.target === "session" && action.clear) {
    pending.clearSessionAction(action.id);
    return;
  }
  if (action.target === "service" && action.clear) {
    pending.clearServiceAction(action.id);
    return;
  }
  if (action.target === "worktree" && action.clear) {
    pending.clearWorktreeAction(action.path);
    return;
  }
  if (action.target === "session") pending.setSessionAction(action.id, action.kind, clone(action.opts ?? {}));
  if (action.target === "service") pending.setServiceAction(action.id, action.kind, clone(action.opts ?? {}));
  if (action.target === "worktree") pending.setWorktreeAction(action.path, action.kind, clone(action.opts ?? {}));
}

function hostFor(input) {
  const calls = [];
  const pending = new DashboardPendingActions(() => calls.push({ method: "pendingActions.onChange", args: [] }));
  for (const action of input.beforeActions ?? []) applyAction(pending, action);
  const host = {
    dashboardPendingActions: pending,
    dashboardRawSessionsCache: clone(input.dashboardRawSessionsCache ?? undefined),
    dashboardRawTeammatesCache: clone(input.dashboardRawTeammatesCache ?? undefined),
    dashboardRawServicesCache: clone(input.dashboardRawServicesCache ?? undefined),
    dashboardRawWorktreeGroupsCache: clone(input.dashboardRawWorktreeGroupsCache ?? undefined),
    dashboardSessionsCache: clone(input.dashboardSessionsCache ?? []),
    dashboardTeammatesCache: clone(input.dashboardTeammatesCache ?? []),
    dashboardServicesCache: clone(input.dashboardServicesCache ?? []),
    dashboardWorktreeGroupsCache: clone(input.dashboardWorktreeGroupsCache ?? []),
    dashboardUiStateStore: {
      orderWorktreeGroups: (groups) => {
        calls.push({ method: "dashboardUiStateStore.orderWorktreeGroups", args: clone([groups]) });
        return groups;
      },
    },
  };
  for (const action of input.afterHostActions ?? []) applyAction(pending, action);
  return { host, calls };
}

function snapshot(host, calls) {
  return {
    dashboardSessionsCache: host.dashboardSessionsCache,
    dashboardTeammatesCache: host.dashboardTeammatesCache,
    dashboardServicesCache: host.dashboardServicesCache,
    dashboardWorktreeGroupsCache: host.dashboardWorktreeGroupsCache,
    calls,
  };
}

function run(input) {
  const { host, calls } = hostFor(input.host);
  const returned = persistenceMethods.reapplyDashboardPendingActions.call(host);
  return { returned: clone(returned), ...snapshot(host, calls) };
}

const staleSession = {
  index: 1,
  id: "claude-1",
  command: "claude",
  status: "offline",
  active: false,
  pending: true,
  pendingAction: "stopping",
  pendingStartedAt: "2026-05-09T12:00:00.000Z",
  optimistic: true,
};
const staleTeammate = {
  index: 2,
  id: "teammate-1",
  command: "codex",
  status: "offline",
  active: false,
  team: { teamId: "team-1", parentSessionId: "claude-1", role: "reviewer" },
  pending: true,
  pendingAction: "stopping",
  pendingStartedAt: "2026-05-09T12:00:00.000Z",
  optimistic: true,
};
const staleService = {
  id: "service-1",
  command: "shell",
  args: [],
  status: "offline",
  active: false,
  pending: true,
  pendingAction: "removing",
  pendingStartedAt: "2026-05-09T12:00:00.000Z",
  optimistic: true,
};
const sessionSeed = { index: -1, id: "codex-1", command: "codex", status: "offline", active: false };
const serviceSeed = { id: "service-1", command: "shell", args: [], status: "offline", active: false };
const worktreeSeed = {
  name: "demo",
  branch: "demo",
  path: "/repo/.aimux/worktrees/demo",
  sessions: [],
  services: [],
};

const inputs = [
  {
    name: "does not retain stale session or service pending flags when reapplying pending actions",
    api: "reapplyDashboardPendingActions",
    host: {
      beforeActions: [
        {
          target: "session",
          id: "codex-normal",
          kind: "creating",
          opts: {
            sessionSeed: { index: 9, id: "codex-normal", command: "codex", status: "running", active: false },
          },
        },
      ],
      dashboardSessionsCache: [staleSession],
      dashboardTeammatesCache: [staleTeammate],
      dashboardServicesCache: [staleService],
      dashboardWorktreeGroupsCache: [],
    },
  },
  {
    name: "does not turn synthetic pending rows into rendered rows after clearing pending actions",
    api: "reapplyDashboardPendingActions",
    host: {
      beforeActions: [
        { target: "session", id: sessionSeed.id, kind: "graveyarding", opts: { sessionSeed } },
        { target: "service", id: serviceSeed.id, kind: "removing", opts: { serviceSeed } },
        { target: "worktree", path: worktreeSeed.path, kind: "graveyarding", opts: { worktreeSeed } },
      ],
      afterHostActions: [
        { target: "session", id: sessionSeed.id, clear: true },
        { target: "service", id: serviceSeed.id, clear: true },
        { target: "worktree", path: worktreeSeed.path, clear: true },
      ],
      dashboardRawSessionsCache: [],
      dashboardRawTeammatesCache: [],
      dashboardRawServicesCache: [],
      dashboardRawWorktreeGroupsCache: [],
      dashboardSessionsCache: [],
      dashboardTeammatesCache: [],
      dashboardServicesCache: [],
      dashboardWorktreeGroupsCache: [],
    },
  },
];

const cases = inputs.map((input, index) => ({
  id: `multiplexer-persistence-reapply-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/multiplexer/persistence-methods.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/persistence-methods.test.ts",
  generatedBy: "scripts/capture-multiplexer-persistence-reapply-contract.mjs",
  description:
    "Persistence reapplyDashboardPendingActions raw-cache behavior captured by running TypeScript with DashboardPendingActions.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
