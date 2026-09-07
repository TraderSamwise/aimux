#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/persistence-desktop-projection.json", ROOT);
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

function callRecorder(calls, name, impl = () => undefined) {
  return (...args) => {
    calls.push({ method: name, args: clone(args) });
    return impl(...args);
  };
}

function applyPending(pending, actions) {
  for (const action of actions ?? []) {
    if (action.target === "session") pending.setSessionAction(action.id, action.kind, clone(action.opts ?? {}));
    if (action.target === "service") pending.setServiceAction(action.id, action.kind, clone(action.opts ?? {}));
    if (action.target === "worktree") pending.setWorktreeAction(action.path, action.kind, clone(action.opts ?? {}));
  }
}

function hostFor(input) {
  const calls = [];
  const pending = new DashboardPendingActions(callRecorder(calls, "pendingActions.onChange"));
  applyPending(pending, input.pendingActions);
  const host = {
    desktopStateSnapshot: clone(input.desktopStateSnapshot ?? {}),
    dashboardPendingActions: pending,
    refreshDesktopStateSnapshot: callRecorder(calls, "refreshDesktopStateSnapshot"),
    buildDesktopStateSnapshot: callRecorder(calls, "buildDesktopStateSnapshot", () => clone(input.builtSnapshot ?? {})),
    buildStatuslineSnapshot: callRecorder(calls, "buildStatuslineSnapshot", () => clone(input.statusline ?? {})),
    listDesktopWorktrees: callRecorder(calls, "listDesktopWorktrees", () => clone(input.listDesktopWorktrees ?? [])),
    pendingWorktreeRemovals: new Map(input.pendingWorktreeRemovals ?? []),
  };
  return { host, calls };
}

function run(input) {
  const { host, calls } = hostFor(input.host ?? {});
  if (input.api === "buildDesktopState") {
    const returned = persistenceMethods.buildDesktopState.call(host, input.arg ?? {});
    return { returned, calls };
  }
  if (input.api === "listProjectedDesktopWorktrees") {
    const returned = persistenceMethods.listProjectedDesktopWorktrees.call(host);
    return { returned, calls };
  }
  throw new Error(`unknown api ${input.api}`);
}

const worktreePath = "/repo/.aimux/worktrees/demo";
const session = {
  index: 1,
  id: "claude-1",
  command: "claude",
  label: "claude",
  status: "running",
  active: false,
  worktreePath,
};
const service = {
  id: "service-1",
  command: "shell",
  args: [],
  label: "shell",
  status: "offline",
  active: false,
  worktreePath,
};
const worktree = {
  name: "demo",
  branch: "demo",
  path: worktreePath,
  status: "offline",
  isBare: false,
  sessions: [],
  services: [],
};
const worktreeSeed = {
  name: "demo",
  branch: "demo",
  path: worktreePath,
  createdAt: "2026-05-01T00:00:00.000Z",
  status: "offline",
  isBare: false,
  sessions: [],
  services: [],
};
const baseSnapshot = {
  sessions: [],
  teammates: [],
  services: [],
  worktrees: [],
  worktreeGroups: [],
  operationFailures: [],
  mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
  mainCheckoutPath: "/repo",
};

const inputs = [
  {
    name: "projects in-flight worktree creates into desktop-state snapshots",
    api: "buildDesktopState",
    host: {
      desktopStateSnapshot: baseSnapshot,
      pendingActions: [{ target: "worktree", path: worktreePath, kind: "creating", opts: { worktreeSeed } }],
    },
  },
  {
    name: "can build API desktop state without the statusline snapshot",
    api: "buildDesktopState",
    arg: { includeStatusline: false },
    host: {
      desktopStateSnapshot: baseSnapshot,
    },
  },
  {
    name: "projects in-flight worktree creates into projected worktree lists",
    api: "listProjectedDesktopWorktrees",
    host: {
      listDesktopWorktrees: [],
      pendingActions: [{ target: "worktree", path: worktreePath, kind: "creating", opts: { worktreeSeed } }],
    },
  },
  {
    name: "projects remove worktree pending actions into desktop-state snapshots",
    api: "buildDesktopState",
    host: {
      desktopStateSnapshot: { ...baseSnapshot, worktrees: [worktree], worktreeGroups: [worktree] },
      pendingActions: [{ target: "worktree", path: worktreePath, kind: "removing" }],
    },
  },
  {
    name: "projects session and service pending actions into desktop-state snapshots",
    api: "buildDesktopState",
    host: {
      desktopStateSnapshot: {
        ...baseSnapshot,
        sessions: [session],
        services: [service],
        worktrees: [worktree],
        worktreeGroups: [{ ...worktree, status: "active", sessions: [session], services: [service] }],
      },
      pendingActions: [
        { target: "session", id: session.id, kind: "stopping", opts: { sessionSeed: session } },
        { target: "service", id: service.id, kind: "removing", opts: { serviceSeed: service } },
      ],
    },
  },
  {
    name: "keeps normal pending sessions out of teammate desktop-state payloads",
    api: "buildDesktopState",
    host: {
      desktopStateSnapshot: baseSnapshot,
      pendingActions: [
        {
          target: "session",
          id: "codex-normal",
          kind: "creating",
          opts: { sessionSeed: { index: 0, id: "codex-normal", command: "codex", status: "running", active: false } },
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
              active: false,
              team: { teamId: "team-1", parentSessionId: "claude-parent", role: "reviewer" },
            },
          },
        },
      ],
    },
  },
];

const cases = inputs.map((input, index) => ({
  id: `multiplexer-persistence-desktop-projection-${String(index + 1).padStart(3, "0")}`,
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
  generatedBy: "scripts/capture-multiplexer-persistence-desktop-projection-contract.mjs",
  description:
    "Persistence buildDesktopState and projected worktree pending-action behavior captured by running TypeScript persistenceMethods with DashboardPendingActions.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
