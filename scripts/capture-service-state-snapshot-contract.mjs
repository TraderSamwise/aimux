#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/service-state-snapshot.json", ROOT);
const paths = await import(new URL("dist/paths.js", ROOT));
const snapshot = await import(new URL("dist/multiplexer/service-state-snapshot.js", ROOT));
const topology = await import(new URL("dist/runtime-core/topology-services.js", ROOT));
const { getStatePath, initPaths } = paths;
const {
  mergeRuntimeSnapshots,
  mergeServiceSnapshots,
  persistProjectRuntimeSnapshotsBeforeTmuxStop,
  snapshotProjectServiceWindows,
} = snapshot;
const { listTopologyServiceStates, upsertTopologyService } = topology;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const cases = [];
function normalize(value, repoRoot) {
  if (typeof value === "string") return value.split(repoRoot).join("<repo>");
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, repoRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry, repoRoot)]));
  }
  return value;
}
function materialize(value, repoRoot) {
  if (typeof value === "string") return value.split("<repo>").join(repoRoot);
  if (Array.isArray(value)) return value.map((entry) => materialize(entry, repoRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, materialize(entry, repoRoot)]));
  }
  return value;
}
function record(name, api, input, output) {
  cases.push({
    id: `runtime-state-service-snapshot-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/multiplexer/service-state-snapshot.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}
function tokenizedSavedAt(value) {
  const cloned = structuredClone(value);
  if (cloned?.state?.savedAt) cloned.state.savedAt = "<ts:1>";
  return cloned;
}
async function withRepo(callback) {
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-service-state-snapshot-"));
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  try {
    await initPaths(repoRoot);
    return normalize(await callback(repoRoot), repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

record(
  "merges runtime-stop service snapshots as offline services without stale tmux retention",
  "mergeServiceSnapshots",
  {
    existing: {
      savedAt: "2026-05-01T00:00:00.000Z",
      cwd: "/repo",
      sessions: [{ id: "agent-1", tool: "codex", toolConfigKey: "codex", command: "codex", args: [] }],
      services: [
        { id: "stale-service", label: "stale", launchCommandLine: "yarn stale" },
        { id: "service-1", label: "old", launchCommandLine: "yarn dev" },
      ],
    },
    snapshots: [
      {
        id: "service-1",
        label: "web",
        launchCommandLine: "yarn dev",
        cwd: "/repo/apps/web",
        tmuxTarget: { sessionName: "aimux-repo", windowId: "@2", windowIndex: 2, windowName: "web" },
        retained: true,
      },
    ],
    cwd: "/repo",
    savedAt: "2026-05-02T00:00:00.000Z",
  },
  mergeServiceSnapshots(
    {
      savedAt: "2026-05-01T00:00:00.000Z",
      cwd: "/repo",
      sessions: [{ id: "agent-1", tool: "codex", toolConfigKey: "codex", command: "codex", args: [] }],
      services: [
        { id: "stale-service", label: "stale", launchCommandLine: "yarn stale" },
        { id: "service-1", label: "old", launchCommandLine: "yarn dev" },
      ],
    },
    [
      {
        id: "service-1",
        label: "web",
        launchCommandLine: "yarn dev",
        cwd: "/repo/apps/web",
        tmuxTarget: { sessionName: "aimux-repo", windowId: "@2", windowIndex: 2, windowName: "web" },
        retained: true,
      },
    ],
    "/repo",
    "2026-05-02T00:00:00.000Z",
  ),
);

const mergeRuntimeInput = {
  existing: {
    savedAt: "2026-05-01T00:00:00.000Z",
    cwd: "<repo>",
    sessions: [
      {
        id: "old-id",
        tool: "claude",
        toolConfigKey: "claude",
        command: "claude",
        args: [],
        lifecycle: "live",
        backendSessionId: "backend-1",
        tmuxTarget: { sessionName: "aimux-repo", windowId: "@1", windowIndex: 1, windowName: "claude" },
      },
    ],
    services: [],
  },
  snapshots: {
    sessions: [
      {
        id: "new-id",
        tool: "claude",
        toolConfigKey: "claude",
        command: "claude",
        args: ["--resume"],
        lifecycle: "live",
        backendSessionId: "backend-1",
        tmuxTarget: { sessionName: "aimux-repo", windowId: "@2", windowIndex: 2, windowName: "claude" },
      },
    ],
  },
  savedAt: "2026-05-02T00:00:00.000Z",
};
record(
  "does not let runtime-stop agent snapshots mutate topology",
  "mergeRuntimeSnapshots",
  mergeRuntimeInput,
  await withRepo((repoRoot) => ({
    merged: mergeRuntimeSnapshots(
      materialize(mergeRuntimeInput.existing, repoRoot),
      materialize(mergeRuntimeInput.snapshots, repoRoot),
      repoRoot,
      mergeRuntimeInput.savedAt,
    ),
    topologySessions: [],
  })),
);

const persistServiceInput = {
  service: {
    id: "service-1",
    label: "web",
    launchCommandLine: "yarn web",
    worktreePath: "<repo>",
    tmuxTarget: { sessionName: "aimux-repo", windowId: "@2", windowIndex: 2, windowName: "web" },
  },
  metadataCreatedAt: "2026-05-01T00:00:00.000Z",
};
record(
  "demotes observed running services to topology stopped state before tmux stop",
  "persistProjectRuntimeSnapshotsBeforeTmuxStop",
  persistServiceInput,
  await withRepo((repoRoot) => {
    const target = materialize(persistServiceInput.service.tmuxTarget, repoRoot);
    upsertTopologyService(
      materialize(persistServiceInput.service, repoRoot),
      "running",
      { projectRoot: repoRoot },
    );
    const tmux = {
      listProjectManagedWindows: () => [
        {
          target,
          metadata: {
            kind: "service",
            sessionId: "service-1",
            label: "web",
            launchCommandLine: "yarn web",
            worktreePath: repoRoot,
            createdAt: persistServiceInput.metadataCreatedAt,
          },
        },
      ],
      isWindowAlive: () => true,
      displayMessage: () => repoRoot,
    };
    persistProjectRuntimeSnapshotsBeforeTmuxStop(repoRoot, tmux);
    return { stopped: listTopologyServiceStates({ statuses: ["stopped"] }) };
  }),
);

const staleStateInput = {
  state: {
    savedAt: "2026-05-01T00:00:00.000Z",
    cwd: "<repo>",
    services: [{ id: "stale-service", label: "stale", launchCommandLine: "yarn stale" }],
  },
};
record(
  "clears stale compatibility service snapshots when no service windows are observed",
  "persistNoWindows",
  staleStateInput,
  tokenizedSavedAt(await withRepo((repoRoot) => {
    writeFileSync(getStatePath(), JSON.stringify(materialize(staleStateInput.state, repoRoot)));
    const result = persistProjectRuntimeSnapshotsBeforeTmuxStop(repoRoot, {
      listProjectManagedWindows: () => [],
    });
    const state = JSON.parse(readFileSync(getStatePath(), "utf-8"));
    return { result, state };
  })),
);

const missingWorktreeInput = {
  windows: [
    {
      target: { windowId: "@1", windowName: "codex" },
      metadata: {
        kind: "agent",
        sessionId: "codex-1",
        command: "codex",
        args: [],
        worktreePath: "<repo>/.aimux/worktrees/missing",
      },
    },
    {
      target: { windowId: "@2", windowName: "shell" },
      metadata: {
        kind: "service",
        sessionId: "service-1",
        command: "shell",
        args: [],
        worktreePath: "<repo>/.aimux/worktrees/missing",
      },
    },
  ],
};
record(
  "does not snapshot managed windows for missing worktrees",
  "snapshotProjectServiceWindows",
  missingWorktreeInput,
  await withRepo((repoRoot) =>
    snapshotProjectServiceWindows(repoRoot, {
      listProjectManagedWindows: () => materialize(missingWorktreeInput.windows, repoRoot),
      isWindowAlive: () => true,
      displayMessage: () => repoRoot,
    }),
  ),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/service-state-snapshot.test.ts",
  generatedBy: "scripts/capture-service-state-snapshot-contract.mjs",
  description: "Service runtime snapshot merge, persistence, topology demotion, and missing-worktree contracts captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
