#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/persistence-statusline.json", ROOT);
const { persistenceMethods } = await import(new URL("dist/multiplexer/persistence-methods.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function recorder(calls, name, impl = () => undefined) {
  return (...args) => {
    calls.push({ method: name, args: clone(args) });
    return impl(...args);
  };
}

function statuslineHost(input) {
  const calls = [];
  const host = {
    mode: input.mode ?? "project-service",
    sessions: clone(input.sessions ?? [{ id: "codex-1" }]),
    dashboardState: clone(input.dashboardState ?? { screen: "dashboard" }),
    dashboardUiStateStore: { loadSharedState: recorder(calls, "dashboardUiStateStore.loadSharedState") },
    repairManagedTmuxTargets: recorder(calls, "repairManagedTmuxTargets"),
    syncTmuxWindowMetadata: recorder(calls, "syncTmuxWindowMetadata"),
    invalidateDesktopStateSnapshot: recorder(calls, "invalidateDesktopStateSnapshot"),
    refreshDesktopStateSnapshot: recorder(calls, "refreshDesktopStateSnapshot"),
    buildStatuslineSnapshot: recorder(calls, "buildStatuslineSnapshot", () =>
      clone(
        input.snapshot ?? {
          project: "repo",
          dashboardScreen: "dashboard",
          sessions: [],
          teammates: [],
          tasks: { pending: 0, assigned: 0 },
          controlPlane: { daemonAlive: true, projectServiceAlive: true },
          flash: null,
          metadata: {},
          updatedAt: "2026-06-21T00:00:00.000Z",
        },
      ),
    ),
    lastStatuslineSnapshotKey: input.lastStatuslineSnapshotKey ?? null,
    writePrecomputedTmuxStatuslineFiles: recorder(calls, "writePrecomputedTmuxStatuslineFiles"),
    tmuxRuntimeManager: { refreshStatus: recorder(calls, "tmuxRuntimeManager.refreshStatus") },
  };
  if (input.wrapWriteStatuslineFile) {
    host.writeStatuslineFile = (arg) => persistenceMethods.writeStatuslineFile.call(host, arg);
  }
  return { host, calls };
}

function repairHost(input) {
  const calls = [];
  const retargetCalls = [];
  const host = {
    projectRoot: input.projectRoot ?? "/repo",
    sessions: clone(input.sessions ?? [{ id: "codex-1" }]).map((session) => ({
      ...session,
      transport: {
        retarget: (...args) => retargetCalls.push(clone(args)),
      },
    })),
    sessionTmuxTargets: new Map(input.sessionTmuxTargets ?? []),
    tmuxRuntimeManager: {
      listProjectManagedWindows: recorder(calls, "tmuxRuntimeManager.listProjectManagedWindows", () =>
        clone(input.managedWindows ?? []),
      ),
      clearTargetHistory: recorder(calls, "tmuxRuntimeManager.clearTargetHistory"),
    },
  };
  return { host, calls, retargetCalls };
}

function snapshotStatusline(host, calls, returned) {
  return {
    returned: clone(returned),
    lastStatuslineSnapshotKey: clone(host.lastStatuslineSnapshotKey),
    calls,
  };
}

function snapshotRepair(host, calls, retargetCalls, returned) {
  return {
    returned: clone(returned),
    sessionTmuxTargets: [...host.sessionTmuxTargets.entries()],
    calls,
    retargetCalls,
  };
}

function run(input) {
  if (input.api === "writeStatuslineFile") {
    const { host, calls } = statuslineHost(input.host ?? {});
    const returned = persistenceMethods.writeStatuslineFile.call(host, input.arg);
    return snapshotStatusline(host, calls, returned);
  }
  if (input.api === "refreshProjectStatusline") {
    const { host, calls } = statuslineHost({ ...(input.host ?? {}), wrapWriteStatuslineFile: true });
    const returned = persistenceMethods.refreshProjectStatusline.call(host, input.arg);
    return snapshotStatusline(host, calls, returned);
  }
  if (input.api === "repairManagedTmuxTargets") {
    const { host, calls, retargetCalls } = repairHost(input.host ?? {});
    const returned = persistenceMethods.repairManagedTmuxTargets.call(host, input.arg);
    return snapshotRepair(host, calls, retargetCalls, returned);
  }
  throw new Error(`unknown api ${input.api}`);
}

const previousTarget = { sessionName: "aimux-repo", windowId: "@1", windowIndex: 1, windowName: "codex" };
const nextTarget = { sessionName: "aimux-repo", windowId: "@2", windowIndex: 2, windowName: "codex" };

const inputs = [
  {
    name: "writes automatic statusline snapshots without live tmux repair or refresh",
    api: "writeStatuslineFile",
    host: {},
  },
  {
    name: "keeps explicit statusline repair on the forced refresh path",
    api: "refreshProjectStatusline",
    arg: { force: true },
    host: {},
  },
  {
    name: "clears pane history when repair rebinds a session to a new tmux target",
    api: "repairManagedTmuxTargets",
    host: {
      sessionTmuxTargets: [["codex-1", previousTarget]],
      managedWindows: [{ target: nextTarget, metadata: { kind: "agent", sessionId: "codex-1" } }],
    },
  },
  {
    name: "does not clear pane history when repair keeps the same tmux target",
    api: "repairManagedTmuxTargets",
    host: {
      sessionTmuxTargets: [["codex-1", previousTarget]],
      managedWindows: [{ target: previousTarget, metadata: { kind: "agent", sessionId: "codex-1" } }],
    },
  },
];

const cases = inputs.map((input, index) => ({
  id: `multiplexer-persistence-statusline-${String(index + 1).padStart(3, "0")}`,
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
  generatedBy: "scripts/capture-multiplexer-persistence-statusline-contract.mjs",
  description:
    "Persistence statusline write and tmux repair side effects captured by running TypeScript persistenceMethods with recorder hosts.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
