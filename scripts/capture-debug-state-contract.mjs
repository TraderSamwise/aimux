#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/debug-state/report.json", ROOT);
const NOW = "2026-01-01T00:00:00.000Z";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const recordCase = (index, name, input, output) => ({
  id: `debug-state-${String(index + 1).padStart(3, "0")}`,
  name,
  source: "src/debug-state.test.ts",
  input,
  output,
  inputSha256: hash(input),
});

const debugState = await import(new URL("dist/debug-state.js", ROOT));
const topologyStore = await import(new URL("dist/runtime-core/topology-store.js", ROOT));

function makePaths(root) {
  const projectStateDir = join(root, "global");
  const localAimuxDir = join(root, "repo", ".aimux");
  mkdirSync(projectStateDir, { recursive: true });
  mkdirSync(localAimuxDir, { recursive: true });
  return {
    repoRoot: join(root, "repo"),
    projectId: "repo-123",
    projectStateDir,
    localAimuxDir,
    statePath: join(projectStateDir, "state.json"),
    runtimeTopologyPath: join(projectStateDir, "runtime-topology.yaml"),
    runtimeExchangePath: join(projectStateDir, "runtime-exchange.yaml"),
    metadataPath: join(projectStateDir, "metadata.json"),
    notificationContextPath: join(projectStateDir, "notification-context.json"),
    dashboardOperationFailuresPath: join(projectStateDir, "dashboard-operation-failures.json"),
  };
}

function normalize(value, root) {
  return JSON.parse(JSON.stringify(value, (_key, nested) => (typeof nested === "string" ? nested.replaceAll(root, "<root>") : nested)));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function snapshot(paths) {
  return new Map(paths.map((path) => [path, readFileSync(path, "utf8")]));
}

function writeTopology(path, topology) {
  new topologyStore.RuntimeTopologyStore(path).write(topology);
}

function emptyTopology() {
  return topologyStore.emptyRuntimeTopology(NOW);
}

function topologyWithSession(paths, session) {
  return {
    ...emptyTopology(),
    rigs: [{ id: "rig:test", name: "repo", projectRoot: paths.repoRoot, createdAt: NOW, updatedAt: NOW }],
    nodes: [
      {
        id: `agent:${session.id}`,
        rigId: "rig:test",
        logicalId: session.id,
        toolConfigKey: session.toolConfigKey ?? session.tool,
        cwd: session.worktreePath,
        label: session.label,
        createdAt: NOW,
      },
    ],
    sessions: [
      {
        id: session.id,
        nodeId: `agent:${session.id}`,
        status: session.lifecycle === "offline" ? "offline" : "running",
        tool: session.tool,
        command: session.command,
        args: session.args ?? [],
        backendSessionId: session.backendSessionId,
        worktreePath: session.worktreePath,
        label: session.label,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

async function withPaths(label, fn) {
  const root = mkdtempSync(join(tmpdir(), `aimux-debug-state-contract-${label}-`));
  try {
    const paths = makePaths(root);
    return normalize(await fn(paths), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const cases = [];
const add = async (name, scenario, fn) => {
  const input = { scenario };
  cases.push(recordCase(cases.length, name, input, await withPaths(scenario, fn)));
};

await add("joins session evidence without mutating source files", "session-evidence", (paths) => {
  writeTopology(
    paths.runtimeTopologyPath,
    topologyWithSession(paths, {
      id: "codex-a1",
      tool: "codex",
      toolConfigKey: "codex",
      command: "codex",
      args: [],
      lifecycle: "offline",
      backendSessionId: "backend-a1",
      worktreePath: "/repo/worktree-a",
    }),
  );
  writeJson(paths.statePath, { sessions: [], services: [] });
  writeJson(paths.metadataPath, {
    version: 1,
    sessions: {
      "codex-a1": {
        backendSessionId: "backend-a1",
        context: { worktreePath: "/repo/worktree-a", worktreeName: "worktree-a" },
      },
    },
  });
  const before = snapshot([paths.statePath, paths.metadataPath]);
  const report = debugState.buildDebugStateReport({
    target: "backend-a1",
    paths,
    tmuxWindows: [
      {
        target: { sessionName: "aimux-repo", windowId: "@1", windowIndex: 1, windowName: "codex-a1" },
        metadata: {
          kind: "agent",
          sessionId: "codex-a1",
          backendSessionId: "backend-a1",
          command: "codex",
          args: [],
          toolConfigKey: "codex",
          worktreePath: "/repo/worktree-a",
        },
      },
    ],
    worktrees: [],
  });
  return { report, sourceFilesUnchanged: JSON.stringify([...snapshot([...before.keys()])]) === JSON.stringify([...before]) };
});

await add("does not resolve topology-owned identity from stale metadata projection fields", "stale-metadata", (paths) => {
  writeJson(paths.metadataPath, {
    version: 1,
    sessions: {
      "codex-stale": {
        backendSessionId: "backend-stale",
        label: "stale-label",
        context: { worktreePath: "/repo/worktree-a" },
      },
    },
  });
  return {
    backend: debugState.buildDebugStateReport({ target: "backend-stale", paths, tmuxWindows: [], worktrees: [] }),
    label: debugState.buildDebugStateReport({ target: "stale-label", paths, tmuxWindows: [], worktrees: [] }),
  };
});

await add("matches service and worktree sources", "service-worktree", (paths) => {
  writeJson(paths.statePath, {
    sessions: [],
    services: [{ id: "service-1", worktreePath: "/repo/app", cwd: "/repo/app/apps/web", label: "web" }],
  });
  writeJson(paths.metadataPath, { version: 1, sessions: {} });
  return debugState.buildDebugStateReport({
    target: "service-1",
    paths,
    tmuxWindows: [],
    worktrees: [{ name: "app", path: "/repo/app", branch: "app", isBare: false }],
  });
});

await add("reports missing with explicit unavailable live-only sources", "missing", (paths) =>
  debugState.buildDebugStateReport({ target: "missing", paths, tmuxWindows: [], worktrees: [] }),
);

await add("marks ambiguous exact matches instead of guessing", "ambiguous", (paths) => {
  writeTopology(
    paths.runtimeTopologyPath,
    topologyWithSession(paths, { id: "same", tool: "codex", command: "codex", args: [], lifecycle: "offline" }),
  );
  writeJson(paths.statePath, { sessions: [], services: [{ id: "same", worktreePath: "/repo/app" }] });
  return debugState.buildDebugStateReport({ target: "same", paths, tmuxWindows: [], worktrees: [] });
});

await add("resolves targets found only in notifications", "notifications", (paths) => {
  writeTopology(paths.runtimeTopologyPath, emptyTopology());
  writeFileSync(
    paths.runtimeExchangePath,
    [
      "version: 1",
      "generatedAt: '2026-01-01T00:00:00.000Z'",
      "threads:",
      "  - id: notice-thread",
      "    title: Notice",
      "    kind: conversation",
      "    status: open",
      "    createdAt: '2026-01-01T00:00:00.000Z'",
      "    updatedAt: '2026-01-01T00:00:00.000Z'",
      "    createdBy: aimux",
      "    participants: [aimux, codex-a1]",
      "    tags: [notification]",
      "messages:",
      "  - id: notice-1",
      "    threadId: notice-thread",
      "    ts: '2026-01-01T00:00:00.000Z'",
      "    from: aimux",
      "    to: [codex-a1]",
      "    kind: note",
      "    body: Notice",
      "    metadata:",
      "      notificationRecordId: notice-1",
      "      notificationSessionId: codex-a1",
      "      notificationTargetKey: session:codex-a1",
      "tasks: []",
      "handoffs: []",
      "reviews: []",
      "waits: []",
      "inbox: []",
      "planRefs: []",
      "continuityRefs: []",
      "attachmentRefs: []",
      "",
    ].join("\n"),
  );
  return debugState.buildDebugStateReport({ target: "codex-a1", paths, tmuxWindows: [], worktrees: [] });
});

await add("reads worktree graveyard entries from runtime topology", "worktree-graveyard", (paths) => {
  writeTopology(paths.runtimeTopologyPath, {
    ...emptyTopology(),
    rigs: [{ id: "rig:test", name: "repo", projectRoot: paths.repoRoot, createdAt: NOW, updatedAt: NOW }],
    worktreeGraveyard: [
      { id: "graveyard-feature-a", rigId: "rig:test", path: "/repo/feature-a", name: "feature-a", branch: "feature-a", graveyardedAt: NOW },
    ],
  });
  return debugState.buildDebugStateReport({ target: "feature-a", paths, tmuxWindows: [], worktrees: [] });
});

await add("matches topology-only services and worktrees", "topology-only", (paths) => {
  writeTopology(paths.runtimeTopologyPath, {
    ...emptyTopology(),
    rigs: [{ id: "rig:test", name: "repo", projectRoot: paths.repoRoot, createdAt: NOW, updatedAt: NOW }],
    nodes: [{ id: "service:service-web", rigId: "rig:test", logicalId: "service-web", createdAt: NOW }],
    services: [
      {
        id: "service-web",
        rigId: "rig:test",
        nodeId: "service:service-web",
        status: "stopped",
        launchCommandLine: "yarn web",
        label: "web",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    worktrees: [
      {
        id: "worktree-feature-b",
        rigId: "rig:test",
        path: "/repo/feature-b",
        name: "feature-b",
        status: "active",
        branch: "feature-b",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  });
  return {
    service: debugState.buildDebugStateReport({ target: "service-web", paths, tmuxWindows: [], worktrees: [] }),
    worktree: debugState.buildDebugStateReport({ target: "feature-b", paths, tmuxWindows: [], worktrees: [] }),
  };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/debug-state.test.ts",
  generatedBy: "scripts/capture-debug-state-contract.mjs",
  description: "Debug-state target resolution and source projection contracts captured by running TypeScript buildDebugStateReport.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
