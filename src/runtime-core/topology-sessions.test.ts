import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initPaths } from "../paths.js";
import { createRuntimeTopologyStore, emptyRuntimeTopology } from "./topology-store.js";
import {
  moveTopologySessionToGraveyard,
  removeTopologySessionsForWorktree,
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

  it("does not mint graveyard sessions from caller-provided seeds", () => {
    const store = createRuntimeTopologyStore(topologyPath);
    const moved = moveTopologySessionToGraveyard("missing-agent", { store });

    expect(moved).toBeUndefined();
    expect(store.read().sessions).toEqual([]);
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
});
