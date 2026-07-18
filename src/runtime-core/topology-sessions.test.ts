import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initPaths } from "../paths.js";
import { createRuntimeTopologyStore, emptyRuntimeTopology } from "./topology-store.js";
import {
  moveTopologySessionToGraveyard,
  removeTopologySession,
  removeTopologySessionsForWorktree,
  reconcileRuntimeTopologySessions,
  resurrectTopologySession,
  saveRuntimeTopologySessions,
  topologySessionToSessionState,
  upsertTopologySession,
} from "./topology-sessions.js";
import { upsertTopologyService } from "./topology-services.js";

describe("topology session lifecycle", () => {
  let repoRoot = "";
  let topologyPath = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-topology-sessions-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    topologyPath = join(repoRoot, ".aimux", "runtime-topology.yaml");
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("drops tmux bindings when sessions move to graveyard or offline", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    upsertTopologySession(
      {
        id: "codex-1",
        tool: "codex",
        toolConfigKey: "codex",
        command: "codex",
        args: [],
        tmuxTarget: { sessionName: "aimux-repo", windowId: "@1", windowIndex: 1, windowName: "codex" },
      },
      "running",
      { store, projectRoot: repoRoot },
    );

    expect(store.read().bindings).toHaveLength(1);
    const moved = moveTopologySessionToGraveyard("codex-1", { store });
    expect(moved?.status).toBe("graveyard");
    expect(moved?.tmuxTarget).toBeUndefined();
    expect(store.read().bindings).toEqual([]);

    const restored = resurrectTopologySession("codex-1", { store });
    expect(restored?.tmuxTarget).toBeUndefined();
    expect(store.read().bindings).toEqual([]);
  });

  it("records a graveyard reason and clears it on resurrection", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    upsertTopologySession(
      { id: "codex-1", tool: "codex", toolConfigKey: "codex", command: "codex", args: [] },
      "running",
      { store, projectRoot: repoRoot },
    );

    const moved = moveTopologySessionToGraveyard("codex-1", { store, reason: "worktree missing" });
    expect(moved?.graveyardReason).toBe("worktree missing");
    expect(store.read().sessions[0]!.graveyardReason).toBe("worktree missing");

    const restored = resurrectTopologySession("codex-1", { store });
    expect(restored?.status).toBe("offline");
    expect(restored?.graveyardReason).toBeUndefined();
    expect(store.read().sessions[0]!.graveyardReason).toBeUndefined();
  });

  it("removes tmux bindings when an explicit status makes a session non-live", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const session = {
      id: "codex-1",
      tool: "codex",
      toolConfigKey: "codex",
      command: "codex",
      args: [],
      tmuxTarget: { sessionName: "aimux-repo", windowId: "@1", windowIndex: 1, windowName: "codex" },
    };
    upsertTopologySession(session, "running", { store, projectRoot: repoRoot });

    expect(store.read().bindings).toHaveLength(1);

    upsertTopologySession(session, "offline", { store, projectRoot: repoRoot });

    expect(store.read().bindings).toEqual([]);
    expect(topologySessionToSessionState(store.read().sessions[0]!, store.read()).status).toBe("offline");
  });

  it("persists restore blockers only for offline sessions", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const session = {
      id: "claude-crashed",
      tool: "claude",
      toolConfigKey: "claude",
      command: "claude",
      args: [],
      lifecycle: "offline" as const,
      backendSessionId: "backend-1",
      restoreBlockedReason: "agent exited during startup",
    };

    upsertTopologySession(session, "offline", { store, projectRoot: repoRoot });
    expect(topologySessionToSessionState(store.read().sessions[0]!, store.read()).restoreBlockedReason).toBe(
      "agent exited during startup",
    );

    upsertTopologySession(session, "running", { store, projectRoot: repoRoot });
    expect(topologySessionToSessionState(store.read().sessions[0]!, store.read()).restoreBlockedReason).toBeUndefined();
  });

  it("does not mint graveyard sessions from caller-provided seeds", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const moved = moveTopologySessionToGraveyard("missing-agent", { store });

    expect(moved).toBeUndefined();
    expect(store.read().sessions).toEqual([]);
  });

  it("records graveyardedAt when a session moves to graveyard", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    upsertTopologySession(
      {
        id: "codex-1",
        tool: "codex",
        toolConfigKey: "codex",
        command: "codex",
        args: [],
      },
      "offline",
      { store, projectRoot: repoRoot, now: "2026-05-25T00:00:00.000Z" },
    );

    const moved = moveTopologySessionToGraveyard("codex-1", {
      store,
      now: "2026-05-26T00:00:00.000Z",
    });

    expect(moved).toMatchObject({
      id: "codex-1",
      status: "graveyard",
      graveyardedAt: "2026-05-26T00:00:00.000Z",
    });
    expect(store.read().sessions[0]?.graveyardedAt).toBe("2026-05-26T00:00:00.000Z");
  });

  it("keeps the original graveyardedAt while a session remains in graveyard", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    upsertTopologySession(
      {
        id: "codex-1",
        tool: "codex",
        toolConfigKey: "codex",
        command: "codex",
        args: [],
      },
      "offline",
      { store, projectRoot: repoRoot },
    );

    moveTopologySessionToGraveyard("codex-1", {
      store,
      now: "2026-05-26T00:00:00.000Z",
    });
    moveTopologySessionToGraveyard("codex-1", {
      store,
      now: "2026-05-27T00:00:00.000Z",
    });

    expect(store.read().sessions[0]).toMatchObject({
      status: "graveyard",
      updatedAt: "2026-05-27T00:00:00.000Z",
      graveyardedAt: "2026-05-26T00:00:00.000Z",
    });
  });

  it("clears graveyardedAt when a session is resurrected", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    upsertTopologySession(
      {
        id: "codex-1",
        tool: "codex",
        toolConfigKey: "codex",
        command: "codex",
        args: [],
      },
      "offline",
      { store, projectRoot: repoRoot },
    );
    moveTopologySessionToGraveyard("codex-1", {
      store,
      now: "2026-05-26T00:00:00.000Z",
    });

    const restored = resurrectTopologySession("codex-1", {
      store,
      now: "2026-05-27T00:00:00.000Z",
    });

    expect(restored).toMatchObject({ id: "codex-1", status: "offline" });
    expect(restored?.graveyardedAt).toBeUndefined();
    expect(store.read().sessions[0]?.graveyardedAt).toBeUndefined();
  });

  it("prunes topology references to missing nodes and sessions on store writes", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const now = "2026-05-25T00:00:00.000Z";
    store.write({
      ...emptyRuntimeTopology(now),
      rigs: [{ id: "rig-a", name: "repo", projectRoot: repoRoot, createdAt: now, updatedAt: now }],
      nodes: [{ id: "agent:keep", rigId: "rig-a", logicalId: "keep", createdAt: now }],
      edges: [
        {
          id: "edge-drop",
          rigId: "rig-a",
          sourceNodeId: "agent:keep",
          targetNodeId: "agent:missing",
          kind: "team",
          createdAt: now,
        },
      ],
      bindings: [{ id: "tmux:drop", nodeId: "agent:missing", updatedAt: now }],
      sessions: [
        { id: "keep", nodeId: "agent:keep", status: "offline", createdAt: now, updatedAt: now },
        { id: "drop", nodeId: "agent:missing", status: "offline", createdAt: now, updatedAt: now },
      ],
      exchangeRefs: [
        {
          id: "exchange-keep",
          rigId: "rig-a",
          kind: "task",
          exchangeId: "task-keep",
          sessionId: "keep",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "exchange-drop",
          rigId: "rig-a",
          kind: "task",
          exchangeId: "task-drop",
          sessionId: "drop",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const topology = store.read();
    expect(topology.sessions.map((session) => session.id)).toEqual(["keep"]);
    expect(topology.edges).toEqual([]);
    expect(topology.bindings).toEqual([]);
    expect(topology.exchangeRefs.map((ref) => ref.id)).toEqual(["exchange-keep"]);
  });

  it("prunes graph and exchange references when saving replacement session topology", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const now = "2026-05-25T00:00:00.000Z";
    store.write({
      ...emptyRuntimeTopology(now),
      rigs: [{ id: "rig-a", name: "repo", projectRoot: repoRoot, createdAt: now, updatedAt: now }],
      nodes: [
        { id: "agent:keep", rigId: "rig-a", logicalId: "keep", createdAt: now },
        { id: "agent:drop", rigId: "rig-a", logicalId: "drop", createdAt: now },
      ],
      edges: [
        {
          id: "edge-drop",
          rigId: "rig-a",
          sourceNodeId: "agent:keep",
          targetNodeId: "agent:drop",
          kind: "team",
          createdAt: now,
        },
      ],
      bindings: [
        {
          id: "tmux:drop",
          nodeId: "agent:drop",
          tmuxSession: "aimux-repo",
          tmuxWindowId: "@9",
          tmuxWindowIndex: 9,
          updatedAt: now,
        },
      ],
      sessions: [
        {
          id: "drop",
          nodeId: "agent:drop",
          status: "running",
          tool: "codex",
          command: "codex",
          createdAt: now,
          updatedAt: now,
        },
      ],
      exchangeRefs: [
        {
          id: "exchange-drop",
          rigId: "rig-a",
          kind: "task",
          exchangeId: "task-drop",
          sessionId: "drop",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const topology = saveRuntimeTopologySessions({
      store,
      projectRoot: repoRoot,
      now,
      sessions: [
        {
          id: "keep",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          lifecycle: "offline",
        },
      ],
    });

    expect(topology.sessions.map((session) => session.id)).toEqual(["keep"]);
    expect(topology.bindings).toEqual([]);
    expect(topology.edges).toEqual([]);
    expect(topology.exchangeRefs).toEqual([]);
    expect(topologySessionToSessionState(topology.sessions[0], topology).tmuxTarget).toBeUndefined();
  });

  it("preserves service nodes and bindings when saving replacement session topology", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    upsertTopologyService(
      {
        id: "service-web",
        launchCommandLine: "yarn web",
        tmuxTarget: { sessionName: "aimux-repo", windowId: "@2", windowIndex: 2, windowName: "web" },
      },
      "running",
      { store, projectRoot: repoRoot },
    );

    const topology = saveRuntimeTopologySessions({
      store,
      projectRoot: repoRoot,
      sessions: [
        {
          id: "codex-1",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          lifecycle: "offline",
        },
      ],
    });

    expect(topology.services.map((service) => service.id)).toEqual(["service-web"]);
    expect(topology.nodes.map((node) => node.id)).toContain("service:service-web");
    expect(topology.bindings).toMatchObject([{ nodeId: "service:service-web", tmuxWindowId: "@2" }]);
  });

  it("preserves recoverable sessions while reconciling runtime-owned sessions", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const now = "2026-05-25T00:00:00.000Z";
    upsertTopologySession(
      {
        id: "existing-offline",
        tool: "claude",
        toolConfigKey: "claude",
        command: "claude",
        args: [],
        lifecycle: "offline",
        backendSessionId: "backend-existing",
        restoreBlockedReason: "manual stop",
      },
      "offline",
      { store, projectRoot: repoRoot, now },
    );

    const topology = reconcileRuntimeTopologySessions({
      store,
      projectRoot: repoRoot,
      now: "2026-05-25T00:01:00.000Z",
      sessions: [
        {
          id: "incoming-live",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          lifecycle: "live",
        },
      ],
    });

    expect(topology.sessions.map((session) => session.id)).toEqual(["existing-offline", "incoming-live"]);
    const preserved = topologySessionToSessionState(topology.sessions[0]!, topology);
    expect(preserved).toMatchObject({
      id: "existing-offline",
      backendSessionId: "backend-existing",
      restoreBlockedReason: "manual stop",
      lifecycle: "offline",
    });
  });

  it("preserves queued starting sessions while reconciling runtime-owned sessions", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    upsertTopologySession(
      {
        id: "queued-start",
        tool: "sh",
        toolConfigKey: "sh",
        command: "sh",
        args: ["-lc", "sleep 1"],
        lifecycle: "live",
      },
      "starting",
      { store, projectRoot: repoRoot, now: "2026-05-25T00:00:00.000Z" },
    );

    const topology = reconcileRuntimeTopologySessions({
      store,
      projectRoot: repoRoot,
      now: "2026-05-25T00:00:01.000Z",
      sessions: [
        {
          id: "already-live",
          tool: "sh",
          toolConfigKey: "sh",
          command: "sh",
          args: [],
          lifecycle: "live",
        },
      ],
    });

    expect(topology.sessions.map((session) => session.id)).toEqual(["queued-start", "already-live"]);
    expect(topology.sessions.find((session) => session.id === "queued-start")?.status).toBe("starting");
  });

  it("drops explicitly removed sessions during runtime topology reconciliation", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    upsertTopologySession(
      {
        id: "removed-offline",
        tool: "claude",
        toolConfigKey: "claude",
        command: "claude",
        args: [],
        lifecycle: "offline",
      },
      "offline",
      { store, projectRoot: repoRoot },
    );

    const topology = reconcileRuntimeTopologySessions({
      store,
      projectRoot: repoRoot,
      removedSessionIds: ["removed-offline"],
      sessions: [],
    });

    expect(topology.sessions).toEqual([]);
    expect(topology.nodes).toEqual([]);
  });

  it("keeps offline restore metadata when runtime reconciliation reports the same session", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    upsertTopologySession(
      {
        id: "claude-a",
        tool: "claude",
        toolConfigKey: "claude",
        command: "claude",
        args: [],
        lifecycle: "offline",
        backendSessionId: "backend-a",
        restoreBlockedReason: "startup failed",
      },
      "offline",
      { store, projectRoot: repoRoot },
    );

    const topology = reconcileRuntimeTopologySessions({
      store,
      projectRoot: repoRoot,
      sessions: [
        {
          id: "claude-a",
          tool: "claude",
          toolConfigKey: "claude",
          command: "claude",
          args: [],
          lifecycle: "offline",
        },
      ],
    });

    expect(topology.sessions).toHaveLength(1);
    expect(topologySessionToSessionState(topology.sessions[0]!, topology)).toMatchObject({
      id: "claude-a",
      backendSessionId: "backend-a",
      restoreBlockedReason: "startup failed",
      lifecycle: "offline",
    });
  });

  it("removes sessions for a worktree and keeps unrelated sessions", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const worktreePath = join(repoRoot, "feature-a");
    upsertTopologySession({ id: "codex-a", tool: "codex", command: "codex", args: [], worktreePath }, "offline", {
      store,
      projectRoot: repoRoot,
    });
    upsertTopologySession(
      { id: "codex-b", tool: "codex", command: "codex", args: [], worktreePath: repoRoot },
      "offline",
      { store, projectRoot: repoRoot },
    );

    const removed = removeTopologySessionsForWorktree(worktreePath, { store });

    expect(removed.map((session) => session.id)).toEqual(["codex-a"]);
    expect(store.read().sessions.map((session) => session.id)).toEqual(["codex-b"]);
    expect(store.read().nodes.map((node) => node.id)).toEqual(["agent:codex-b"]);
  });

  it("removes a single session and its topology references", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const now = "2026-05-25T00:00:00.000Z";
    store.write({
      ...emptyRuntimeTopology(now),
      rigs: [{ id: "rig-a", name: "repo", projectRoot: repoRoot, createdAt: now, updatedAt: now }],
      nodes: [
        { id: "agent:keep", rigId: "rig-a", logicalId: "keep", createdAt: now },
        { id: "agent:drop", rigId: "rig-a", logicalId: "drop", createdAt: now },
      ],
      edges: [
        {
          id: "edge-drop",
          rigId: "rig-a",
          sourceNodeId: "agent:keep",
          targetNodeId: "agent:drop",
          kind: "team",
          createdAt: now,
        },
      ],
      bindings: [{ id: "tmux:drop", nodeId: "agent:drop", updatedAt: now }],
      sessions: [
        { id: "keep", nodeId: "agent:keep", status: "offline", createdAt: now, updatedAt: now },
        { id: "drop", nodeId: "agent:drop", status: "graveyard", createdAt: now, updatedAt: now },
      ],
      teamRoles: [
        { id: "role-keep", rigId: "rig-a", nodeId: "agent:keep", role: "coder", createdAt: now, updatedAt: now },
        { id: "role-drop", rigId: "rig-a", nodeId: "agent:drop", role: "coder", createdAt: now, updatedAt: now },
      ],
      remoteClients: [
        {
          id: "client-1",
          rigId: "rig-a",
          status: "online",
          lastSeenAt: now,
          ownsSessionIds: ["keep", "drop"],
        },
      ],
      lifecycleOperations: [
        {
          id: "op-drop",
          rigId: "rig-a",
          kind: "agent.stop",
          status: "pending",
          targetKind: "session",
          targetId: "drop",
          startedAt: now,
          updatedAt: now,
        },
      ],
      exchangeRefs: [
        {
          id: "exchange-drop",
          rigId: "rig-a",
          kind: "task",
          exchangeId: "task-drop",
          sessionId: "drop",
          nodeId: "agent:drop",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const removed = removeTopologySession("drop", { store });

    expect(removed?.id).toBe("drop");
    expect(store.read().sessions.map((session) => session.id)).toEqual(["keep"]);
    expect(store.read().nodes.map((node) => node.id)).toEqual(["agent:keep"]);
    expect(store.read().edges).toEqual([]);
    expect(store.read().bindings).toEqual([]);
    expect(store.read().teamRoles.map((role) => role.id)).toEqual(["role-keep"]);
    expect(store.read().remoteClients).toMatchObject([{ id: "client-1", ownsSessionIds: ["keep"] }]);
    expect(store.read().lifecycleOperations).toEqual([]);
    expect(store.read().exchangeRefs).toEqual([]);
  });

  it("removes worktree sessions and their topology references", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const now = "2026-05-25T00:00:00.000Z";
    const worktreePath = join(repoRoot, ".aimux", "worktrees", "drop");
    store.write({
      ...emptyRuntimeTopology(now),
      rigs: [{ id: "rig-a", name: "repo", projectRoot: repoRoot, createdAt: now, updatedAt: now }],
      nodes: [
        { id: "agent:keep", rigId: "rig-a", logicalId: "keep", createdAt: now },
        { id: "agent:drop", rigId: "rig-a", logicalId: "drop", cwd: worktreePath, createdAt: now },
      ],
      edges: [
        {
          id: "edge-drop",
          rigId: "rig-a",
          sourceNodeId: "agent:keep",
          targetNodeId: "agent:drop",
          kind: "team",
          createdAt: now,
        },
      ],
      bindings: [{ id: "tmux:drop", nodeId: "agent:drop", updatedAt: now }],
      sessions: [
        { id: "keep", nodeId: "agent:keep", status: "offline", createdAt: now, updatedAt: now },
        {
          id: "drop",
          nodeId: "agent:drop",
          status: "graveyard",
          createdAt: now,
          updatedAt: now,
        },
      ],
      teamRoles: [
        { id: "role-keep", rigId: "rig-a", nodeId: "agent:keep", role: "coder", createdAt: now, updatedAt: now },
        {
          id: "role-drop",
          rigId: "rig-a",
          nodeId: "agent:drop",
          parentNodeId: "agent:keep",
          role: "reviewer",
          createdAt: now,
          updatedAt: now,
        },
      ],
      remoteClients: [
        {
          id: "client-1",
          rigId: "rig-a",
          status: "online",
          lastSeenAt: now,
          ownsSessionIds: ["keep", "drop"],
        },
      ],
      lifecycleOperations: [
        {
          id: "op-drop",
          rigId: "rig-a",
          kind: "agent.stop",
          status: "pending",
          targetKind: "session",
          targetId: "drop",
          startedAt: now,
          updatedAt: now,
        },
      ],
      exchangeRefs: [
        {
          id: "exchange-drop",
          rigId: "rig-a",
          kind: "task",
          exchangeId: "task-drop",
          sessionId: "drop",
          nodeId: "agent:drop",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const removed = removeTopologySessionsForWorktree(worktreePath, { store });

    expect(removed.map((session) => session.id)).toEqual(["drop"]);
    expect(store.read().sessions.map((session) => session.id)).toEqual(["keep"]);
    expect(store.read().nodes.map((node) => node.id)).toEqual(["agent:keep"]);
    expect(store.read().edges).toEqual([]);
    expect(store.read().bindings).toEqual([]);
    expect(store.read().teamRoles.map((role) => role.id)).toEqual(["role-keep"]);
    expect(store.read().remoteClients).toMatchObject([{ id: "client-1", ownsSessionIds: ["keep"] }]);
    expect(store.read().lifecycleOperations).toEqual([]);
    expect(store.read().exchangeRefs).toEqual([]);
  });
});
