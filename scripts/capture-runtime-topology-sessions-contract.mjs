#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-topology/sessions.json", ROOT);
const NOW = "2026-05-25T00:00:00.000Z";
const LATER = "2026-05-26T00:00:00.000Z";
const LATEST = "2026-05-27T00:00:00.000Z";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const recordCase = (name, api, input, output) => ({
  id: `runtime-topology-sessions-${String(cases.length + 1).padStart(3, "0")}`,
  name,
  source: "src/runtime-core/topology-sessions.test.ts",
  api,
  input,
  output,
  inputSha256: hash(input),
});

const paths = await import(new URL("dist/paths.js", ROOT));
const storeModule = await import(new URL("dist/runtime-core/topology-store.js", ROOT));
const sessions = await import(new URL("dist/runtime-core/topology-sessions.js", ROOT));
const services = await import(new URL("dist/runtime-core/topology-services.js", ROOT));

function normalize(value, roots) {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      let text = nested;
      for (const [label, root] of Object.entries(roots)) text = text.replaceAll(root, `<${label}>`);
      return text;
    }),
  );
}

async function withProject(fn) {
  const aimuxHome = mkdtempSync(join(tmpdir(), "aimux-topology-sessions-home-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-topology-sessions-"));
  const previousAimuxHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = aimuxHome;
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  await paths.initPaths(repoRoot);
  const topologyPath = join(repoRoot, ".aimux", "runtime-topology.yaml");
  const store = storeModule.createRuntimeTopologyStore(topologyPath);
  try {
    return normalize(await fn({ repoRoot, topologyPath, store }), { repo: repoRoot, aimuxHome });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(aimuxHome, { recursive: true, force: true });
    if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousAimuxHome;
  }
}

const liveTarget = { sessionName: "aimux-repo", windowId: "@1", windowIndex: 1, windowName: "codex" };
const serviceTarget = { sessionName: "aimux-repo", windowId: "@2", windowIndex: 2, windowName: "web" };
const baseSession = (id = "codex-1", tool = "codex") => ({ id, tool, toolConfigKey: tool, command: tool, args: [] });
const ids = (items) => items.map((item) => item.id);
const state = (topology, index = 0) => sessions.topologySessionToSessionState(topology.sessions[index], topology);
const clone = (value) => JSON.parse(JSON.stringify(value));

async function addCase(name, api, makeInput, run) {
  const output = await withProject(async (ctx) => run(ctx, makeInput(ctx.repoRoot)));
  cases.push(recordCase(name, api, makeInput("<repo>"), output));
}

const cases = [];

await addCase(
  "drops tmux bindings when sessions move to graveyard or offline",
  "move-resurrect",
  (repoRoot) => ({ session: { ...baseSession(), tmuxTarget: liveTarget, worktreePath: repoRoot } }),
  ({ store, repoRoot }, input) => {
    sessions.upsertTopologySession(input.session, "running", { store, projectRoot: repoRoot, now: NOW });
    const initialBindingCount = store.read().bindings.length;
    const moved = sessions.moveTopologySessionToGraveyard("codex-1", { store, now: LATER });
    const bindingsAfterMove = clone(store.read().bindings);
    const restored = sessions.resurrectTopologySession("codex-1", { store, now: LATEST });
    return { initialBindingCount, moved, bindingsAfterMove, restored, bindingsAfterRestore: store.read().bindings };
  },
);

await addCase(
  "records a graveyard reason and clears it on resurrection",
  "graveyard-reason",
  () => ({ session: baseSession() }),
  ({ store, repoRoot }, input) => {
    sessions.upsertTopologySession(input.session, "running", { store, projectRoot: repoRoot, now: NOW });
    const moved = sessions.moveTopologySessionToGraveyard("codex-1", { store, now: LATER, reason: "worktree missing" });
    const afterMove = clone(store.read().sessions[0]);
    const restored = sessions.resurrectTopologySession("codex-1", { store, now: LATEST });
    return { moved, afterMove, restored, afterRestore: store.read().sessions[0] };
  },
);

await addCase(
  "moves sessions to graveyard in the requested project store",
  "project-root-graveyard",
  () => ({ session: { ...baseSession("codex-other"), lifecycle: "offline" } }),
  async ({ repoRoot }, input) => {
    const otherRoot = mkdtempSync(join(tmpdir(), "aimux-topology-other-project-"));
    mkdirSync(join(otherRoot, ".git"), { recursive: true });
    await paths.initPaths(otherRoot);
    try {
      sessions.upsertTopologySession(input.session, "offline", { projectRoot: otherRoot, now: NOW });
      const beforeOther = sessions.listTopologySessionStates({ projectRoot: otherRoot, statuses: ["offline"] });
      const beforeDefault = sessions.listTopologySessionStates({ projectRoot: repoRoot }).map((entry) => entry.id);
      const moved = sessions.moveTopologySessionToGraveyard("codex-other", { projectRoot: otherRoot, now: LATER });
      const afterOffline = sessions.listTopologySessionStates({ projectRoot: otherRoot, statuses: ["offline"] });
      const afterGraveyard = sessions.listTopologySessionStates({ projectRoot: otherRoot, statuses: ["graveyard"] });
      return normalize({ beforeOther, beforeDefault, moved, afterOffline, afterGraveyard }, { other: otherRoot });
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  },
);

await addCase(
  "removes tmux bindings when an explicit status makes a session non-live",
  "upsert-offline-clears-binding",
  (repoRoot) => ({ session: { ...baseSession(), tmuxTarget: liveTarget, worktreePath: repoRoot } }),
  ({ store, repoRoot }, input) => {
    sessions.upsertTopologySession(input.session, "running", { store, projectRoot: repoRoot, now: NOW });
    const initialBindingCount = store.read().bindings.length;
    sessions.upsertTopologySession(input.session, "offline", { store, projectRoot: repoRoot, now: LATER });
    return { initialBindingCount, bindings: store.read().bindings, state: state(store.read()) };
  },
);

await addCase(
  "persists restore blockers only for offline sessions",
  "restore-blockers",
  () => ({
    session: {
      ...baseSession("claude-crashed", "claude"),
      lifecycle: "offline",
      backendSessionId: "backend-1",
      restoreBlockedReason: "agent exited during startup",
    },
  }),
  ({ store, repoRoot }, input) => {
    sessions.upsertTopologySession(input.session, "offline", { store, projectRoot: repoRoot, now: NOW });
    const offline = state(store.read());
    sessions.upsertTopologySession(input.session, "running", { store, projectRoot: repoRoot, now: LATER });
    const running = state(store.read());
    return { offline, running };
  },
);

await addCase(
  "does not mint graveyard sessions from caller-provided seeds",
  "move-missing",
  () => ({ sessionId: "missing-agent" }),
  ({ store }, input) => ({ moved: sessions.moveTopologySessionToGraveyard(input.sessionId, { store, now: NOW }), sessions: store.read().sessions }),
);

await addCase(
  "records graveyardedAt when a session moves to graveyard",
  "graveyarded-at",
  () => ({ session: baseSession() }),
  ({ store, repoRoot }, input) => {
    sessions.upsertTopologySession(input.session, "offline", { store, projectRoot: repoRoot, now: NOW });
    const moved = sessions.moveTopologySessionToGraveyard("codex-1", { store, now: LATER });
    return { moved, stored: store.read().sessions[0] };
  },
);

await addCase(
  "keeps the original graveyardedAt while a session remains in graveyard",
  "graveyarded-at-stable",
  () => ({ session: baseSession() }),
  ({ store, repoRoot }, input) => {
    sessions.upsertTopologySession(input.session, "offline", { store, projectRoot: repoRoot, now: NOW });
    sessions.moveTopologySessionToGraveyard("codex-1", { store, now: LATER });
    sessions.moveTopologySessionToGraveyard("codex-1", { store, now: LATEST });
    return { stored: store.read().sessions[0] };
  },
);

await addCase(
  "clears graveyardedAt when a session is resurrected",
  "resurrect-clears-graveyarded-at",
  () => ({ session: baseSession() }),
  ({ store, repoRoot }, input) => {
    sessions.upsertTopologySession(input.session, "offline", { store, projectRoot: repoRoot, now: NOW });
    sessions.moveTopologySessionToGraveyard("codex-1", { store, now: LATER });
    const restored = sessions.resurrectTopologySession("codex-1", { store, now: LATEST });
    return { restored, stored: store.read().sessions[0] };
  },
);

await addCase(
  "prunes topology references to missing nodes and sessions on store writes",
  "write-prunes-missing-references",
  (repoRoot) => ({ topology: missingReferencesTopology(repoRoot, NOW) }),
  ({ store }, input) => {
    store.write(input.topology);
    const topology = store.read();
    return {
      sessionIds: ids(topology.sessions),
      edges: topology.edges,
      bindings: topology.bindings,
      exchangeRefIds: ids(topology.exchangeRefs),
    };
  },
);

await addCase(
  "prunes graph and exchange references when saving replacement session topology",
  "save-replacement-prunes",
  (repoRoot) => ({ topology: replacementTopology(repoRoot, NOW), sessions: [{ ...baseSession("keep"), lifecycle: "offline" }] }),
  ({ store, repoRoot }, input) => {
    store.write(input.topology);
    const topology = sessions.saveRuntimeTopologySessions({ store, projectRoot: repoRoot, now: LATER, sessions: input.sessions });
    return {
      sessionIds: ids(topology.sessions),
      bindings: topology.bindings,
      edges: topology.edges,
      exchangeRefs: topology.exchangeRefs,
      firstState: sessions.topologySessionToSessionState(topology.sessions[0], topology),
    };
  },
);

await addCase(
  "preserves service nodes and bindings when saving replacement session topology",
  "save-preserves-services",
  () => ({ service: { id: "service-web", launchCommandLine: "yarn web", tmuxTarget: serviceTarget }, sessions: [{ ...baseSession(), lifecycle: "offline" }] }),
  ({ store, repoRoot }, input) => {
    services.upsertTopologyService(input.service, "running", { store, projectRoot: repoRoot, now: NOW });
    const topology = sessions.saveRuntimeTopologySessions({ store, projectRoot: repoRoot, now: LATER, sessions: input.sessions });
    return { serviceIds: ids(topology.services), nodeIds: ids(topology.nodes), bindings: topology.bindings };
  },
);

await addCase(
  "preserves recoverable sessions while reconciling runtime-owned sessions",
  "reconcile-preserves-offline",
  () => ({
    existing: { ...baseSession("existing-offline", "claude"), lifecycle: "offline", backendSessionId: "backend-existing", restoreBlockedReason: "manual stop" },
    incoming: [{ ...baseSession("incoming-live"), lifecycle: "live" }],
  }),
  ({ store, repoRoot }, input) => {
    sessions.upsertTopologySession(input.existing, "offline", { store, projectRoot: repoRoot, now: NOW });
    const topology = sessions.reconcileRuntimeTopologySessions({ store, projectRoot: repoRoot, now: "2026-05-25T00:01:00.000Z", sessions: input.incoming });
    return { sessionIds: ids(topology.sessions), preserved: state(topology, 0), incoming: state(topology, 1) };
  },
);

await addCase(
  "preserves queued starting sessions while reconciling runtime-owned sessions",
  "reconcile-preserves-starting",
  () => ({
    queued: { id: "queued-start", tool: "sh", toolConfigKey: "sh", command: "sh", args: ["-lc", "sleep 1"], lifecycle: "live" },
    incoming: [{ id: "already-live", tool: "sh", toolConfigKey: "sh", command: "sh", args: [], lifecycle: "live" }],
  }),
  ({ store, repoRoot }, input) => {
    sessions.upsertTopologySession(input.queued, "starting", { store, projectRoot: repoRoot, now: NOW });
    const topology = sessions.reconcileRuntimeTopologySessions({ store, projectRoot: repoRoot, now: "2026-05-25T00:00:01.000Z", sessions: input.incoming });
    return { sessionIds: ids(topology.sessions), queuedStatus: topology.sessions.find((session) => session.id === "queued-start")?.status };
  },
);

await addCase(
  "drops explicitly removed sessions during runtime topology reconciliation",
  "reconcile-drops-removed",
  () => ({ existing: { ...baseSession("removed-offline", "claude"), lifecycle: "offline" }, removedSessionIds: ["removed-offline"], incoming: [] }),
  ({ store, repoRoot }, input) => {
    sessions.upsertTopologySession(input.existing, "offline", { store, projectRoot: repoRoot, now: NOW });
    const topology = sessions.reconcileRuntimeTopologySessions({ store, projectRoot: repoRoot, now: LATER, removedSessionIds: input.removedSessionIds, sessions: input.incoming });
    return { sessions: topology.sessions, nodes: topology.nodes };
  },
);

await addCase(
  "keeps offline restore metadata when runtime reconciliation reports the same session",
  "reconcile-keeps-offline-restore-metadata",
  () => ({
    existing: { ...baseSession("claude-a", "claude"), lifecycle: "offline", backendSessionId: "backend-a", restoreBlockedReason: "startup failed" },
    incoming: [{ ...baseSession("claude-a", "claude"), lifecycle: "offline" }],
  }),
  ({ store, repoRoot }, input) => {
    sessions.upsertTopologySession(input.existing, "offline", { store, projectRoot: repoRoot, now: NOW });
    const topology = sessions.reconcileRuntimeTopologySessions({ store, projectRoot: repoRoot, now: LATER, sessions: input.incoming });
    return { sessionCount: topology.sessions.length, state: state(topology) };
  },
);

await addCase(
  "removes sessions for a worktree and keeps unrelated sessions",
  "remove-worktree-simple",
  (repoRoot) => ({ worktreePath: join(repoRoot, "feature-a"), keepPath: repoRoot }),
  ({ store, repoRoot }, input) => {
    sessions.upsertTopologySession({ id: "codex-a", tool: "codex", command: "codex", args: [], worktreePath: input.worktreePath }, "offline", { store, projectRoot: repoRoot, now: NOW });
    sessions.upsertTopologySession({ id: "codex-b", tool: "codex", command: "codex", args: [], worktreePath: input.keepPath }, "offline", { store, projectRoot: repoRoot, now: LATER });
    const removed = sessions.removeTopologySessionsForWorktree(input.worktreePath, { store, now: LATEST });
    const topology = store.read();
    return { removed, sessionIds: ids(topology.sessions), nodeIds: ids(topology.nodes) };
  },
);

await addCase(
  "removes a single session and its topology references",
  "remove-session-references",
  (repoRoot) => ({ topology: removalTopology(repoRoot, NOW) }),
  ({ store }, input) => {
    store.write(input.topology);
    const removed = sessions.removeTopologySession("drop", { store, now: LATER });
    const topology = store.read();
    return {
      removed,
      sessionIds: ids(topology.sessions),
      nodeIds: ids(topology.nodes),
      edges: topology.edges,
      bindings: topology.bindings,
      teamRoleIds: ids(topology.teamRoles),
      remoteClients: topology.remoteClients,
      lifecycleOperations: topology.lifecycleOperations,
      exchangeRefs: topology.exchangeRefs,
    };
  },
);

await addCase(
  "removes worktree sessions and their topology references",
  "remove-worktree-references",
  (repoRoot) => ({ worktreePath: join(repoRoot, ".aimux", "worktrees", "drop"), topology: worktreeRemovalTopology(repoRoot, NOW) }),
  ({ store }, input) => {
    store.write(input.topology);
    const removed = sessions.removeTopologySessionsForWorktree(input.worktreePath, { store, now: LATER });
    const topology = store.read();
    return {
      removed,
      sessionIds: ids(topology.sessions),
      nodeIds: ids(topology.nodes),
      edges: topology.edges,
      bindings: topology.bindings,
      teamRoleIds: ids(topology.teamRoles),
      remoteClients: topology.remoteClients,
      lifecycleOperations: topology.lifecycleOperations,
      exchangeRefs: topology.exchangeRefs,
    };
  },
);

function missingReferencesTopology(repoRoot, now) {
  return {
    ...storeModule.emptyRuntimeTopology(now),
    rigs: [{ id: "rig-a", name: "repo", projectRoot: repoRoot, createdAt: now, updatedAt: now }],
    nodes: [{ id: "agent:keep", rigId: "rig-a", logicalId: "keep", createdAt: now }],
    edges: [{ id: "edge-drop", rigId: "rig-a", sourceNodeId: "agent:keep", targetNodeId: "agent:missing", kind: "team", createdAt: now }],
    bindings: [{ id: "tmux:drop", nodeId: "agent:missing", updatedAt: now }],
    sessions: [
      { id: "keep", nodeId: "agent:keep", status: "offline", createdAt: now, updatedAt: now },
      { id: "drop", nodeId: "agent:missing", status: "offline", createdAt: now, updatedAt: now },
    ],
    exchangeRefs: [
      { id: "exchange-keep", rigId: "rig-a", kind: "task", exchangeId: "task-keep", sessionId: "keep", createdAt: now, updatedAt: now },
      { id: "exchange-drop", rigId: "rig-a", kind: "task", exchangeId: "task-drop", sessionId: "drop", createdAt: now, updatedAt: now },
    ],
  };
}

function replacementTopology(repoRoot, now) {
  return {
    ...storeModule.emptyRuntimeTopology(now),
    rigs: [{ id: "rig-a", name: "repo", projectRoot: repoRoot, createdAt: now, updatedAt: now }],
    nodes: [
      { id: "agent:keep", rigId: "rig-a", logicalId: "keep", createdAt: now },
      { id: "agent:drop", rigId: "rig-a", logicalId: "drop", createdAt: now },
    ],
    edges: [{ id: "edge-drop", rigId: "rig-a", sourceNodeId: "agent:keep", targetNodeId: "agent:drop", kind: "team", createdAt: now }],
    bindings: [{ id: "tmux:drop", nodeId: "agent:drop", tmuxSession: "aimux-repo", tmuxWindowId: "@9", tmuxWindowIndex: 9, updatedAt: now }],
    sessions: [{ id: "drop", nodeId: "agent:drop", status: "running", tool: "codex", command: "codex", createdAt: now, updatedAt: now }],
    exchangeRefs: [{ id: "exchange-drop", rigId: "rig-a", kind: "task", exchangeId: "task-drop", sessionId: "drop", createdAt: now, updatedAt: now }],
  };
}

function removalTopology(repoRoot, now) {
  return {
    ...storeModule.emptyRuntimeTopology(now),
    rigs: [{ id: "rig-a", name: "repo", projectRoot: repoRoot, createdAt: now, updatedAt: now }],
    nodes: [
      { id: "agent:keep", rigId: "rig-a", logicalId: "keep", createdAt: now },
      { id: "agent:drop", rigId: "rig-a", logicalId: "drop", createdAt: now },
    ],
    edges: [{ id: "edge-drop", rigId: "rig-a", sourceNodeId: "agent:keep", targetNodeId: "agent:drop", kind: "team", createdAt: now }],
    bindings: [{ id: "tmux:drop", nodeId: "agent:drop", updatedAt: now }],
    sessions: [
      { id: "keep", nodeId: "agent:keep", status: "offline", createdAt: now, updatedAt: now },
      { id: "drop", nodeId: "agent:drop", status: "graveyard", createdAt: now, updatedAt: now },
    ],
    teamRoles: [
      { id: "role-keep", rigId: "rig-a", nodeId: "agent:keep", role: "coder", createdAt: now, updatedAt: now },
      { id: "role-drop", rigId: "rig-a", nodeId: "agent:drop", role: "coder", createdAt: now, updatedAt: now },
    ],
    remoteClients: [{ id: "client-1", rigId: "rig-a", status: "online", lastSeenAt: now, ownsSessionIds: ["keep", "drop"] }],
    lifecycleOperations: [{ id: "op-drop", rigId: "rig-a", kind: "agent.stop", status: "pending", targetKind: "session", targetId: "drop", startedAt: now, updatedAt: now }],
    exchangeRefs: [{ id: "exchange-drop", rigId: "rig-a", kind: "task", exchangeId: "task-drop", sessionId: "drop", nodeId: "agent:drop", createdAt: now, updatedAt: now }],
  };
}

function worktreeRemovalTopology(repoRoot, now) {
  const worktreePath = join(repoRoot, ".aimux", "worktrees", "drop");
  return {
    ...removalTopology(repoRoot, now),
    nodes: [
      { id: "agent:keep", rigId: "rig-a", logicalId: "keep", createdAt: now },
      { id: "agent:drop", rigId: "rig-a", logicalId: "drop", cwd: worktreePath, createdAt: now },
    ],
    teamRoles: [
      { id: "role-keep", rigId: "rig-a", nodeId: "agent:keep", role: "coder", createdAt: now, updatedAt: now },
      { id: "role-drop", rigId: "rig-a", nodeId: "agent:drop", parentNodeId: "agent:keep", role: "reviewer", createdAt: now, updatedAt: now },
    ],
  };
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/runtime-core/topology-sessions.test.ts",
  generatedBy: "scripts/capture-runtime-topology-sessions-contract.mjs",
  description: "Runtime topology session lifecycle, reconciliation, and reference-pruning contracts captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
