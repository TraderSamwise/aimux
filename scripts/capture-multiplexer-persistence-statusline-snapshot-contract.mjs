#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/persistence-statusline-snapshot.json", ROOT);
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
const { saveMetadataState } = await import(new URL("dist/metadata-store.js", ROOT));
const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { persistenceMethods } = await import(new URL("dist/multiplexer/persistence-methods.js", ROOT));
const { createRuntimeExchangeStore } = await import(new URL("dist/runtime-core/exchange-store.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function applyPending(pending, actions) {
  for (const action of actions ?? []) {
    if (action.target === "session") pending.setSessionAction(action.id, action.kind, clone(action.opts ?? {}));
    if (action.target === "service") pending.setServiceAction(action.id, action.kind, clone(action.opts ?? {}));
    if (action.target === "worktree") pending.setWorktreeAction(action.path, action.kind, clone(action.opts ?? {}));
  }
}

function statuslineHost(input) {
  const pending = new DashboardPendingActions(() => {});
  applyPending(pending, input.pendingActions);
  const host = {
    projectRoot: input.projectRoot,
    desktopStateSnapshot: clone(input.desktopStateSnapshot ?? {}),
    dashboardPendingActions: pending,
    dashboardUiStateStore: {
      orderWorktreeGroups: (groups) => groups,
      orderSessionsForWorktree: (sessions) => sessions,
      orderServicesForWorktree: (services) => services,
    },
    dashboardState: clone(input.dashboardState ?? { screen: "dashboard" }),
    footerFlash: input.footerFlash ?? null,
    buildDesktopStateSnapshot: () => clone(input.builtSnapshot ?? {}),
  };
  return host;
}

async function run(input) {
  const root = await mkdtemp(join(tmpdir(), "aimux-statusline-snapshot-"));
  const aimuxHome = await mkdtemp(join(tmpdir(), "aimux-home-"));
  const previousAimuxHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = aimuxHome;
  try {
    const projectRoot = join(root, "repo");
    await mkdir(projectRoot, { recursive: true });
    await initPaths(projectRoot);
    if (input.metadataState) saveMetadataState(clone(input.metadataState));
    if (input.runtimeExchange) {
      createRuntimeExchangeStore().update((exchange) => ({ ...exchange, ...clone(input.runtimeExchange) }));
    }
    const returned = persistenceMethods.buildStatuslineSnapshot.call(statuslineHost({ ...input.host, projectRoot }));
    return { returned };
  } finally {
    if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousAimuxHome;
    await rm(root, { recursive: true, force: true });
    await rm(aimuxHome, { recursive: true, force: true });
  }
}

const sessionLive = {
  index: 0,
  id: "codex-live",
  command: "codex",
  status: "running",
  active: true,
};
const teammateLive = {
  index: 1,
  id: "codex-teammate",
  command: "codex",
  status: "running",
  active: false,
  team: { teamId: "team-1", parentSessionId: "codex-live", role: "reviewer" },
};
const serviceLive = {
  index: 0,
  id: "svc-live",
  command: "yarn dev",
  status: "running",
  active: false,
};
const baseSnapshot = {
  sessions: [],
  teammates: [],
  services: [],
  worktrees: [],
  worktreeGroups: [],
  operationFailures: [],
  mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
};

const inputs = [
  {
    name: "projects pending teammates into the statusline teammate payload only",
    api: "buildStatuslineSnapshot",
    host: {
      desktopStateSnapshot: baseSnapshot,
      pendingActions: [
        {
          target: "session",
          id: "codex-normal",
          kind: "creating",
          opts: {
            sessionSeed: {
              index: 0,
              id: "codex-normal",
              command: "codex",
              status: "running",
              active: false,
            },
          },
        },
        {
          target: "session",
          id: "codex-teammate",
          kind: "creating",
          opts: {
            sessionSeed: {
              index: 1,
              id: "codex-teammate",
              command: "codex",
              status: "running",
              active: true,
              team: { teamId: "team-1", parentSessionId: "claude-parent", role: "reviewer", label: "review" },
            },
          },
        },
      ],
    },
  },
  {
    name: "carries metadata only for sessions the statusline actually names",
    api: "buildStatuslineSnapshot",
    metadataState: {
      version: 1,
      sessions: {
        "codex-live": { status: { text: "alive" } },
        "svc-live": { status: { text: "serving" } },
        "codex-teammate": { status: { text: "reviewing" } },
        "codex-long-dead": { status: { text: "gone" } },
      },
    },
    host: {
      desktopStateSnapshot: {
        ...baseSnapshot,
        sessions: [sessionLive, teammateLive],
        services: [serviceLive],
      },
    },
  },
  {
    name: "builds statusline agent order from dashboard worktree groups",
    api: "buildStatuslineSnapshot",
    host: {
      desktopStateSnapshot: {
        ...baseSnapshot,
        sessions: [
          { index: 2, id: "agent-c", command: "claude", status: "running", active: true },
          { index: 0, id: "agent-a", command: "claude", status: "running", active: false },
          { index: 1, id: "agent-b", command: "claude", status: "offline", active: false },
        ],
        worktreeGroups: [
          {
            name: "Main Checkout",
            branch: "master",
            status: "active",
            sessions: [
              { id: "agent-a", command: "claude", status: "running", active: false },
              { id: "agent-b", command: "claude", status: "offline", active: false },
              { id: "agent-c", command: "claude", status: "running", active: true },
            ],
            services: [],
          },
        ],
      },
    },
  },
  {
    name: "derives statusline task counts from runtime exchange",
    api: "buildStatuslineSnapshot",
    runtimeExchange: {
      tasks: [
        {
          id: "task-pending",
          description: "Queued",
          prompt: "queued",
          status: "pending",
          assignedBy: "user",
          createdAt: "2026-05-25T00:00:00.000Z",
          updatedAt: "2026-05-25T00:00:00.000Z",
        },
        {
          id: "task-assigned",
          description: "Assigned",
          prompt: "assigned",
          status: "assigned",
          assignedBy: "user",
          assignedTo: "codex-1",
          createdAt: "2026-05-25T00:00:00.000Z",
          updatedAt: "2026-05-25T00:00:00.000Z",
        },
        {
          id: "task-done",
          description: "Done",
          prompt: "done",
          status: "done",
          assignedBy: "user",
          assignedTo: "codex-1",
          createdAt: "2026-05-25T00:00:00.000Z",
          updatedAt: "2026-05-25T00:00:00.000Z",
        },
      ],
    },
    host: {
      desktopStateSnapshot: baseSnapshot,
    },
  },
];

const cases = [];
for (const [index, input] of inputs.entries()) {
  const output = await run(input);
  cases.push({
    id: `multiplexer-persistence-statusline-snapshot-${String(index + 1).padStart(3, "0")}`,
    name: input.name,
    source: "src/multiplexer/persistence-methods.test.ts",
    api: input.api,
    input,
    output,
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/persistence-methods.test.ts",
  generatedBy: "scripts/capture-multiplexer-persistence-statusline-snapshot-contract.mjs",
  description:
    "Persistence buildStatuslineSnapshot projection outputs captured by running TypeScript with isolated metadata and runtime-exchange state.",
  cases,
});
